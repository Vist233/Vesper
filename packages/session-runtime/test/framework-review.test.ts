// Question for T5 (docs/07 section 6, "risk to test first"): when the model calls an inner tool through the framework's
// `tool_call`, what does the framework's review plugin see? This test runs the real review plugin with a scripted reviewer
// and records what the reviewer is asked. It documents the framework's behaviour; it does not change it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, reviewPlugin } from "sakura-agent";
import { createFauxClient } from "sakura-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ALLOW = '{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"scripted"}';

async function runWith(callArgs: unknown) {
  const cwd = mkdtempSync(join(tmpdir(), "ogb-review-"));
  dirs.push(cwd);
  const reviewer = createFauxClient(() => ({ text: ALLOW }));
  const model = createFauxClient((_request, index) => (index === 0 ? { toolCalls: [{ name: "tool_call", args: callArgs }] } : { text: "done" }));
  const agent = await createAgent({
    model,
    cwd,
    plugins: [reviewPlugin({ llm: reviewer })],
    mcp: { servers: { probe: { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "mcp-probe.mjs")] } }, expose: "search" },
  });
  const events: { type: string; [key: string]: unknown }[] = [];
  const run = agent.run("probe the secrets file");
  for await (const event of run.events) events.push(event as never);
  await run.result;
  await agent.close();
  return { reviewer, model, events };
}

describe("what the framework's review plugin sees of a tool_call (framework tool_search/tool_call over MCP)", () => {
  it("is asked about the call to `tool_call`, and its request text contains the inner tool's name and arguments", async () => {
    const { reviewer, model, events } = await runWith({ name: "mcp__probe__probe", args: { target: "secrets.txt" } });
    const declared = model.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(declared).toEqual(expect.arrayContaining(["bash", "read", "tool_call", "tool_search"])); // the original tools plus search ...
    expect(declared).not.toContain("mcp__probe__probe"); // ... and the catalog tool is not declared
    expect(reviewer.requests.length).toBeGreaterThanOrEqual(1);
    const asked = JSON.stringify(reviewer.requests.at(-1)?.messages);
    expect(asked).toContain("tool_call"); // the reviewed call is the OUTER one ...
    expect(asked).toContain("mcp__probe__probe"); // ... and the inner name
    expect(asked).toContain("secrets.txt"); // ... and the inner arguments are visible only as text inside the outer call's arguments
    console.log("REVIEWER SAW:", asked.slice(-700));
    expect(events.some((e) => e.type === "tool_end")).toBe(true);
  });

  it("records the review under the tool name `tool_call`, not under the inner tool, in the conversation log", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ogb-review-"));
    dirs.push(cwd);
    const reviewer = createFauxClient(() => ({ text: ALLOW }));
    const model = createFauxClient((_r, index) =>
      index === 0 ? { toolCalls: [{ name: "tool_call", args: { name: "mcp__probe__probe", args: { target: "x" } } }] } : { text: "done" },
    );
    const agent = await createAgent({
      model,
      cwd,
      plugins: [reviewPlugin({ llm: reviewer })],
      mcp: { servers: { probe: { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "mcp-probe.mjs")] } }, expose: "search" },
    });
    const run = agent.run("go");
    for await (const _event of run.events) {
      // drain
    }
    await run.result;
    const records = (await agent.log.branch())
      .filter((e) => e.type === "custom" && e.customType === "review")
      .map((e) => (e as { data: { tool: string } }).data.tool);
    await agent.close();
    expect(records).toEqual(["tool_call"]);
  });

  it("an unknown inner name is an error from tool_call itself, after the review has allowed the outer call", async () => {
    const { model } = await runWith({ name: "no_such_tool", args: {} });
    const results = model.requests[1]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(JSON.stringify(results)).toContain("There is no tool named 'no_such_tool'");
  });
});
