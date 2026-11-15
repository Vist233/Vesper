import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRig, lastUserText, loadPlugins } from "../src/testing/index.ts";
import { gatedPlugin, installGate, userTexts } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runUntilReady(root: string, pluginRoot: string): Promise<{ id: string; kill(): Promise<void> }> {
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "crash-child.ts"), root, pluginRoot], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not become ready: ${errors}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = /READY (\S+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        resolve({
          id: match[1],
          kill: async () => {
            child.kill("SIGKILL");
            await exited;
          },
        });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early (${code}): ${errors}`));
    });
  });
}

describe("a crash in the middle of a run (the process is killed with SIGKILL)", () => {
  it("resumes the run from the session file, delivers the unread signal exactly once, and keeps the journal whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-crash-"));
    const pluginRoot = mkdtempSync(join(tmpdir(), "ogb-crash-plugin-"));
    dirs.push(root, pluginRoot);

    const child = await runUntilReady(root, pluginRoot);
    await child.kill();

    installGate().open();
    const rig = createRig({
      root,
      plugins: loadPlugins(gatedPlugin(pluginRoot)),
      profiles: { default: "p", profiles: { p: { plugins: ["demo"], alwaysDeclaredTools: ["gated"] } } },
      script: (request) => ({ text: `recovered after: ${lastUserText(request).slice(0, 40)}` }),
    });
    const result = await rig.runtime.resumeAll();
    expect(result).toEqual({ opened: [child.id], failed: [] });
    await rig.runtime.whenIdle(child.id);
    await rig.runtime.whenIdle(child.id);

    // The model sees the whole story once: the request, the tool call the crash cut short (answered as interrupted), and the mail.
    const request = rig.faux.requests.at(-1);
    const texts = userTexts(request as never);
    expect(texts.filter((t) => t === "start work")).toHaveLength(1);
    expect(texts.filter((t) => t.includes("mail during crash"))).toHaveLength(1);
    const toolMessages = (request?.messages ?? []).filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(JSON.stringify(toolMessages[0])).toMatch(/interrupted/i);

    // The journal is whole and the router is quiet; the mail was settled once.
    const events = await rig.runtime.read(child.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const inputs = events.filter((e) => e.type === "router.input").map((e) => e.payload as { type: string; draft?: { id: string }; deliveryId?: string });
    expect(inputs.filter((i) => i.type === "signal" && i.draft?.id === "mail-1")).toHaveLength(1);
    expect(await rig.runtime.status(child.id)).toMatchObject({ run: "idle", held: false, queued: 0 });

    // The agent's own session file has the person's message exactly once.
    const sessionFile = readFileSync(join(root, "sessions", child.id, "agent.jsonl"), "utf8");
    expect(sessionFile.split("start work").length - 1).toBe(1);
    expect(sessionFile.split("mail during crash").length - 1).toBe(1);

    // And the person can go on talking.
    await rig.runtime.send(child.id, "thanks");
    await rig.runtime.whenIdle(child.id);
    expect(userTexts(rig.faux.requests.at(-1) as never).at(-1)).toBe("thanks");
    await rig.cleanup();
  }, 40_000);
});
