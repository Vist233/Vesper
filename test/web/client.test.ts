import { afterEach, describe, expect, it } from "vitest";
import { ApiError, createApi, followEvents } from "../../packages/web/src/client.js";
import { applyEvent, createState } from "../../packages/web/src/model.js";
import { type Harness, startHarness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 8000) => {
  for (let waited = 0; waited < ms && !check(); waited += 10) await sleep(10);
  expect(check()).toBe(true);
};

async function setup(options: Parameters<typeof startHarness>[0] = {}) {
  harness = await startHarness(options);
  await harness.addSession("s_a", "Alpha");
  return harness;
}

describe("the page's API client against the real gateway", () => {
  it("covers the whole API", async () => {
    const h = await setup();
    const api = createApi({ base: h.url });
    expect((await api.health()).ready).toBe(true);
    expect((await api.options()).profiles).toEqual(["general", "operator"]);
    expect((await api.listSessions()).sessions).toHaveLength(1);
    const { session } = await api.createSession({ title: "New", model: "main" });
    expect(session.title).toBe("New");
    await api.send("s_a", "hello", "m1");
    await api.stop("s_a");
    expect((await api.getSession("s_a")).state.held).toBe(true);
    await api.decide("s_a", "ap_1", true);
    expect((await api.liveView("s_a")).url).toMatch(/^\/ws\/s_a\/view\?ticket=/);
    expect((await api.takeover("s_a")).url).toMatch(/^\/ws\/s_a\/takeover\?ticket=/);
    expect((await api.handback("s_a", "done")).wasOpen).toBe(true);
    expect((await api.deleteSession("s_a")).ok).toBe(true);
  });

  it("turns failures into ApiError with the kind, and an unreachable server into status 0", async () => {
    const h = await setup();
    const api = createApi({ base: h.url });
    await expect(api.getSession("s_nope")).rejects.toMatchObject({ status: 404, kind: "not_found" });
    await expect(api.createSession({ title: "x", ...({ disableReview: true } as object) })).resolves.toBeDefined(); // the fake runtime accepts it; the real one refuses (gateway tests)
    const down = createApi({ base: "http://127.0.0.1:1" });
    await expect(down.health()).rejects.toBeInstanceOf(ApiError);
    await expect(down.health()).rejects.toMatchObject({ status: 0, kind: "unreachable" });
  });

  it("sends the token when it has one", async () => {
    const h = await setup({ token: "t0k" });
    await expect(createApi({ base: h.url }).listSessions()).rejects.toMatchObject({ status: 401 });
    expect((await createApi({ base: h.url, token: () => "t0k" }).listSessions()).sessions).toHaveLength(1);
  });
});

describe("following the event stream", () => {
  it("delivers history then live events and ends on abort", async () => {
    const h = await setup();
    for (let i = 0; i < 3; i++) await h.runtime.emit("s_a", { type: "message.user", payload: { role: "user", content: [{ type: "text", text: `m${i}` }] } });
    const state = createState();
    const abort = new AbortController();
    const states: string[] = [];
    const done = followEvents({
      url: `${h.url}/api/sessions/s_a/events`,
      after: () => state.lastSeq,
      onEvents: (events) => {
        for (const e of events) applyEvent(state, e);
      },
      onConnection: (s) => states.push(s),
      signal: abort.signal,
    });
    await until(() => state.lastSeq === 3);
    await h.runtime.emit("s_a", { type: "run.started", payload: null });
    await until(() => state.lastSeq === 4);
    expect(states).toContain("live");
    abort.abort();
    await done;
  });

  it("reconnects by itself after the gateway restarts and gets exactly the events it missed", async () => {
    const h = await setup();
    const state = createState();
    const abort = new AbortController();
    const states: string[] = [];
    const done = followEvents({
      url: `${h.url}/api/sessions/s_a/events`,
      after: () => state.lastSeq,
      onEvents: (events) => {
        for (const e of events) applyEvent(state, e);
      },
      onConnection: (s) => states.push(s),
      signal: abort.signal,
      backoffMs: { first: 20, max: 100 },
    });
    await h.runtime.emit("s_a", { type: "message.user", payload: { role: "user", content: [{ type: "text", text: "one" }] } });
    await until(() => state.lastSeq === 1);
    await h.stopGateway();
    await until(() => states.at(-1) === "reconnecting");
    for (let i = 2; i <= 6; i++) await h.runtime.emit("s_a", { type: "message.user", payload: { role: "user", content: [{ type: "text", text: `n${i}` }] } });
    await h.startGateway();
    await until(() => state.lastSeq === 6);
    expect(state.items.map((i: any) => i.text)).toEqual(["one", "n2", "n3", "n4", "n5", "n6"]);
    expect(state.gaps).toBe(0);
    abort.abort();
    await done;
  });

  it("stops for answers that retrying cannot fix: 401 and 404", async () => {
    const h = await setup({ token: "t" });
    const seen: string[] = [];
    await followEvents({
      url: `${h.url}/api/sessions/s_a/events`,
      onEvents: () => {},
      onConnection: (s) => seen.push(s),
      signal: new AbortController().signal,
    });
    expect(seen.at(-1)).toBe("unauthorized");
    const seen2: string[] = [];
    await followEvents({
      url: `${h.url}/api/sessions/s_zz/events`,
      token: () => "t",
      onEvents: () => {},
      onConnection: (s) => seen2.push(s),
      signal: new AbortController().signal,
    });
    expect(seen2.at(-1)).toBe("gone");
  });

  it("gives up waiting on a stream that goes quiet and connects again (the watchdog)", async () => {
    const h = await setup({ limits: { heartbeatMs: 60_000 } });
    const abort = new AbortController();
    const states: string[] = [];
    const done = followEvents({
      url: `${h.url}/api/sessions/s_a/events`,
      onEvents: () => {},
      onConnection: (s) => states.push(s),
      signal: abort.signal,
      quietMs: 100,
      backoffMs: { first: 10, max: 20 },
    });
    await until(() => states.filter((s) => s === "live").length >= 2, 5000);
    abort.abort();
    await done;
  });

  it("skips a frame that is not JSON instead of stopping", async () => {
    const calls: string[] = [];
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('id: 1\ndata: not json\n\nid: 2\ndata: {"seq":2,"type":"x","payload":null,"at":1,"sessionId":"s","v":1}\n\n'),
        );
        controller.close();
      },
    });
    const abort = new AbortController();
    const fake = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    let seen = 0;
    await followEvents({
      url: "http://x/events",
      fetch: fake,
      onEvents: (events) => {
        seen += events.length;
        calls.push(JSON.stringify(events.map((e) => e.seq)));
        abort.abort();
      },
      signal: abort.signal,
    });
    expect(seen).toBe(1);
    expect(calls).toEqual(["[2]"]);
  });

  it("waits as long as Retry-After says when the server is full", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const abort = new AbortController();
    const fake = (async () => {
      attempts += 1;
      if (attempts === 2) abort.abort();
      return new Response("{}", { status: 503, headers: { "retry-after": "7" } });
    }) as unknown as typeof fetch;
    await followEvents({
      url: "http://x/events",
      fetch: fake,
      onEvents: () => {},
      signal: abort.signal,
      sleep: async (ms) => void waits.push(ms),
      backoffMs: { first: 10, max: 20 },
    });
    expect(waits[0]).toBe(7000);
  });
});
