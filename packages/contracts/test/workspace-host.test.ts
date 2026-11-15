import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN,
  encodeLine,
  errorResponse,
  isWorkspaceId,
  MAX_LINE_BYTES,
  OgbError,
  okResponse,
  parseRequest,
  parseResponse,
  requestIdOf,
  resolveWorkspaceSpec,
  sameSpec,
  unwrapResponse,
  WORKSPACE_METHODS,
  WORKSPACE_PROTOCOL_VERSION,
} from "../src/index.ts";

describe("workspace ids", () => {
  it.each(["a", "ws-1", "0abc", "a".repeat(32)])("accepts %s", (id) => expect(isWorkspaceId(id)).toBe(true));
  it.each(["", "-a", "A", "a_b", "a/b", "a..b", "a".repeat(33), "a b", 5, null])("rejects %s", (id) => expect(isWorkspaceId(id)).toBe(false));
});

describe("resolveWorkspaceSpec", () => {
  it("fills the default screen", () => {
    expect(resolveWorkspaceSpec({ workspaceId: "w1" })).toEqual({ workspaceId: "w1", screen: DEFAULT_SCREEN });
    expect(DEFAULT_SCREEN).toEqual({ width: 1280, height: 800 });
  });

  it("keeps a given screen", () => {
    expect(resolveWorkspaceSpec({ workspaceId: "w1", screen: { width: 1920, height: 1080 } }).screen).toEqual({ width: 1920, height: 1080 });
  });

  it.each([
    ["not an object", 3],
    ["array", []],
    ["bad id", { workspaceId: "A!" }],
    ["unknown field", { workspaceId: "w", shell: "bash" }],
    ["screen not object", { workspaceId: "w", screen: 3 }],
    ["fractional width", { workspaceId: "w", screen: { width: 1000.5, height: 800 } }],
    ["tiny height", { workspaceId: "w", screen: { width: 1280, height: 10 } }],
    ["huge width", { workspaceId: "w", screen: { width: 99999, height: 800 } }],
    ["string width", { workspaceId: "w", screen: { width: "1280", height: 800 } }],
    ["missing height", { workspaceId: "w", screen: { width: 1280 } }],
  ])("rejects %s with invalid_input", (_name, value) => {
    expect(() => resolveWorkspaceSpec(value)).toThrowError(expect.objectContaining({ kind: "invalid_input" }));
  });

  it("compares specs by value", () => {
    const a = resolveWorkspaceSpec({ workspaceId: "w" });
    expect(sameSpec(a, resolveWorkspaceSpec({ workspaceId: "w", screen: DEFAULT_SCREEN }))).toBe(true);
    expect(sameSpec(a, resolveWorkspaceSpec({ workspaceId: "w", screen: { width: 1000, height: 800 } }))).toBe(false);
    expect(sameSpec(a, resolveWorkspaceSpec({ workspaceId: "x" }))).toBe(false);
  });
});

describe("wire format", () => {
  const request = { v: WORKSPACE_PROTOCOL_VERSION, id: "1", method: "health", params: { workspaceId: "w" } } as const;

  it("round-trips a request through one line", () => {
    const line = encodeLine(request);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseRequest(line.trim())).toEqual(request);
  });

  it("accepts every method", () => {
    for (const method of WORKSPACE_METHODS) expect(parseRequest(JSON.stringify({ ...request, method })).method).toBe(method);
  });

  it.each([
    ["not json", "{"],
    ["not an object", "[1]"],
    ["wrong version", JSON.stringify({ ...request, v: 0 })],
    ["empty id", JSON.stringify({ ...request, id: "" })],
    ["unknown method", JSON.stringify({ ...request, method: "shell" })],
    ["no params", JSON.stringify({ v: 1, id: "1", method: "health" })],
    ["too long", `"${"x".repeat(MAX_LINE_BYTES)}"`],
  ])("rejects a request that is %s", (_name, line) => {
    expect(() => parseRequest(line)).toThrowError(expect.objectContaining({ kind: "invalid_input" }));
  });

  it("reports a newer protocol as unsupported_version", () => {
    expect(() => parseRequest(JSON.stringify({ ...request, v: 2 }))).toThrowError(expect.objectContaining({ kind: "unsupported_version" }));
  });

  it("recovers the id of a bad request when there is one", () => {
    expect(requestIdOf(JSON.stringify({ id: "abc", method: "nope" }))).toBe("abc");
    expect(requestIdOf("{")).toBe("");
    expect(requestIdOf("[]")).toBe("");
    expect(requestIdOf(JSON.stringify({ id: 4 }))).toBe("");
  });

  it("round-trips responses and unwraps them", () => {
    const ok = parseResponse(encodeLine(okResponse("1", { existed: true })).trim());
    expect(unwrapResponse(ok)).toEqual({ existed: true });
    const failed = parseResponse(encodeLine(errorResponse("1", new OgbError("conflict", "spec differs"))).trim());
    expect(() => unwrapResponse(failed)).toThrowError(expect.objectContaining({ kind: "conflict", message: "spec differs" }));
  });

  it("does not leak the text of an unexpected exception", () => {
    const response = errorResponse("1", new Error("secret path /home/x"));
    expect(JSON.stringify(response)).not.toContain("/home/x");
    expect(response.ok === false && response.error.kind).toBe("internal");
  });

  it("maps an unknown error kind from a newer daemon to internal", () => {
    const response = parseResponse(JSON.stringify({ v: 1, id: "1", ok: false, error: { kind: "exploded", message: "m" } }));
    expect(() => unwrapResponse(response)).toThrowError(expect.objectContaining({ kind: "internal" }));
  });

  it.each([
    ["not json", "x"],
    ["wrong version", JSON.stringify({ v: 2, id: "1", ok: true, result: null })],
    ["no ok", JSON.stringify({ v: 1, id: "1" })],
    ["ok without result", JSON.stringify({ v: 1, id: "1", ok: true })],
    ["error without kind", JSON.stringify({ v: 1, id: "1", ok: false, error: { message: "m" } })],
  ])("rejects a response that is %s", (_name, line) => {
    expect(() => parseResponse(line)).toThrowError(expect.objectContaining({ kind: "invalid_input" }));
  });
});
