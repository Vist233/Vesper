import { describe, expect, it } from "vitest";
import { OgbError } from "../src/errors.ts";
import { MAX_LINE_BYTES, WORKSPACE_PROTOCOL_VERSION, type WorkspaceHost } from "../src/workspace-host.ts";
import { dispatch, LineReader, WORKSPACE_METHODS, type WorkspaceRequest } from "../src/workspace-wire.ts";

describe("LineReader", () => {
  it("returns complete lines and keeps the rest for the next chunk", () => {
    const reader = new LineReader();
    expect(reader.push("one\ntw")).toEqual(["one"]);
    expect(reader.push("o\nthree\n")).toEqual(["two", "three"]);
    expect(reader.push("")).toEqual([]);
    expect(reader.push("\n")).toEqual([""]);
  });

  it("reads a line of tens of megabytes in 64 KiB chunks in one pass", () => {
    const reader = new LineReader();
    const chunk = "x".repeat(65_536);
    const started = Date.now();
    for (let i = 0; i < 500; i += 1) expect(reader.push(chunk)).toEqual([]);
    const [line] = reader.push("\n");
    expect(line?.length).toBe(500 * 65_536);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("throws when a line that has not ended is longer than the limit", () => {
    const reader = new LineReader();
    expect(() => reader.push("x".repeat(MAX_LINE_BYTES + 1))).toThrow(/too long/);
  });
});

/** A host whose every method records the call and answers with it. */
function recordingHost(calls: unknown[][]): WorkspaceHost {
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return { called: name } as never;
    };
  return {
    ensure: record("ensure"),
    destroy: record("destroy"),
    health: record("health"),
    takeover: { open: record("takeover.open"), close: record("takeover.close") },
    view: { open: record("view.open") },
    input: { insertText: record("input.insertText") },
    files: { put: record("files.put"), list: record("files.list"), get: async () => new Uint8Array([104, 105]) },
  };
}

const request = (method: string, params: unknown): WorkspaceRequest => ({ v: WORKSPACE_PROTOCOL_VERSION, id: "r1", method, params }) as WorkspaceRequest;

describe("dispatch", () => {
  it("maps every method of WORKSPACE_METHODS onto a host call and answers with the request's id", async () => {
    const calls: unknown[][] = [];
    const host = recordingHost(calls);
    for (const method of WORKSPACE_METHODS) {
      const params = method === "ensure" ? { workspaceId: "w1" } : { workspaceId: "w1", text: "hi", name: "a.txt", data: "aGk=" };
      const response = await dispatch(host, request(method, params));
      expect(response, method).toMatchObject({ v: 1, id: "r1", ok: true });
    }
    expect(calls.map((c) => c[0])).toEqual([
      "ensure",
      "destroy",
      "health",
      "takeover.open",
      "takeover.close",
      "view.open",
      "input.insertText",
      "files.put",
      "files.list",
    ]);
  });

  it("passes text and file fields through, decoding the file bytes", async () => {
    const calls: unknown[][] = [];
    const host = recordingHost(calls);
    await dispatch(host, request("input.insertText", { workspaceId: "w1", text: "你好" }));
    await dispatch(host, request("files.put", { workspaceId: "w1", name: "../a.txt", data: "aGk=" }));
    expect(calls[0]).toEqual(["input.insertText", "w1", "你好"]);
    expect(calls[1]?.slice(0, 3)).toEqual(["files.put", "w1", "a.txt"]);
    expect(Array.from(calls[1]?.[3] as Uint8Array)).toEqual([104, 105]);
    expect(await dispatch(host, request("files.get", { workspaceId: "w1", name: "a.txt" }))).toMatchObject({ ok: true, result: { data: "aGk=" } });
  });

  it("answers bad params with invalid_input and never throws", async () => {
    const host = recordingHost([]);
    for (const [method, params] of [
      ["health", "w1"],
      ["health", { workspaceId: "../x" }],
      ["input.insertText", { workspaceId: "w1", text: "" }],
      ["files.put", { workspaceId: "w1", name: "a", data: "!!!" }],
      ["files.put", { workspaceId: "w1", name: "", data: "aGk=" }],
    ] as const) {
      expect(await dispatch(host, request(method, params)), method).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    }
  });

  it("carries an OgbError from the host as its kind and hides any other exception", async () => {
    const host = recordingHost([]);
    host.health = async () => {
      throw new OgbError("not_found", "nope");
    };
    expect(await dispatch(host, request("health", { workspaceId: "w1" }))).toMatchObject({ ok: false, error: { kind: "not_found", message: "nope" } });
    host.health = async () => {
      throw new Error("secret /Users/someone");
    };
    const hidden = await dispatch(host, request("health", { workspaceId: "w1" }));
    expect(hidden).toMatchObject({ ok: false, error: { kind: "internal" } });
    expect(JSON.stringify(hidden)).not.toContain("someone");
  });
});
