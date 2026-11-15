import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { SECURITY_HEADERS } from "./http.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The page's own rules, enforced by the browser: scripts only from this origin (so injected text cannot run even if it
 * reaches the DOM unescaped), no frames, no plugins. Images may be `data:` or `blob:` for live-view frames.
 */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface StaticFile {
  path: string;
  type: string;
}

/**
 * Maps a URL path to a file under `root`, or undefined. No traversal by construction: the path is decoded once, must not
 * contain NUL, a backslash or a dot segment, no part may start with a dot, and the real path (links resolved) must stay
 * inside the real root, so a link in the directory cannot lead out of it.
 */
export async function resolveStatic(root: string, urlPath: string): Promise<StaticFile | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const parts = decoded.split("/").filter((part) => part !== "");
  if (parts.some((part) => part.startsWith("."))) return undefined;
  const relative = parts.length === 0 || decoded.endsWith("/") ? [...parts, "index.html"] : parts;
  try {
    const realRoot = await realpath(root);
    const real = await realpath(join(realRoot, ...relative));
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
    if (!(await stat(real)).isFile()) return undefined;
    const extension = real.slice(real.lastIndexOf(".")).toLowerCase();
    const type = TYPES[extension];
    return type ? { path: real, type } : undefined; // an unknown extension is not served
  } catch {
    return undefined;
  }
}

export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean> {
  const file = await resolveStatic(root, urlPath);
  if (!file) return false;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": file.type,
    "content-length": (await stat(file.path)).size,
    "cache-control": "no-cache",
    "content-security-policy": PAGE_CSP,
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file.path)
    .on("error", () => res.destroy())
    .pipe(res);
  return true;
}
