import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "sakura-agent";
import { describe, expect, it } from "vitest";
import { type WebSocketLike, createCdpEvaluator } from "../src/cdp.ts";
import { checkScript, fillScript, scriptResult } from "../src/dom-scripts.ts";
import { createFakeBrowser } from "../src/fake-backend.ts";
import { createBrowserTool, MAX_VALUE } from "../src/tool.ts";
import { createWorkerBackend } from "../src/worker-backend.ts";
import { SITE } from "./contract.ts";
import { createFakeWorker } from "./fake-worker.ts";

const pages = {
  "https://site.test/login": {
    title: "Login",
    text: "Sign in",
    elements: [
      { ref: "e1", role: "textbox", name: "Email", field: "email", selector: "#email", submitSelector: "button" },
      { ref: "e2", role: "textbox", name: "Password", field: "password", selector: "#pw", ignoresValue: true },
      { ref: "e3", role: "checkbox", name: "Agree", selector: "#agree", checkbox: { checked: false } },
      { ref: "e4", role: "checkbox", name: "Agreed", selector: "#done", checkbox: { checked: true } },
      { ref: "e5", role: "checkbox", name: "Broken", selector: "#stuck", checkbox: { checked: false, stuck: true } },
      { ref: "e6", role: "button", name: "Go", selector: "button" },
    ],
  },
};
const me = { log: { name: "me" } } as unknown as ToolContext;
async function setup(evaluate?: (expression: string, url: string) => never) {
  const backend = createFakeBrowser(pages, evaluate ? { evaluate } : {});
  const tool = createBrowserTool({ backend });
  const run = async (args: unknown) => {
    const result = await tool.execute(args, me);
    const text = (result.content[0] as { text: string }).text;
    return { text, isError: result.isError === true, json: () => JSON.parse(text) };
  };
  await run({ action: "open", url: "https://site.test/login" });
  return { backend, run };
}

