import { afterEach, describe, expect, it } from "vitest";
import { type GatewayRig, type RigOptions, startRig } from "./rig.ts";

const rigs: GatewayRig[] = [];
async function rig(options: RigOptions = {}) {
  const made = await startRig(options);
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const seqs = (frames: { id: number }[]) => frames.map((f) => f.id);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("event stream", () => {
  it("replays what exists, then follows live, with the sequence number as the event id", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    for (let i = 0; i < 3; i++) await r.runtime.emit("s_a", { type: "message.user", payload: { i } });
    const stream = r.probe.stream("/api/sessions/s_a/events");
    expect(await stream.status).toBe(200);
    await stream.waitFor(3);
    await r.runtime.emit("s_a", { type: "message.assistant", payload: "live" });
    await stream.waitFor(4);
    expect(seqs(stream.frames)).toEqual([1, 2, 3, 4]);
    expect(stream.frames[3]?.event).toMatchObject({ v: 1, seq: 4, sessionId: "s_a", type: "message.assistant", payload: "live" });
    expect(stream.raw()).toContain("retry: 2000");
    stream.close();
  });

  it("answers with the event-stream type and no caching", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    const { request } = await import("node:http");
    const headers = await new Promise<Record<string, unknown>>((resolve) => {
      const req = request({ host: "127.0.0.1", port: r.port, path: "/api/sessions/s_a/events" }, (res) => {
        resolve(res.headers);
        req.destroy();
      });
      req.end();
    });
    expect(headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(headers["cache-control"]).toBe("no-store");
  });

  it("starts after Last-Event-ID, or after ?after=, and refuses nonsense", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    for (let i = 0; i < 5; i++) await r.runtime.emit("s_a", { type: "message.user", payload: i });
    const byHeader = r.probe.stream("/api/sessions/s_a/events", { "last-event-id": "3" });
    await byHeader.waitFor(2);
    expect(seqs(byHeader.frames)).toEqual([4, 5]);
    const byQuery = r.probe.stream("/api/sessions/s_a/events?after=4");
    await byQuery.waitFor(1);
    expect(seqs(byQuery.frames)).toEqual([5]);
    for (const bad of ["x", "-1", "1e3", ""]) {
      const reply = await r.probe.call("GET", "/api/sessions/s_a/events", { headers: { "last-event-id": bad } });
      expect(reply.status, `Last-Event-ID '${bad}'`).toBe(400);
    }
    byHeader.close();
    byQuery.close();
  });

  it("an unknown session is a 404 before any stream starts", async () => {
    const r = await rig();
    const reply = await r.probe.call("GET", "/api/sessions/s_missing/events");
    expect(reply.status).toBe(404);
    expect(reply.headers["content-type"]).toContain("application/json");
  });

  it("keeps sessions apart", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    r.runtime.add("s_b");
    const a = r.probe.stream("/api/sessions/s_a/events");
    await r.runtime.emit("s_b", { type: "message.user", payload: "for b" });
    await r.runtime.emit("s_a", { type: "message.user", payload: "for a" });
    await a.waitFor(1);
    await sleep(30);
    expect(a.frames.map((f) => f.event.payload)).toEqual(["for a"]);
    a.close();
  });

  it("sends a heartbeat comment while idle", async () => {
    const r = await rig({ limits: { heartbeatMs: 20 } });
    r.runtime.add("s_a");
    const stream = r.probe.stream("/api/sessions/s_a/events");
    await stream.status;
    await sleep(120);
    expect(stream.raw().match(/: ping/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(stream.frames).toEqual([]);
    stream.close();
  });

  it("loses nothing and repeats nothing across dropped connections while events keep arriving", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    const total = 400;
    // The writer appends in bursts with pauses, the way a run does.
    const writer = (async () => {
      for (let i = 1; i <= total; i++) {
        await r.runtime.emit("s_a", { type: "tool.result", payload: { i } });
        if (i % 17 === 0) await sleep(3);
      }
    })();

    const received: number[] = [];
    let connections = 0;
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    while (received.length < total) {
      const last = received.at(-1) ?? 0;
      const stream = r.probe.stream("/api/sessions/s_a/events", last > 0 ? { "last-event-id": String(last) } : {});
      connections += 1;
      // read a random number of events, then hang up without any goodbye
      const want = Math.min(1 + Math.floor(random() * 40), total - received.length);
      await stream.waitFor(want);
      stream.close();
      await stream.closed;
      for (const frame of stream.frames.slice(0, want)) received.push(frame.id);
    }
    await writer;
    expect(received).toEqual(range(1, total));
    expect(connections).toBeGreaterThan(5);
  });

  it("frees the stream slot when a client hangs up, and refuses beyond the limit with a hint to retry", async () => {
    const r = await rig({ limits: { maxStreams: 2 } });
    r.runtime.add("s_a");
    const one = r.probe.stream("/api/sessions/s_a/events");
    const two = r.probe.stream("/api/sessions/s_a/events");
    await one.status;
    await two.status;
    const three = await r.probe.call("GET", "/api/sessions/s_a/events");
    expect(three.status).toBe(503);
    expect(three.headers["retry-after"]).toBe("5");
    one.close();
    await one.closed;
    await sleep(30);
    const again = r.probe.stream("/api/sessions/s_a/events");
    expect(await again.status).toBe(200);
    two.close();
    again.close();
  });

  it("serves many clients at once, each with the full conversation", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    for (let i = 0; i < 20; i++) await r.runtime.emit("s_a", { type: "message.user", payload: i });
    const clients = Array.from({ length: 100 }, () => r.probe.stream("/api/sessions/s_a/events"));
    for (let i = 20; i < 50; i++) await r.runtime.emit("s_a", { type: "message.user", payload: i });
    await Promise.all(clients.map((c) => c.waitFor(50, 10_000)));
    for (const client of clients) expect(seqs(client.frames)).toEqual(range(1, 50));
    for (const client of clients) client.close();
  });

  it("drops a client that stops reading, and that client can come back and lose nothing", async () => {
    const r = await rig({ limits: { slowClientMs: 100 } });
    r.runtime.add("s_a");
    const big = "x".repeat(64 * 1024);
    const total = 300; // about 19 MB: more than the sockets can hold
    const slow = r.probe.stream("/api/sessions/s_a/events");
    await slow.status;
    slow.pause();
    for (let i = 1; i <= total; i++) await r.runtime.emit("s_a", { type: "tool.result", payload: { i, big } });
    for (let i = 0; i < 200 && !r.logs.some((l) => String(l.message).includes("dropped")); i++) await sleep(50);
    expect(r.logs.some((l) => String(l.message).includes("dropped"))).toBe(true); // the server gave up on it
    slow.resume(); // the client reads what reached it and then sees the hang-up
    await slow.closed;
    expect(slow.frames.length).toBeLessThan(total);

    const last = slow.frames.at(-1)?.id ?? 0;
    const fresh = r.probe.stream("/api/sessions/s_a/events", { "last-event-id": String(last) });
    await fresh.waitFor(total - last, 20_000);
    expect([...seqs(slow.frames), ...seqs(fresh.frames)]).toEqual(range(1, total));
    fresh.close();
  });

  it("a slow client does not hold up a fast one", async () => {
    const r = await rig({ limits: { slowClientMs: 5_000 } });
    r.runtime.add("s_a");
    const slow = r.probe.stream("/api/sessions/s_a/events");
    const fast = r.probe.stream("/api/sessions/s_a/events");
    await slow.status;
    slow.pause();
    const big = "y".repeat(32 * 1024);
    for (let i = 1; i <= 100; i++) await r.runtime.emit("s_a", { type: "tool.result", payload: { big } });
    await fast.waitFor(100, 10_000);
    expect(seqs(fast.frames)).toEqual(range(1, 100));
    slow.close();
    fast.close();
  });

  it("ends every stream when the gateway closes", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    const streams = [r.probe.stream("/api/sessions/s_a/events"), r.probe.stream("/api/sessions/s_a/events")];
    await Promise.all(streams.map((s) => s.status));
    await r.gateway.close();
    await Promise.all(streams.map((s) => s.closed));
  });
});
