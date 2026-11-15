import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "sakura-agent";
import { afterEach, describe, expect, it } from "vitest";
import { JournalMapper } from "../src/events.ts";
import { createRig, lastUserText, type Rig } from "../src/testing/index.ts";
import { userTexts } from "./helpers.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

describe("recovery when the journal is behind the conversation", () => {
  it("does not deliver again a message the framework already wrote before the crash", async () => {
    const first = createRig({ script: (request) => ({ text: `echo ${lastUserText(request)}` }) });
    rigs.push(first);
    const { id } = await first.runtime.createSession();
    await first.runtime.send(id, "only once", "m1");
    await first.runtime.whenIdle(id);
    await first.runtime.close();

    // Make the journal look like the process died right after the framework wrote the message but before `run-started` was recorded.
    const file = join(first.root, "sessions", id, "journal", `${id}.jsonl`);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const firstSignalLine = lines.findIndex((l) => JSON.parse(l).type === "router.input");
    const keep = lines.slice(0, firstSignalLine + 1);
    writeFileSync(file, `${keep.join("\n")}\n`);

    const second = createRig({ root: first.root, script: (request) => ({ text: `second ${lastUserText(request)}` }) });
    rigs.push(second);
    await second.runtime.resumeAll();
    await second.runtime.whenIdle(id);
    const seen = second.faux.requests.flatMap((r) => userTexts(r as never));
    expect(seen.filter((t) => t === "only once").length).toBeLessThanOrEqual(1); // never a second copy of the message
    expect(await second.runtime.status(id)).toMatchObject({ run: "idle", held: false, queued: 0 });
    const entries = readFileSync(join(first.root, "sessions", id, "agent.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const userCopies = entries.filter((e) => e.message?.role === "user" && JSON.stringify(e.message.content).includes("only once"));
    expect(userCopies).toHaveLength(1);
  });

  it("delivers a message again when the framework never got it", async () => {
    const first = createRig({ script: [{ text: "x" }] });
    rigs.push(first);
    const { id } = await first.runtime.createSession();
    await first.runtime.close();
    // A journal that holds the person's message as an unsettled start, with nothing of it in the conversation.
    const file = join(first.root, "sessions", id, "journal", `${id}.jsonl`);
    mkdirSync(join(first.root, "sessions", id, "journal"), { recursive: true });
    const input = { type: "signal", sessionId: id, at: 1, draft: { id: "lost", source: "user", text: "never reached the agent" } };
    writeFileSync(file, `${JSON.stringify({ v: 1, seq: 1, at: 1, sessionId: id, type: "router.input", payload: input })}\n`);

    const second = createRig({ root: first.root, script: (request) => ({ text: `got ${lastUserText(request)}` }) });
    rigs.push(second);
    await second.runtime.resumeAll();
    await second.runtime.whenIdle(id);
    await second.runtime.whenIdle(id);
    expect(userTexts(second.faux.requests[0] as never).filter((t) => t === "never reached the agent")).toHaveLength(1);
  });
});

describe("how framework events become journal events", () => {
  const message = (role: "user" | "assistant") => ({ role, content: [{ type: "text" as const, text: "t" }], ts: 1 });
  it.each([
    [{ type: "run_start" }, "run.started"],
    [{ type: "message_end", message: message("user") }, "message.user"],
    [{ type: "message_end", message: message("assistant") }, "message.assistant"],
    [{ type: "tool_start", call: { id: "1", name: "x", args: {} } }, "tool.call"],
    [{ type: "tool_end", call: { id: "1", name: "x", args: {} }, result: { content: [] } }, "tool.result"],
    [{ type: "paused", reason: "approval" }, "agent.paused"],
    [{ type: "compaction", tokensBefore: 5 }, "agent.compaction"],
    [{ type: "goal", status: "active" }, "agent.goal"],
    [{ type: "signal", text: "s" }, "agent.signal"],
    [{ type: "plugin", name: "review", data: { a: 1 } }, "agent.plugin.review"],
  ] as [Event, string][])("%j -> %s", (event, type) => {
    expect(new JournalMapper().map(event).at(-1)?.type).toBe(type);
  });

  it("does not keep streaming pieces", () => {
    for (const event of [
      { type: "turn_start" },
      { type: "turn_end" },
      { type: "message_update", delta: { type: "text", text: "x" } },
      { type: "reasoning_update", delta: "x" },
      { type: "message_reset" },
      { type: "run_end", reason: "done" }, // run.finished is written by the actor, from the run's result
    ] as Event[]) {
      expect(new JournalMapper().map(event)).toEqual([]);
    }
  });
});