describe("evaluate", () => {
  it("returns the value as JSON, null for nothing, and passes awaitPromise on", async () => {
    const seen: string[] = [];
    const { run } = await setup(((expression: string) => (seen.push(expression), expression === "void 0" ? undefined : { hits: 3 })) as never);
    expect((await run({ action: "evaluate", expression: "document.querySelectorAll('a').length" })).json()).toEqual({ ok: true, value: { hits: 3 } });
    expect((await run({ action: "evaluate", expression: "void 0" })).json()).toEqual({ ok: true, value: null });
    expect(seen).toHaveLength(2);
  });

  it("refuses a missing, empty or too long expression", async () => {
    const { run, backend } = await setup((() => 1) as never);
    for (const args of [{ action: "evaluate" }, { action: "evaluate", expression: "" }, { action: "evaluate", expression: "x".repeat(4001) }]) {
      const reply = await run(args);
      expect(reply.isError).toBe(true);
    }
    expect(backend.evaluated).toEqual([]);
    expect((await run({ action: "evaluate", expression: "x".repeat(4000) })).isError).toBe(false); // the limit itself is allowed
  });

  it("cuts a long value at 8 KB and says so", async () => {
    const { run } = await setup((() => "y".repeat(20_000)) as never);
    const reply = (await run({ action: "evaluate", expression: "big" })).json();
    expect(reply).toMatchObject({ ok: true, truncated: true });
    expect(reply.value.length).toBe(MAX_VALUE);
    expect(reply.bytes).toBeGreaterThan(MAX_VALUE);
  });

  it("returns the page's own error text as an error", async () => {
    const { run } = await setup((() => {
      throw new Error("the expression threw: ReferenceError: nope is not defined");
    }) as never);
    const reply = await run({ action: "evaluate", expression: "nope" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("nope is not defined");
  });
});

describe("fill", () => {
  it("fills a field, reads it back and says whether the submit button is enabled", async () => {
    const { run, backend } = await setup();
    expect((await run({ action: "fill", target: "#email", text: "a@b.test" })).json()).toEqual({ ok: true, matched: 1, length: 8, submitEnabled: true });
    expect(backend.typed.email).toBe("a@b.test");
  });

  it("fails when the field does not keep the value, and never echoes the text", async () => {
    const { run } = await setup();
    const reply = await run({ action: "fill", target: "#pw", text: "hunter2-secret" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("did not keep the value");
    expect(reply.text).not.toContain("hunter2");
  });

  it("wants a CSS selector and a text, and says what is wrong", async () => {
    const { run } = await setup();
    expect((await run({ action: "fill", target: "e1", text: "x" })).text).toContain("CSS selector");
    expect((await run({ action: "fill", text: "x" })).isError).toBe(true);
    expect((await run({ action: "fill", target: "#email" })).isError).toBe(true);
    expect((await run({ action: "fill", target: "#nothing", text: "x" })).text).toContain("no element matches");
  });
});

describe("check", () => {
  it("ticks a box and verifies it; a box that is already ticked is left alone", async () => {
    const { run } = await setup();
    expect((await run({ action: "check", target: "#agree" })).json()).toEqual({ ok: true, checked: true, clicked: true });
    expect((await run({ action: "check", target: "#done" })).json()).toEqual({ ok: true, checked: true, clicked: false });
  });

  it("fails when the box is still not checked, and when the element is not a box", async () => {
    const { run } = await setup();
    const stuck = await run({ action: "check", target: "#stuck" });
    expect(stuck.isError).toBe(true);
    expect(stuck.text).toContain("still not checked");
    expect((await run({ action: "check", target: "#email" })).text).toContain("not a checkbox");
    expect((await run({ action: "check", target: "e3" })).text).toContain("CSS selector");
  });
});

describe("the page scripts", () => {
  it("are valid JavaScript and carry the selector and text only as quoted data", () => {
    const hostile = `a"]; alert(1); //`;
    for (const script of [fillScript(hostile, `it's "x"\n`), checkScript(hostile)]) {
      expect(() => new Function(`return ${script}`)).not.toThrow();
      expect(script).toContain(JSON.stringify(hostile));
    }
  });

  it("read a failure the page reported as an Error", () => {
    expect(() => scriptResult({ ok: false, error: "no element matches #x" })).toThrow("no element matches #x");
    expect(() => scriptResult(null)).toThrow();
    expect(scriptResult<{ checked: boolean }>({ ok: true, checked: true }).checked).toBe(true);
  });
});

describe("the DevTools evaluator", () => {
  const targets = [
    { id: "A".repeat(32), type: "page", url: "https://a.test/", title: "A", webSocketDebuggerUrl: "ws://127.0.0.1:9/a" },
    { id: "B".repeat(32), type: "page", url: "https://b.test/", title: "B", webSocketDebuggerUrl: "ws://127.0.0.1:9/b" },
    { id: "W".repeat(32), type: "service_worker", url: "https://b.test/sw.js", title: "", webSocketDebuggerUrl: "ws://127.0.0.1:9/w" },
  ];
  const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => targets })) as unknown as typeof fetch;

  /** A fake socket that answers Runtime.evaluate with `answer`, and remembers where it connected. */
  function fakeSockets(answer: (params: { expression: string }) => unknown, silent = false) {
    const urls: string[] = [];
    class Fake implements WebSocketLike {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        urls.push(url);
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        const { id, method, params } = JSON.parse(data);
        expect(method).toBe("Runtime.evaluate");
        expect(params).toMatchObject({ returnByValue: true, userGesture: false });
        if (!silent) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result: answer(params) }) }));
      }
      close() {}
    }
    return { Impl: Fake, urls };
  }

  it("accepts only a loopback address", () => {
    expect(() => createCdpEvaluator({ cdpUrl: "http://example.com:9222" })).toThrow(/127\.0\.0\.1/);
    expect(() => createCdpEvaluator({ cdpUrl: "http://127.0.0.1:9222/" })).not.toThrow();
  });

  it("finds the page by target id, or by url and title, and returns the value", async () => {
    const sockets = fakeSockets(() => ({ result: { type: "number", value: 7 } }));
    const cdp = createCdpEvaluator({ cdpUrl: "http://127.0.0.1:9222/", fetchImpl, WebSocketImpl: sockets.Impl });
    expect(await cdp.evaluate({ id: "B".repeat(32), url: "x", title: "x" }, { expression: "1+6", awaitPromise: false })).toBe(7);
    expect(await cdp.evaluate({ url: "https://a.test/", title: "A" }, { expression: "1", awaitPromise: false })).toBe(7);
    expect(sockets.urls).toEqual(["ws://127.0.0.1:9/b", "ws://127.0.0.1:9/a"]);
  });

  it("says when the page is not there, and passes on what the page threw", async () => {
    const sockets = fakeSockets(() => ({ exceptionDetails: { exception: { description: "ReferenceError: x is not defined\n   at <anonymous>:1:1" } } }));
    const cdp = createCdpEvaluator({ cdpUrl: "http://127.0.0.1:9222/", fetchImpl, WebSocketImpl: sockets.Impl });
    await expect(cdp.evaluate({ url: "https://gone.test/", title: "" }, { expression: "1", awaitPromise: false })).rejects.toThrow(
      /no page at https:\/\/gone\.test\//,
    );
    await expect(cdp.evaluate({ url: "https://a.test/", title: "A" }, { expression: "x", awaitPromise: false })).rejects.toThrow(
      "the expression threw: ReferenceError: x is not defined",
    );
  });

  it("gives up when the page does not answer", async () => {
    const sockets = fakeSockets(() => ({}), true);
    const cdp = createCdpEvaluator({ cdpUrl: "http://127.0.0.1:9222/", fetchImpl, WebSocketImpl: sockets.Impl, timeoutMs: 20 });
    await expect(cdp.evaluate({ url: "https://a.test/", title: "A" }, { expression: "1", awaitPromise: true })).rejects.toThrow(/did not answer/);
  });
});

