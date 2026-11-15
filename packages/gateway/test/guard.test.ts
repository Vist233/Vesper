import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../src/index.ts";
import { createFakeRuntime } from "../src/testing/index.ts";
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

describe("Host header (DNS rebinding)", () => {
  it("serves the loopback names with any port", async () => {
    const { probe, port } = await rig();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost"])
      expect((await probe.call("GET", "/api/health", { headers: { host } })).status).toBe(200);
  });

  it.each(["evil.example", "evil.example:80", "127.0.0.1.evil.example", "localhost.evil.example:3000", "0.0.0.0", "a b", "127.0.0.1:99999x"])(
    "refuses Host '%s' on the API and on the page",
    async (host) => {
      const { probe } = await rig();
      for (const path of ["/api/health", "/api/sessions", "/"]) {
        const reply = await probe.call("GET", path, { headers: { host } });
        expect(reply.status, `${path} with Host '${host}'`).toBe(403);
        expect(reply.json.error.kind).toBe("denied");
      }
    },
  );

  it("refuses a request with no Host header at all", async () => {
    const { port } = await rig();
    const { connect } = await import("node:net");
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET /api/sessions HTTP/1.0\r\n\r\n"));
      let text = "";
      socket.on("data", (d) => (text += d));
      socket.on("close", () => resolve(text));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
  });

  it("serves a name that the owner added (for a published port) and nothing else", async () => {
    const { probe, port } = await rig({ extraHosts: ["bot.home.example"] });
    expect((await probe.call("GET", "/api/health", { headers: { host: "bot.home.example:8443" } })).status).toBe(200);
    expect((await probe.call("GET", "/api/health", { headers: { host: `other.home.example:${port}` } })).status).toBe(403);
  });
});

describe("Origin (cross-site requests)", () => {
  it("accepts the page's own origin and requests without an Origin header", async () => {
    const { probe, port } = await rig();
    expect((await probe.call("GET", "/api/health", { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    expect((await probe.call("GET", "/api/health")).status).toBe(200);
  });

  it.each(["http://evil.example", "https://evil.example", "null", "http://localhost:1", "http://127.0.0.1:1", "http://127.0.0.1", "file://"])(
    "refuses Origin '%s' on reads and writes",
    async (origin) => {
      const r = await rig();
      r.runtime.add("s_a");
      const read = await r.probe.call("GET", "/api/sessions", { headers: { origin } });
      expect(read.status).toBe(403);
      const write = await r.probe.call("POST", "/api/sessions/s_a/messages", { headers: { origin }, body: { text: "hi" } });
      expect(write.status).toBe(403);
      expect(r.runtime.calls.filter((c) => c.startsWith("send"))).toEqual([]); // nothing reached the runtime
    },
  );

  it("sends no CORS headers, not even on a refusal or on OPTIONS", async () => {
    const { probe, port } = await rig();
    for (const [method, origin] of [
      ["GET", `http://127.0.0.1:${port}`],
      ["GET", "http://evil.example"],
      ["OPTIONS", "http://evil.example"],
    ] as const) {
      const reply = await probe.call(method, "/api/sessions", { headers: { origin } });
      expect(Object.keys(reply.headers).filter((h) => h.startsWith("access-control"))).toEqual([]);
    }
    expect((await probe.call("OPTIONS", "/api/sessions", { headers: { origin: "http://evil.example", "access-control-request-method": "POST" } })).status).toBe(
      403,
    );
  });
});

describe("bearer token", () => {
  it("is off by default: no header needed", async () => {
    const { probe } = await rig();
    expect((await probe.call("GET", "/api/sessions")).status).toBe(200);
  });

  it("when set, every API call except the health probe needs it", async () => {
    const r = await rig({ token: "s3cret-token" });
    r.runtime.add("s_a");
    const paths: [string, string][] = [
      ["GET", "/api/sessions"],
      ["GET", "/api/options"],
      ["GET", "/api/sessions/s_a"],
      ["POST", "/api/sessions/s_a/messages"],
      ["GET", "/api/sessions/s_a/events"],
      ["POST", "/api/sessions/s_a/takeover"],
    ];
    for (const [method, path] of paths) {
      expect((await r.probe.call(method, path)).status, `${method} ${path}`).toBe(401);
      expect((await r.probe.call(method, path, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await r.probe.call(method, path, { headers: { authorization: "Basic s3cret-token" } })).status).toBe(401);
      expect((await r.probe.call(method, path, { headers: { authorization: "s3cret-token" } })).status).toBe(401);
    }
    expect((await r.probe.call("GET", "/api/health")).status).toBe(200);
    expect((await r.probe.call("GET", "/api/sessions", { headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
    expect(r.runtime.calls.filter((c) => !/^(list|status|read|takeoverState)/.test(c))).toEqual([]); // the refused calls never reached the runtime
    expect(r.runtime.calls[0]).toBe("list");
  });

  it("does not guard the page itself, which must load before the person can enter a token", async () => {
    const { probe } = await rig({ token: "t" });
    expect((await probe.call("GET", "/")).status).toBe(200);
  });

  it("never echoes the token", async () => {
    const r = await rig({ token: "s3cret-token" });
    const reply = await r.probe.call("GET", "/api/sessions", { headers: { authorization: "Bearer s3cret-tokeX" } });
    expect(reply.text).not.toContain("s3cret");
    expect(JSON.stringify(r.logs)).not.toContain("s3cret");
  });
});

describe("listening", () => {
  it("binds the loopback address by default", async () => {
    const r = await rig();
    const gateway = createGateway({ runtime: createFakeRuntime() });
    const bound = await gateway.listen();
    expect(bound.host).toBe("127.0.0.1");
    await gateway.close();
    expect(r.port).toBeGreaterThan(0);
  });

  it("refuses a non-loopback address without a token, and accepts it with one", async () => {
    const open = createGateway({ runtime: createFakeRuntime() });
    await expect(open.listen({ host: "0.0.0.0" })).rejects.toMatchObject({ kind: "invalid_input" });
    const guarded = createGateway({ runtime: createFakeRuntime(), token: "t" });
    const bound = await guarded.listen({ host: "0.0.0.0" });
    expect(bound.port).toBeGreaterThan(0);
    await guarded.close();
  });

  it("allows a non-loopback address without a token only when openListen is set, and says so in the log", async () => {
    const logs: Record<string, unknown>[] = [];
    const gateway = createGateway({ runtime: createFakeRuntime(), openListen: true, log: (entry) => void logs.push(entry) });
    const bound = await gateway.listen({ host: "0.0.0.0" });
    expect(logs.some((entry) => entry.level === "warn" && String(entry.message).includes("without a token"))).toBe(true);
    expect((await fetch(`http://127.0.0.1:${bound.port}/api/health`)).status).toBe(200);
    await gateway.close();
    const closed = createGateway({ runtime: createFakeRuntime(), openListen: false });
    await expect(closed.listen({ host: "0.0.0.0" })).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("refuses a second listen and closes cleanly twice", async () => {
    const gateway = createGateway({ runtime: createFakeRuntime() });
    await gateway.listen();
    await expect(gateway.listen()).rejects.toMatchObject({ kind: "conflict" });
    await gateway.close();
    await gateway.close();
  });
});
