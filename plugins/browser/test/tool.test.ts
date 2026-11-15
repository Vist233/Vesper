import type { ToolContext } from "sakura-agent";
import { describe, expect, it } from "vitest";
import { createFakeBrowser } from "../src/fake-backend.ts";
import { checkUrl, createBrowserTool } from "../src/tool.ts";

const pages = {
  "https://shop.test/": { title: "Shop", text: "Welcome", elements: [{ ref: "e1", role: "link", name: "Cart", goto: "https://shop.test/cart" }] },
  "https://shop.test/cart": {
    title: "Cart",
    text: "Your cart is empty",
    elements: [
      { ref: "e1", role: "textbox", name: "Coupon", field: "coupon", submitGoto: "https://shop.test/coupon-ok" },
      { ref: "e2", role: "button", name: "Pay" },
    ],
  },
  "https://shop.test/coupon-ok": { title: "Coupon applied", text: "10% off" },
  "https://shop.test/long": {
    title: "Long",
    text: "x".repeat(7000),
    elements: Array.from({ length: 100 }, (_, i) => ({ ref: `e${i}`, role: "link", name: `link ${i}` })),
  },
};

// Two agents are told apart by their conversation logs.
const agent = (name: string) => ({ log: { name } }) as unknown as ToolContext;
const run = async (tool: ReturnType<typeof createBrowserTool>, context: ToolContext, args: unknown) => {
  const result = await tool.execute(args, context);
  const text = (result.content[0] as { text: string }).text;
  return { text, isError: result.isError === true, json: () => JSON.parse(text) };
};

