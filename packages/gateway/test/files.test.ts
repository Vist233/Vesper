import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace, type GatewayRig, type RigOptions, startRig } from "./rig.ts";

const rigs: GatewayRig[] = [];
async function setup(options: RigOptions = {}) {
  const r = await startRig(options);
  rigs.push(r);
  r.runtime.add("s_a");
  await ensureWorkspace(r, "s_a");
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

/** A raw upload with full control of the headers and the body, as the page's XMLHttpRequest sends it. */
function upload(
  r: GatewayRig,
  name: string | undefined,
  body: Buffer | string,
  headers: Record<string, string> = {},
  session = "s_a",
): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: r.port,
        method: "POST",
        path: `/api/sessions/${session}/files`,
        headers: {
          host: `127.0.0.1:${r.port}`,
          "content-length": String(payload.length),
          "content-type": "application/pdf",
          ...(name === undefined ? {} : { "x-file-name": encodeURIComponent(name) }),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("uploading a file into the session's files directory", () => {
  it("stores it and tells the page the name it ended up with and its size", async () => {
    const r = await setup();
    const reply = await upload(r, "report.pdf", "PDF-bytes");
    expect(reply.status).toBe(201);
    expect(reply.json.file).toMatchObject({ name: "report.pdf", size: 9 });
    expect((await r.probe.call("GET", "/api/sessions/s_a/files")).json.files).toEqual([expect.objectContaining({ name: "report.pdf", size: 9 })]);
  });

  it("never overwrites: a taken name gets a number", async () => {
    const r = await setup();
    await upload(r, "a.txt", "one");
    const second = await upload(r, "a.txt", "two");
    expect(second.json.file.name).toBe("a-2.txt");
    const names = (await r.probe.call("GET", "/api/sessions/s_a/files")).json.files.map((f: { name: string }) => f.name);
    expect(names).toEqual(["a.txt", "a-2.txt"]);
  });

  it("makes the name safe: no path, no leading dots, no control characters; Chinese names stay", async () => {
    const r = await setup();
    for (const [sent, stored] of [
      ["../../etc/passwd", "passwd"],
      ["..\\..\\windows\\x.txt", "x.txt"],
      [".hidden", "hidden"],
      ["a\u0000b.txt", "ab.txt"],
      ["报告 2026.pdf", "报告 2026.pdf"],
    ] as const) {
      const reply = await upload(r, sent, "x");
      expect(reply.status, sent).toBe(201);
      expect(reply.json.file.name).toBe(stored);
    }
  });

  it("refuses a missing, empty or broken name header, and an empty file, without quoting anything", async () => {
    const r = await setup();
    expect((await upload(r, undefined, "x")).status).toBe(400);
    expect((await upload(r, "", "x")).status).toBe(400);
    expect((await upload(r, "..", "x")).status).toBe(400);
    expect((await upload(r, "ok.txt", "", {})).status).toBe(400);
    const bad = await upload(r, "x", "x", { "x-file-name": "%E0%A4%A" });
    expect(bad.status).toBe(400);
  });

  it("caps the size: by the declared length and by what arrives, and keeps nothing", async () => {
    const r = await setup({ limits: { maxFileBytes: 100 } });
    expect((await upload(r, "big.bin", Buffer.alloc(101))).status).toBe(413);
    const { request: rq } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = rq(
        {
          host: "127.0.0.1",
          port: r.port,
          method: "POST",
          path: "/api/sessions/s_a/files",
          headers: { "x-file-name": "lie.bin", "transfer-encoding": "chunked" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolve(0));
      req.write(Buffer.alloc(500));
      req.end();
    });
    expect(status).toBe(413);
    expect((await r.probe.call("GET", "/api/sessions/s_a/files")).json.files).toEqual([]);
  });

  it("allows a 25 MB file by default and holds at most 20 files per session", async () => {
    const r = await setup({ limits: { maxFiles: 3 } });
    for (let i = 0; i < 3; i++) expect((await upload(r, `f${i}.txt`, "x")).status).toBe(201);
    const fourth = await upload(r, "f3.txt", "x");
    expect(fourth.status).toBe(409);
    expect(fourth.json.error.kind).toBe("conflict");
    const options = (await r.probe.call("GET", "/api/options")).json;
    expect(options.limits).toEqual({ fileBytes: 25 * 1024 * 1024, files: 3 });
    expect(options.files).toBe(true);
  });

  it("takes a file of exactly 25 MB and refuses one byte more", async () => {
    const r = await setup();
    expect((await upload(r, "exact.bin", Buffer.alloc(25 * 1024 * 1024))).status).toBe(201);
    // The server answers 413 from the declared length and closes; a client still sending 25 MB may see the reset first
    // (the page never sends such a file: it checks the size before uploading). Either way nothing is stored.
    const over = await upload(r, "over.bin", Buffer.alloc(25 * 1024 * 1024 + 1)).then(
      (reply) => reply.status,
      (error: NodeJS.ErrnoException) => error.code,
    );
    expect([413, "ECONNRESET", "EPIPE"]).toContain(over);
    const names = (await r.probe.call("GET", "/api/sessions/s_a/files")).json.files.map((f: { name: string }) => f.name);
    expect(names).toEqual(["exact.bin"]);
  }, 30_000); // two 25 MB bodies: slow when the whole suite runs in parallel

  it("needs the bearer token, the right Origin, a session and a workspace host", async () => {
    const guarded = await setup({ token: "t" });
    expect((await upload(guarded, "a.txt", "x")).status).toBe(401);
    expect((await upload(guarded, "a.txt", "x", { authorization: "Bearer t", origin: "http://evil.example" })).status).toBe(403);
    expect((await upload(guarded, "a.txt", "x", { authorization: "Bearer t" })).status).toBe(201);
    const r = await setup();
    expect((await upload(r, "a.txt", "x", {}, "s_zz")).status).toBe(404);
    const bare = await setup({ workspaces: undefined });
    expect((await upload(bare, "a.txt", "x")).json.error.kind).toBe("unavailable");
  });

  it("never puts the content or the text of the file in a log; it logs name and size", async () => {
    const r = await setup();
    await upload(r, "secret-plan.txt", "TOP-SECRET-CONTENT");
    const logs = JSON.stringify(r.logs);
    expect(logs).not.toContain("TOP-SECRET-CONTENT");
    expect(logs).toContain("secret-plan.txt");
  });
});

describe("downloading", () => {
  it("sends the bytes as an attachment, never sniffed, whatever the file claims to be", async () => {
    const r = await setup();
    await upload(r, "page.html", "<script>alert(1)</script>", { "content-type": "text/html" });
    const reply = await r.probe.call("GET", "/api/sessions/s_a/files/page.html");
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("<script>alert(1)</script>");
    expect(reply.headers["content-type"]).toBe("application/octet-stream");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["content-disposition"]).toContain("attachment");
    expect(reply.headers["cache-control"]).toBe("no-store");
  });

  it("carries a Chinese name in the disposition header, encoded", async () => {
    const r = await setup();
    await upload(r, "报告.pdf", "x");
    const reply = await r.probe.call("GET", `/api/sessions/s_a/files/${encodeURIComponent("报告.pdf")}`);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-disposition"]).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
  });

  it("only a clean name exists: paths, dot-files and odd encodings are 404, a missing file is 404", async () => {
    const r = await setup();
    await upload(r, "a.txt", "x");
    for (const name of ["..%2Fa.txt", "%2e%2e", ".a.txt", "a%00.txt", "sub%2Fa.txt", "nothing.txt", "%zz", "%5Cwindows"]) {
      const reply = await r.probe.call("GET", `/api/sessions/s_a/files/${name}`);
      expect(reply.status, name).toBe(404);
    }
  });

  it("is the session's own: another session's files are not reachable by name", async () => {
    const r = await setup();
    r.runtime.add("s_b");
    await ensureWorkspace(r, "s_b");
    await upload(r, "mine.txt", "x", {}, "s_a");
    expect((await r.probe.call("GET", "/api/sessions/s_b/files/mine.txt")).status).toBe(404);
    expect((await r.probe.call("GET", "/api/sessions/s_b/files")).json.files).toEqual([]);
  });

  it("needs the bearer token", async () => {
    const r = await setup({ token: "t" });
    expect((await r.probe.call("GET", "/api/sessions/s_a/files")).status).toBe(401);
    expect((await r.probe.call("GET", "/api/sessions/s_a/files/a.txt")).status).toBe(401);
  });
});

describe("a message with attachments", () => {
  it("passes real attachments to the runtime and refuses invented ones", async () => {
    const r = await setup();
    await upload(r, "a.txt", "abc");
    const ok = await r.probe.call("POST", "/api/sessions/s_a/messages", { body: { text: "see the file", attachments: [{ name: "a.txt", size: 3 }] } });
    expect(ok.status).toBe(202);
    expect(r.runtime.calls.find((c) => c.startsWith("send:s_a:see the file"))).toContain('attachments=[{"name":"a.txt","size":3}]');
    for (const attachments of [
      [{ name: "nothing.txt", size: 1 }],
      [{ name: "a.txt", size: 99 }],
      [{ name: "../a.txt", size: 3 }],
      [{ name: 5, size: 3 }],
      "a.txt",
      [null],
    ]) {
      expect((await r.probe.call("POST", "/api/sessions/s_a/messages", { body: { text: "x", attachments } })).status).toBe(400);
    }
    expect(r.runtime.calls.filter((c) => c.startsWith("send")).length).toBe(1);
  });

  it("a message without attachments is sent as before", async () => {
    const r = await setup();
    await r.probe.call("POST", "/api/sessions/s_a/messages", { body: { text: "plain" } });
    expect(r.runtime.calls).toContain("send:s_a:plain");
  });

  it("at most 20 attachments", async () => {
    const r = await setup();
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, size: 1 }));
    expect((await r.probe.call("POST", "/api/sessions/s_a/messages", { body: { text: "x", attachments: many } })).status).toBe(400);
  });
});
