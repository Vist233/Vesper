import { ERROR_KINDS, OgbError } from "./errors.ts";
import { isJsonObject, type JsonValue } from "./json.ts";
import { checkInsertText, isWorkspaceId, MAX_LINE_BYTES, WORKSPACE_PROTOCOL_VERSION, type WorkspaceHost, type WorkspaceSpec } from "./workspace-host.ts";
import { checkFileBytes, fromBase64, sanitizeFileName, toBase64 } from "./workspace-files.ts";

/**
 * The wire format of the `WorkspaceHost` protocol (see workspace-host.ts for the rules): requests, responses, the
 * JSON-lines codec, and `dispatch`, the one place that maps a method name onto a host call. A new method is added
 * to `WORKSPACE_METHODS`, to the host interface, and to the switch in `dispatch`; the compiler finds the rest.
 */

export const WORKSPACE_METHODS = [
  "ensure",
  "destroy",
  "health",
  "takeover.open",
  "takeover.close",
  "view.open",
  "input.insertText",
  "files.put",
  "files.list",
  "files.get",
] as const;
export type WorkspaceMethod = (typeof WORKSPACE_METHODS)[number];

export interface WorkspaceRequest {
  readonly v: typeof WORKSPACE_PROTOCOL_VERSION;
  /** Chosen by the client; echoed in the response. */
  readonly id: string;
  readonly method: WorkspaceMethod;
  /** `ensure`: a `WorkspaceSpec`. Every other method: `{ workspaceId }` plus its own fields (`text`; `name`, `data` as base64). */
  readonly params: JsonValue;
}

export type WorkspaceResponse =
  | { readonly v: typeof WORKSPACE_PROTOCOL_VERSION; readonly id: string; readonly ok: true; readonly result: JsonValue }
  | {
      readonly v: typeof WORKSPACE_PROTOCOL_VERSION;
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly kind: string; readonly message: string };
    };

/**
 * Splits a stream of text into lines. Never joins chunks until a line ends and looks only at each new chunk for the
 * line break, so a line of tens of megabytes (a file as base64) costs one pass, not one per chunk. `push` throws
 * `invalid_input` when a line that has not ended yet is longer than `MAX_LINE_BYTES`; the caller ends the connection.
 */
export class LineReader {
  private parts: string[] = [];
  private size = 0;

  push(chunk: string): string[] {
    const lines: string[] = [];
    let rest = chunk;
    for (let newline = rest.indexOf("\n"); newline !== -1; newline = rest.indexOf("\n")) {
      this.parts.push(rest.slice(0, newline));
      lines.push(this.parts.join(""));
      this.parts = [];
      this.size = 0;
      rest = rest.slice(newline + 1);
    }
    if (rest !== "") {
      this.parts.push(rest);
      this.size += rest.length;
      if (this.size > MAX_LINE_BYTES) throw new OgbError("invalid_input", "line is too long");
    }
    return lines;
  }
}