describe("the browser tool", () => {
  it("opens a page in a tab of the agent, reads it, follows a link and closes the tab", async () => {
    const backend = createFakeBrowser(pages);
    const tool = createBrowserTool({ backend });
    const me = agent("me");
    const opened = (await run(tool, me, { action: "open", url: "https://shop.test/" })).json();
    expect(opened).toMatchObject({ tab: "t1", title: "Shop" });
    const snapshot = (await run(tool, me, { action: "snapshot" })).json(); // tab defaults to the latest of mine
    expect(snapshot).toMatchObject({ text: "Welcome", elements: [{ ref: "e1", name: "Cart" }] });
    expect((await run(tool, me, { action: "click", ref: "e1" })).json()).toMatchObject({ title: "Cart" });
    expect((await run(tool, me, { action: "type", ref: "e1", text: "SAVE10", submit: true })).json()).toMatchObject({ title: "Coupon applied" });
    expect(backend.typed).toEqual({ coupon: "SAVE10" });
    expect((await run(tool, me, { action: "navigate", url: "https://shop.test/" })).json()).toMatchObject({ title: "Shop" });
    expect((await run(tool, me, { action: "press", key: "Enter" })).isError).toBe(false);
    expect((await run(tool, me, { action: "screenshot" })).json()).toEqual({ path: "/fake/screenshots/t1.png" });
    expect((await run(tool, me, { action: "tabs" })).json()).toEqual({ tabs: ["t1"] });
    expect((await run(tool, me, { action: "close" })).text).toBe("Closed.");
    expect((await run(tool, me, { action: "tabs" })).json()).toEqual({ tabs: [] });
    expect(backend.closed).toEqual(["t1"]);
    expect((await run(tool, me, { action: "snapshot" })).text).toContain("no tab yet");
  });

  it("an agent can use only its own tabs: a helper sharing the browser cannot touch the parent's", async () => {
    const tool = createBrowserTool({ backend: createFakeBrowser(pages) });
    const parent = agent("parent");
    const helper = agent("helper");
    const parentTab = (await run(tool, parent, { action: "open", url: "https://shop.test/" })).json().tab;
    for (const action of [
      { action: "snapshot", tab: parentTab },
      { action: "click", tab: parentTab, ref: "e1" },
      { action: "close", tab: parentTab },
      { action: "navigate", tab: parentTab, url: "https://x.test" },
    ]) {
      const refused = await run(tool, helper, action);
      expect(refused, JSON.stringify(action)).toMatchObject({ isError: true, text: expect.stringContaining("belongs to another agent") });
    }
    const helperTab = (await run(tool, helper, { action: "open", url: "https://shop.test/cart" })).json().tab;
    expect(helperTab).not.toBe(parentTab);
    expect((await run(tool, helper, { action: "tabs" })).json()).toEqual({ tabs: [helperTab] });
    expect((await run(tool, parent, { action: "tabs" })).json()).toEqual({ tabs: [parentTab] });
    expect((await run(tool, parent, { action: "snapshot", tab: helperTab })).isError).toBe(true);
    expect((await run(tool, parent, { action: "snapshot", tab: "t99" })).text).toContain("no tab 't99' among yours");
  });

  it("cuts long pages and long element lists and says how much was left out", async () => {
    const tool = createBrowserTool({ backend: createFakeBrowser(pages) });
    const me = agent("me");
    await run(tool, me, { action: "open", url: "https://shop.test/long" });
    const shot = (await run(tool, me, { action: "snapshot" })).json();
    expect(shot.text).toContain("[1000 more characters]");
    expect(shot.elements).toHaveLength(80);
    expect(shot.moreElements).toBe(20);
  });

  it("turns missing arguments and backend errors into messages the agent can act on", async () => {
    const tool = createBrowserTool({ backend: createFakeBrowser(pages) });
    const me = agent("me");
    expect(await run(tool, me, { action: "open" })).toMatchObject({ isError: true, text: expect.stringContaining("'url' is required") });
    await run(tool, me, { action: "open", url: "https://shop.test/cart" });
    for (const [args, part] of [
      [{ action: "navigate" }, "'url' is required"],
      [{ action: "click" }, "'ref' is required"],
      [{ action: "type", ref: "e1" }, "'ref' and 'text' are required"],
      [{ action: "press" }, "'key' is required"],
      [{ action: "click", ref: "nope" }, "no element 'nope'"],
      [{ action: "type", ref: "e2", text: "x" }, "cannot take text"],
      [{ action: "dance" }, "'action' must be one of"],
    ] as const) {
      expect(await run(tool, me, args), JSON.stringify(args)).toMatchObject({ isError: true, text: expect.stringContaining(part) });
    }
    expect(await run(tool, me, null)).toMatchObject({ isError: true });
  });

  it("checks inputs with the rules of the owner's browser tool: http(s) only, no credentials in urls, no option-like values, limits", async () => {
    const tool = createBrowserTool({ backend: createFakeBrowser(pages) });
    const me = agent("me");
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pw@shop.test/", "not a url", `https://shop.test/${"a".repeat(5000)}`]) {
      expect((await run(tool, me, { action: "open", url })).isError, url.slice(0, 40)).toBe(true);
    }
    expect(checkUrl("https://shop.test/ok")).toBeUndefined();
    await run(tool, me, { action: "open", url: "https://shop.test/cart" });
    for (const args of [
      { action: "click", ref: "--help" },
      { action: "press", key: " -x" },
      { action: "read_text", ref: "-e1" },
      { action: "type", ref: "-f", text: "x" },
      { action: "click", ref: "e2", expectText: "-bad" },
      { action: "type", ref: "e1", text: "x".repeat(8001) },
      { action: "navigate", url: "ftp://x.test" },
    ]) {
      expect((await run(tool, me, args)).isError, JSON.stringify(args).slice(0, 60)).toBe(true);
    }
  });

  it("reads one element's text and scrolls, within bounds", async () => {
    const tool = createBrowserTool({ backend: createFakeBrowser(pages) });
    const me = agent("me");
    await run(tool, me, { action: "open", url: "https://shop.test/cart" });
    expect((await run(tool, me, { action: "read_text", ref: "e1" })).json()).toEqual({ text: "Coupon" });
    expect((await run(tool, me, { action: "read_text" })).isError).toBe(true);
    expect((await run(tool, me, { action: "read_text", ref: "zz" })).isError).toBe(true);
    expect((await run(tool, me, { action: "scroll", direction: "down", pixels: 400 })).isError).toBe(false);
    for (const args of [
      { action: "scroll", direction: "sideways", pixels: 1 },
      { action: "scroll", direction: "up", pixels: -1 },
      { action: "scroll", direction: "up", pixels: 9000 },
      { action: "scroll", direction: "up" },
    ]) {
      expect((await run(tool, me, args)).isError, JSON.stringify(args)).toBe(true);
    }
  });

  it("expectText: confirms text on the page after an action, and when it is missing says the action was sent but not confirmed", async () => {
    const tool = createBrowserTool({ backend: createFakeBrowser(pages), confirmWaitMs: 0 });
    const me = agent("me");
    expect((await run(tool, me, { action: "open", url: "https://shop.test/", expectText: "Welcome" })).json()).toMatchObject({ verified: true });
    const missing = await run(tool, me, { action: "click", ref: "e1", expectText: "Thank you" });
    expect(missing.isError).toBeFalsy(); // sent, only not confirmed: the activity must not count it as a failure
    expect(missing.json()).toMatchObject({ ok: true, actionDispatched: true, verified: false });
    expect(missing.json().note).toContain("do not repeat the action blindly");
    expect((await run(tool, me, { action: "snapshot" })).json()).toMatchObject({ title: "Cart" }); // the click did happen
    expect((await run(tool, me, { action: "navigate", url: "https://shop.test/coupon-ok", expectText: "10% off" })).json()).toMatchObject({ verified: true });
    expect((await run(tool, me, { action: "press", key: "Enter", expectText: "10% off" })).json()).toMatchObject({ verified: true });
  });

  it("expectText waits for a page that changes a moment after the action (a slow navigation)", async () => {
    const backend = createFakeBrowser(pages);
    const snapshot = backend.snapshot.bind(backend);
    let calls = 0;
    backend.snapshot = async (tab) => {
      const page = await snapshot(tab);
      calls += 1;
      return calls < 3 ? { ...page, text: "loading" } : page;
    };
    const tool = createBrowserTool({ backend, confirmWaitMs: 3000 });
    const me = agent("me");
    expect((await run(tool, me, { action: "open", url: "https://shop.test/", expectText: "Welcome" })).json()).toMatchObject({ verified: true });
    expect(calls).toBe(3);
  });

  it("is a network tool that is not replayed after a crash", () => {
    const tool = createBrowserTool({ backend: createFakeBrowser(pages) });
    expect(tool).toMatchObject({ name: "browser", effect: "network", replay: "never" });
  });
});

