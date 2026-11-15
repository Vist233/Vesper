import { connect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";

/** Only these request headers travel to the other side: what the WebSocket handshake needs and nothing about the person (no cookies, no authorization). */
const FORWARDED = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"] as const;

export interface RelayTarget {
  port: number;
  /** Path and query on the other side, for example `/?token=...`. */
  path: string;
}

/**
 * Hands a WebSocket upgrade to a loopback server and then only moves bytes. The handshake is repeated to the target
 * with a clean header set and an Origin the target accepts (the daemon's bridge takes only loopback origins), and from the
 * `101` on, both sockets are piped into each other, so the gateway needs no WebSocket framing code and cannot get it wrong.
 * What the gateway adds is everything before this call: Host and Origin checks, the ticket, the connection limit.
 */
export function relayUpgrade(
  req: IncomingMessage,
  client: Socket,
  head: Buffer,
  target: RelayTarget,
  hooks: { onClose: () => void; onConnected?: () => void },
  connectTimeoutMs = 5000,
): void {
  const upstream = connect({ host: "127.0.0.1", port: target.port });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    client.destroy();
    upstream.destroy();
    hooks.onClose();
  };
  const timer = setTimeout(finish, connectTimeoutMs);
  timer.unref();
  upstream.once("connect", () => {
    clearTimeout(timer);
    hooks.onConnected?.();
    const lines = [
      `GET ${target.path} HTTP/1.1`,
      `Host: 127.0.0.1:${target.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Origin: http://127.0.0.1:${target.port}`,
    ];
    for (const name of FORWARDED) {
      const value = req.headers[name];
      if (typeof value === "string" && !/[\r\n]/.test(value)) lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", finish);
  client.on("error", finish);
  upstream.on("close", finish);
  // HTTP server sockets stay half-open after the peer's FIN, so a plain pipe would never notice that one side left.
  // The person leaving ends everything at once; the target leaving gives its last bytes a moment to reach the person.
  client.on("end", finish);
  upstream.on("end", () => setTimeout(finish, 2000).unref());
  client.on("close", finish);
}

/** What a client sees when the target is not there: a plain HTTP answer on the upgrade socket, then close. */
export function refuseUpgrade(client: Socket, status: number, reason: string): void {
  const body = JSON.stringify({ error: { message: reason } });
  client.end(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Service Unavailable"}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}