export function encodeLine(message: WorkspaceRequest | WorkspaceResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parses one request line. Throws `invalid_input` for anything malformed and `unsupported_version` for a newer
 * protocol. The id is recovered when possible so the server can answer the right request: see `requestIdOf`.
 */
export function parseRequest(line: string): WorkspaceRequest {
  const value = parseJsonLine(line);
  if (!isJsonObject(value)) throw new OgbError("invalid_input", "request must be a JSON object");
  if (typeof value.v === "number" && value.v > WORKSPACE_PROTOCOL_VERSION) {
    throw new OgbError("unsupported_version", `protocol version ${value.v} is newer than ${WORKSPACE_PROTOCOL_VERSION}`);
  }
  if (value.v !== WORKSPACE_PROTOCOL_VERSION) throw new OgbError("invalid_input", "request.v must be 1");
  if (typeof value.id !== "string" || value.id === "") throw new OgbError("invalid_input", "request.id must be a non-empty string");
  if (!(WORKSPACE_METHODS as readonly unknown[]).includes(value.method)) throw new OgbError("invalid_input", "request.method is unknown");
  if (!("params" in value)) throw new OgbError("invalid_input", "request.params is missing");
  return value as unknown as WorkspaceRequest;
}

/** The id of a request line that failed to parse, or "" when there is none: an error response still needs an id field. */
export function requestIdOf(line: string): string {
  try {
    const value = JSON.parse(line) as unknown;
    return isJsonObject(value) && typeof value.id === "string" ? value.id : "";
  } catch {
    return "";
  }
}

export function parseResponse(line: string): WorkspaceResponse {
  const value = parseJsonLine(line);
  if (!isJsonObject(value) || value.v !== WORKSPACE_PROTOCOL_VERSION || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    throw new OgbError("invalid_input", "response is not a version 1 response");
  }
  if (value.ok) {
    if (!("result" in value)) throw new OgbError("invalid_input", "response.result is missing");
  } else if (!isJsonObject(value.error) || typeof value.error.kind !== "string" || typeof value.error.message !== "string") {
    throw new OgbError("invalid_input", "response.error must have a kind and a message");
  }
  return value as unknown as WorkspaceResponse;
}

function parseJsonLine(line: string): JsonValue {
  if (line.length > MAX_LINE_BYTES) throw new OgbError("invalid_input", "line is too long");
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    throw new OgbError("invalid_input", "line is not valid JSON");
  }
}

export function okResponse(id: string, result: JsonValue): WorkspaceResponse {
  return { v: WORKSPACE_PROTOCOL_VERSION, id, ok: true, result };
}

export function errorResponse(id: string, error: unknown): WorkspaceResponse {
  const known = error instanceof OgbError;
  // An unexpected exception is a bug of the host: say so, and do not leak its text across the socket.
  return {
    v: WORKSPACE_PROTOCOL_VERSION,
    id,
    ok: false,
    error: known ? { kind: error.kind, message: error.message } : { kind: "internal", message: "unexpected error in the workspace host" },
  };
}

/** Turns a response back into a value or a thrown `OgbError` (an unknown kind from a newer daemon becomes `internal`). */
export function unwrapResponse(response: WorkspaceResponse): JsonValue {
  if (response.ok) return response.result;
  const kind = ERROR_KINDS.find((candidate) => candidate === response.error.kind) ?? "internal";
  throw new OgbError(kind, response.error.message);
}

/**
 * Runs one parsed request against a host and returns the response; never throws. Used by every server of the
 * protocol (the daemon's and the test server's), so there is one table from method name to host call.
 */
export async function dispatch(host: WorkspaceHost, request: WorkspaceRequest): Promise<WorkspaceResponse> {
  try {
    return okResponse(request.id, await call(host, request));
  } catch (error) {
    return errorResponse(request.id, error);
  }
}

async function call(host: WorkspaceHost, request: WorkspaceRequest): Promise<JsonValue> {
  const params = request.params;
  const method = request.method;
  if (method === "ensure") return (await host.ensure(params as unknown as WorkspaceSpec)) as unknown as JsonValue;
  if (!isJsonObject(params) || !isWorkspaceId(params.workspaceId)) throw new OgbError("invalid_input", "params must be { workspaceId }");
  const id = params.workspaceId;
  switch (method) {
    case "destroy":
      return (await host.destroy(id)) as unknown as JsonValue;
    case "health":
      return (await host.health(id)) as unknown as JsonValue;
    case "takeover.open":
      return (await host.takeover.open(id)) as unknown as JsonValue;
    case "takeover.close":
      return (await host.takeover.close(id)) as unknown as JsonValue;
    case "view.open":
      return (await host.view.open(id)) as unknown as JsonValue;
    case "input.insertText":
      return (await host.input.insertText(id, checkInsertText(params.text))) as unknown as JsonValue;
    case "files.put":
      return (await host.files.put(id, sanitizeFileName(params.name), checkFileBytes(fromBase64(params.data)))) as unknown as JsonValue;
    case "files.list":
      return (await host.files.list(id)) as unknown as JsonValue;
    case "files.get":
      return { data: toBase64(await host.files.get(id, sanitizeFileName(params.name))) };
    default: {
      const unknown: never = method;
      throw new OgbError("invalid_input", `request.method ${String(unknown)} is unknown`);
    }
  }
}