describe("searching with Google", () => {
  it("searches in one tab of the agent, returns the results the page script read, and reuses the tab", async () => {
    const results = [{ title: "Vesper", url: "https://example.test/vesper", snippet: "a box of agents" }];
    const backend = createFakeBrowser({}, { evaluate: (_expression, url) => ({ blocked: url.includes("sorry"), results }) });
    const tool = createBrowserTool({ backend });
    const me = agent("me");
    const first = (await run(tool, me, { action: "search", query: "vesper agents" })).json();
    expect(first).toEqual({ tab: "t1", query: "vesper agents", results });
    expect(backend.evaluated[0]).toContain("a h3");
    expect((await run(tool, me, { action: "search", query: "second" })).json().tab).toBe("t1"); // the same tab
    expect(backend.opened).toEqual(["t1"]);
    expect((await run(tool, me, { action: "snapshot" })).json().url).toBe("https://www.google.com/search?hl=en&q=second");
    expect((await run(tool, me, { action: "search" })).isError).toBe(true);
  });

  it("says when Google asks for a person and does not try to pass it", async () => {
    const backend = createFakeBrowser({}, { evaluate: () => ({ blocked: true, results: [] }) });
    const result = await run(createBrowserTool({ backend }), agent("me"), { action: "search", query: "x" });
    expect(result.isError).toBe(true);
    expect(result.json()).toMatchObject({ blocked: true, note: expect.stringContaining("ask_human") });
  });
});

describe("a tab the browser no longer has", () => {
  it("is dropped and the agent is told to open the page again, instead of failing on the same tab for ever", async () => {
    const backend = createFakeBrowser(pages);
    const tool = createBrowserTool({ backend });
    const me = agent("me");
    await run(tool, me, { action: "open", url: "https://shop.test/" });
    backend.snapshot = async () => {
      throw new Error("no such tab: t1");
    };
    const gone = await run(tool, me, { action: "snapshot" });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("is gone");
    expect(gone.text).toContain("'open'");
    expect((await run(tool, me, { action: "snapshot" })).text).toContain("no tab yet"); // forgotten: the next call starts from open
    expect((await run(tool, me, { action: "open", url: "https://shop.test/" })).isError).toBe(false);
  });
});
