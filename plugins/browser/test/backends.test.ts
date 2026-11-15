import { describe, expect, it } from "vitest";
import { createFakeBrowser } from "../src/fake-backend.ts";
import { createWorkerBackend, parseSnapshot, parseTabs } from "../src/worker-backend.ts";
import { browserBackendContract, SITE } from "./contract.ts";
import { createFakeWorker } from "./fake-worker.ts";

browserBackendContract("in-memory fake", async () => ({ backend: createFakeBrowser(SITE), cleanup: async () => {} }));

browserBackendContract("the owner's worker (over a fake worker)", async () => {
  const worker = createFakeWorker(SITE);
  return { backend: createWorkerBackend({ run: worker.run, agentId: "agent-a", cdpUrl: "http://127.0.0.1:9301/" }), cleanup: async () => {} };
});

describe("the worker adapter", () => {
  const make = (options: Partial<Parameters<typeof createWorkerBackend>[0]> = {}) => {
    const worker = createFakeWorker(SITE);
    return { worker, backend: createWorkerBackend({ run: worker.run, agentId: "agent-a", cdpUrl: "http://127.0.0.1:9301/", ...options }) };
  };

  it("gives the worker its agent id and DevTools address through the environment of the call, and nothing else", async () => {
    const { worker, backend } = make();
    await backend.open("https://site.test/");
    expect(worker.calls.length).toBeGreaterThan(0);
    for (const call of worker.calls) expect(call.env).toEqual({ BROWSER_TOOL_AGENT_ID: "agent-a", BROWSER_TOOL_CDP: "http://127.0.0.1:9301/" });
  });

  it("switches to its own tab before acting, because the worker has one current tab", async () => {
    const { worker, backend } = make();
    const a = await backend.open("https://site.test/");
    const b = await backend.open("https://site.test/form");
    await backend.snapshot(a.tab);
    await backend.snapshot(b.tab);
    await backend.snapshot(b.tab);
    expect(worker.calls.filter((c) => c.action === "switch_tab")).toHaveLength(2); // a, then b; the second snapshot of b needs none
  });

  it("passes our refs as the worker's @targets and scrolls by direction and pixels", async () => {
    const { worker, backend } = make();
    const { tab } = await backend.open("https://site.test/");
    await backend.scroll(tab, "up", 120);
    expect(worker.scrolled).toEqual(["up:120"]);
    expect(await backend.readText(tab, "e1")).toBe("Prices");
  });

  it("turns a failure reported by the worker into an error, and bad replies into clear errors", async () => {
    const { backend } = make();
    const { tab } = await backend.open("https://site.test/");
    await expect(backend.click(tab, "e42")).rejects.toThrow(/element @e42 not found/);
    const run = async (stdout: string, extra: Record<string, unknown> = {}) => ({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      truncated: false,
      ...extra,
    });
    const base = { agentId: "agent-a", cdpUrl: "http://127.0.0.1:9301/" };
    await expect(createWorkerBackend({ ...base, run: () => run("not json") }).open("https://x.test/")).rejects.toThrow(/did not answer with JSON/);
    await expect(createWorkerBackend({ ...base, run: () => run("", { timedOut: true }) }).open("https://x.test/")).rejects.toThrow(/timed out/);
    await expect(
      createWorkerBackend({ ...base, run: () => run(JSON.stringify({ agentId: "someone-else", ok: true, data: {} })) }).open("https://x.test/"),
    ).rejects.toThrow(/another agent/);
    await expect(
      createWorkerBackend({ ...base, run: () => run(JSON.stringify({ agentId: "agent-a", ok: true, data: { tabs: [] } })) }).open("https://x.test/"),
    ).rejects.toThrow(/did not report the new tab/);
  });

  it("closing lets go of the tab but leaves it in the browser, because the worker cannot close tabs", async () => {
    const { worker, backend } = make();
    const { tab } = await backend.open("https://site.test/");
    await backend.close(tab);
    expect(worker.tabs).toHaveLength(1);
    expect(worker.calls.map((c) => c.action)).not.toContain("close_tab");
  });
});

describe("parsing what agent-browser prints (assumptions, in one place)", () => {
  it("reads tabs from a list, or from an object holding one, with several id spellings", () => {
    expect(parseTabs([{ tabId: "t1", url: "u", title: "T" }])).toEqual([{ id: "t1", url: "u", title: "T" }]);
    expect(parseTabs({ tabs: [{ id: 2, url: "u" }, "junk", null] })).toEqual([{ id: "2", url: "u", title: "" }]);
    expect(parseTabs({ targets: [{ targetId: "abc" }] })).toEqual([{ id: "abc", url: "", title: "" }]);
    expect(parseTabs({ pages: [{ id: "p" }] })).toHaveLength(1);
    expect(parseTabs("nothing")).toEqual([]);
    expect(parseTabs(null)).toEqual([]);
  });

  it("reads elements from snapshot lines, from a refs map, and tolerates plain text", () => {
    expect(parseSnapshot({ snapshot: '- link "Cart" [ref=e1]\n- button "Pay" [ref=e2]' }).elements).toEqual([
      { ref: "e1", role: "link", name: "Cart" },
      { ref: "e2", role: "button", name: "Pay" },
    ]);
    expect(parseSnapshot('textbox "Name" @e7').elements).toEqual([{ ref: "e7", role: "textbox", name: "Name" }]);
    expect(parseSnapshot({ text: "t", refs: { "@e1": { role: "link", name: "A" }, e2: {} } })).toEqual({
      text: "t",
      elements: [
        { ref: "e1", role: "link", name: "A" },
        { ref: "e2", role: "", name: "" },
      ],
    });
    expect(parseSnapshot("just words").elements).toEqual([]);
    expect(parseSnapshot(undefined).text).toBe("null");
  });
});
