// The browser and computer plugins installed from a marketplace, loaded by the plugin host and used by a session of the runtime
// with the framework's real agent loop, real sub-agents and the real review plugin. Backends are the in-memory fakes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installFromMarketplace, makeWritable, parseMarketplace } from "@vesper/plugin-host";
import { createRig } from "@vesper/session-runtime/testing";
import { reviewPlugin } from "sakura-agent";
import { createFauxClient } from "sakura-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SITE } from "../../plugins/browser/test/contract.ts";
import { createFakeKit } from "../../plugins/computer/test/fake-kit.ts";
import { createFakeWorker } from "../../plugins/browser/test/fake-worker.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Request = { tools: { name: string }[]; messages: { role: string; content: { type: string; text?: string }[] }[] };
const toolNames = (request: Request) => request.tools.map((t) => t.name);
const toolResultTexts = (request: Request) => request.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));
const ALLOW = '{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"ok"}';

function install(...names: string[]) {
  const cache = mkdtempSync(join(tmpdir(), "ogb-plugin-cache-"));
  cleanups.push(() => {
    makeWritable(cache);
    rmSync(cache, { recursive: true, force: true });
  });
  const marketplace = parseMarketplace({ name: "mine", plugins: names.map((name) => ({ name, source: { type: "local", path: `./plugins/${name}` } })) });
  const result = installFromMarketplace({ marketplace, baseDir: repoRoot, cacheDir: cache });
  expect(result.skipped).toEqual([]);
  return result.installed;
}

const call = (name: string, args: unknown) => ({ toolCalls: [{ name: "tool_call", args: { name, args } }] });

describe("browser plugin with a real sub-agent", () => {
  it("a helper started with delegate shares the browser but cannot use the parent's tab", async () => {
    const rig = createRig({
      plugins: install("browser"),
      profiles: { default: "p", profiles: { p: { plugins: ["browser"] } } },
      workspace: { cdpUrl: "fake:browser" },
      script: (request) => {
        const results = toolResultTexts(request as never);
        if (toolNames(request as never).includes("delegate")) {
          if (results.length === 0) return call("browser", { action: "open", url: "https://example.test/" });
          if (results.length === 1) return { toolCalls: [{ name: "delegate", args: { message: "Read the page in tab t1 of the browser." } }] };
          return { text: "all done" };
        }
        if (results.length === 0) return call("browser", { action: "snapshot", tab: "t1" });
        if (results.length === 1) return call("browser", { action: "open", url: "https://example.test/prices" });
        return { text: "I opened my own tab instead" };
      },
    });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "look at the example site");
    await rig.runtime.whenIdle(id);

    const childRequests = rig.faux.requests.filter((r) => !r.tools.some((t) => t.name === "delegate"));
    expect(childRequests.length).toBeGreaterThanOrEqual(2);
    expect(toolResultTexts(childRequests[1] as never)[0]).toContain("belongs to another agent");
    expect(toolResultTexts(childRequests.at(-1) as never).join("")).toContain('\\"tab\\":\\"t2\\"'); // the helper's own tab is a different one
    const finished = (await rig.runtime.read(id)).filter((e) => e.type === "run.finished").map((e) => (e.payload as { reason: string }).reason);
    expect(finished).toEqual(["end"]);
  });

  it("with a loopback DevTools address the plugin drives the owner's worker through the workspace's own run()", async () => {
    const worker = createFakeWorker(SITE);
    const rig = createRig({
      plugins: install("browser"),
      profiles: { default: "p", profiles: { p: { plugins: ["browser"] } } },
      workspace: { cdpUrl: "http://127.0.0.1:9301" },
      script: (request) => {
        const results = toolResultTexts(request as never);
        if (results.length === 0) return call("browser", { action: "open", url: "https://site.test/" });
        if (results.length === 1) return call("browser", { action: "click", ref: "e1", expectText: "10 euros" });
        return { text: "found the price" };
      },
    });
    rig.workspaces.onRun.handler = (c) => worker.run(c.command, c.options);
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "what does the widget cost?");
    await rig.runtime.whenIdle(id);
    const results = (await rig.runtime.read(id)).filter((e) => e.type === "tool.result").map((e) => JSON.stringify(e.payload));
    expect(results[0]).toContain("Home");
    expect(results[1]).toContain('verified\\":true');
    expect(rig.workspaces.runs.length).toBeGreaterThan(2);
    for (const run of rig.workspaces.runs) {
      expect(run.command.slice(0, 2)).toEqual(["sakura-browser-worker", "call"]);
      expect(Object.keys(run.options?.env ?? {}).sort()).toEqual(["BROWSER_TOOL_AGENT_ID", "BROWSER_TOOL_CDP"]);
    }
  });

  it("is not offered without a browser in the workspace", async () => {
    const rig = createRig({
      plugins: install("browser"),
      profiles: { default: "p", profiles: { p: { plugins: ["browser"] } } },
      script: (request) =>
        toolResultTexts(request as never).length === 0 ? { toolCalls: [{ name: "tool_search", args: { query: "browser" } }] } : { text: "none" },
    });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "find a browser tool");
    await rig.runtime.whenIdle(id);
    const events = await rig.runtime.read(id);
    const found = JSON.stringify(events.find((e) => e.type === "tool.result")?.payload);
    expect(found).not.toContain("browser:"); // workspace_info mentions a browser, but there is no `browser` tool to find
  });
});

