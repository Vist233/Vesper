import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { HttpFailure } from "./http.ts";

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** `host:port` or `[::1]:port` to the name without the port, lower-cased. Returns undefined for anything odd. */
function hostName(hostHeader: string | undefined): string | undefined {
  if (!hostHeader || hostHeader.length > 255) return undefined;
  const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(hostHeader);
  return match?.[1]?.toLowerCase();
}

export interface GuardOptions {
  extraHosts: readonly string[];
  token: string | undefined;
}

/**
 * The checks every request passes before anything is read or done.
 * - Host: only names we serve. A page on `evil.example` whose DNS answers 127.0.0.1 sends `Host: evil.example` and stops here (DNS rebinding).
 * - Origin: when a browser sends one it must be exactly this server's own origin, so another site, another local port or
 *   `null` cannot make the page's owner's browser call us. A request without Origin (curl, the page's own GET) has no browser behind it.
 *   There are no CORS headers at all: nothing outside this origin may read a response.
 */
export class Guard {
  private readonly hosts: Set<string>;
  private readonly tokenDigest: Buffer | undefined;

  constructor(options: GuardOptions) {
    this.hosts = new Set([...LOOPBACK_NAMES, ...options.extraHosts.map((h) => h.toLowerCase())]);
    this.tokenDigest = options.token ? digest(options.token) : undefined;
  }

  get authRequired(): boolean {
    return this.tokenDigest !== undefined;
  }

  checkHostAndOrigin(headers: IncomingHttpHeaders, options: { originRequired: boolean }): void {
    const name = hostName(headers.host);
    if (!name || !this.hosts.has(name)) throw new HttpFailure(403, "denied", "this Host is not served here");
    const origin = headers.origin;
    if (origin === undefined) {
      if (options.originRequired) throw new HttpFailure(403, "denied", "Origin header is required");
      return;
    }
    // Same-origin means scheme + host + port are the ones the browser used to reach us; the Host header carries host + port.
    if (origin !== `http://${headers.host}` && origin !== `https://${headers.host}`) throw new HttpFailure(403, "denied", "cross-origin request refused");
  }

  checkBearer(headers: IncomingHttpHeaders): void {
    if (!this.tokenDigest) return;
    const match = /^Bearer (.{1,512})$/.exec(headers.authorization ?? "");
    // Comparing digests keeps the comparison constant-time whatever the length of the guess.
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), this.tokenDigest)) throw new HttpFailure(401, "denied", "a valid bearer token is required");
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isLoopbackAddress(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
