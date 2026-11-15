import { OgbError } from "./errors.ts";

/** Most bytes one file of `WorkspaceHost.files` may have. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_NAME_CHARS = 120;

/** A file in a workspace's files directory, as `files.list` and `files.put` report it. */
export interface FileEntry {
  readonly name: string;
  readonly size: number;
  /** Milliseconds since the epoch. */
  readonly modifiedAt: number;
  /** Where the file is inside the sandbox, as the agent's tools and the remote browser's file dialog see it (they share the container with the daemon). */
  readonly path?: string;
}

/**
 * Turns a name from outside (a browser's file name, a header) into one that is safe as a file name in the files
 * directory: the last path segment only, no control characters, no leading dots, at most 120 characters with the
 * extension kept. Throws `invalid_input` when nothing is left. Never quotes the name in the message.
 */
export function sanitizeFileName(raw: unknown): string {
  if (typeof raw !== "string") throw new OgbError("invalid_input", "file name must be a string");
  const lastSegment = raw.split(/[\\/]/).pop() ?? "";
  const printable = [...lastSegment].filter((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code > 31 && code !== 127;
  });
  const cleaned = printable.join("").trim().replace(/^\.+/, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") throw new OgbError("invalid_input", "file name is empty after cleaning");
  const chars = [...cleaned];
  if (chars.length <= MAX_NAME_CHARS) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  return [...cleaned.slice(0, dot > 0 ? dot : cleaned.length)].slice(0, MAX_NAME_CHARS - [...extension].length).join("") + extension;
}

/** The nth variant of a name (`report.pdf` becomes `report-2.pdf`); `n` of 1 is the name itself. Used when a name is taken: nothing is ever overwritten. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/** Base64 without Node's `Buffer`, so the contract stays free of built-ins. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Throws `invalid_input` for text that is not base64. */
export function fromBase64(text: unknown): Uint8Array {
  if (typeof text !== "string") throw new OgbError("invalid_input", "data must be a base64 string");
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new OgbError("invalid_input", "data is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Checks the size of file content for `files.put`. */
export function checkFileBytes(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new OgbError("invalid_input", "file content must be bytes");
  if (bytes.length > MAX_FILE_BYTES) throw new OgbError("invalid_input", `file is larger than ${MAX_FILE_BYTES} bytes`);
  return bytes;
}