describe("computer plugin: the agent uses the desktop itself, and a sub-agent can too", () => {
  it("the agent reads the tree, clicks and takes a screenshot with its own desktop tool; every action is reviewed", async () => {
    const reviewed: string[] = [];
    const reviewer = createFauxClient((request) => {
      const last = JSON.stringify(request.messages.at(-1));
      reviewed.push(/tool: (\w+)/.exec(last)?.[1] ?? "?");
      return { text: ALLOW };
    });
    const rig = createRig({
      plugins: install("computer"),
      profiles: { default: "p", profiles: { p: { plugins: ["computer"], alwaysDeclaredTools: ["desktop"] } } },
      workspace: { display: "fake:desktop" },
      runtime: { safetyPlugins: () => [reviewPlugin({ llm: reviewer })] },
      script: (request) =>
        [
          { toolCalls: [{ name: "desktop", args: { action: "tree" } }] },
          { toolCalls: [{ name: "desktop", args: { action: "click", ref: "w1" } }] },
          { toolCalls: [{ name: "desktop", args: { action: "screenshot" } }] },
          { text: "Pressed Save; the dialog closed." },
        ][toolResultTexts(request as never).length] ?? { text: "done" },
    });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "save the document");
    await rig.runtime.whenIdle(id);
    expect(toolNames(rig.faux.requests[0] as never)).toContain("desktop"); // declared to the agent itself
    expect(JSON.stringify(rig.faux.requests.at(-1)?.messages)).toContain("w1 button"); // it saw the tree
    expect(reviewed.filter((name) => name === "desktop")).toHaveLength(3);
  });

  it("a large desktop job goes to a sub-agent with delegate, which has the desktop tool too", async () => {
    const rig = createRig({
      plugins: install("computer"),
      profiles: { default: "p", profiles: { p: { plugins: ["computer"], alwaysDeclaredTools: ["desktop"] } } },
      workspace: { display: "fake:desktop" },
      script: (request) => {
        const results = toolResultTexts(request as never);
        const isParent = request.tools.some((t) => t.name === "delegate");
        if (!isParent)
          return results.length === 0 ? { toolCalls: [{ name: "desktop", args: { action: "click", ref: "w1" } }] } : { text: "Clicked Save in the dialog." };
        return results.length === 0 ? { toolCalls: [{ name: "delegate", args: { message: "Click Save in the open dialog and report." } }] } : { text: "saved" };
      },
    });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "save the document");
    await rig.runtime.whenIdle(id);
    const child = rig.faux.requests.find((r) => !r.tools.some((t) => t.name === "delegate"));
    expect(child?.tools.map((t) => t.name)).toContain("desktop"); // the sub-agent inherited the desktop tool
    expect(JSON.stringify(rig.faux.requests.at(-1)?.messages)).toContain("Clicked Save"); // its report came back
  });

  it("with a real display name the desktop tool drives the owner's gui kit through the workspace's run()", async () => {
    const kit = createFakeKit();
    const rig = createRig({
      plugins: install("computer"),
      profiles: { default: "p", profiles: { p: { plugins: ["computer"], alwaysDeclaredTools: ["desktop"] } } },
      workspace: { display: ":101" },
      script: (request) =>
        [
          { toolCalls: [{ name: "desktop", args: { action: "tree" } }] },
          { toolCalls: [{ name: "desktop", args: { action: "click", ref: "w1" } }] },
          { text: "Clicked Save." },
        ][toolResultTexts(request as never).length] ?? { text: "done" },
    });
    rig.workspaces.onRun.handler = (c) => kit.run(c.command, c.options);
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "click save");
    await rig.runtime.whenIdle(id);
    expect(kit.actions).toEqual(["click w1"]);
    expect(kit.commands.map((c) => c.command[1]?.split("/").pop())).toEqual(["observe.py", "act.py"]);
  });
});