describe("the worker backend's DOM actions", () => {
  it("evaluates in the page of the focused tab through the DevTools evaluator, and fill and check use the same path", async () => {
    const worker = createFakeWorker(SITE);
    const calls: { page: unknown; expression: string }[] = [];
    const replies: unknown[] = [{ ok: true, matched: 1, length: 3, equal: true, submitEnabled: false }, { ok: true, checked: true, clicked: true }, 42];
    const backend = createWorkerBackend({
      run: worker.run,
      agentId: "agent-a",
      cdpUrl: "http://127.0.0.1:9301/",
      cdp: { evaluate: async (page, params) => (calls.push({ page, expression: params.expression }), replies.shift() as never) },
    });
    const { tab } = await backend.open("https://site.test/");
    expect(await backend.fill(tab, "#q", "abc")).toMatchObject({ equal: true, submitEnabled: false });
    expect(await backend.check(tab, "#agree")).toEqual({ ok: true, checked: true, clicked: true });
    expect(await backend.evaluate(tab, "6*7", false)).toBe(42);
    expect(calls[0]?.page).toMatchObject({ url: "https://site.test/" });
    expect(calls[0]?.expression).toContain('"#q"');
    expect(calls[2]?.expression).toBe("6*7");
  });
});

describe("the prompt", () => {
  const prompt = readFileSync(join(import.meta.dirname, "..", "prompt.md"), "utf8");
  it("is short and holds the playbook's rules", () => {
    expect(prompt.split("\n").length).toBeLessThanOrEqual(40);
    for (const rule of [
      "Judge by the DOM",
      "never success",
      "Five steps",
      "agreement checkbox",
      "`check`",
      "`fill`",
      "Assigning `el.value = x` does nothing",
      "Wait for a condition, never sleep",
      "awaitPromise",
      "200 against 401",
      "HttpOnly",
      "Do not guess",
      "Do not hammer",
      "Do not invent",
      "login is login",
      "payment, a real-name check",
      "Take over",
      "decide from the content",
    ])
      expect(prompt, rule).toContain(rule);
  });
});
