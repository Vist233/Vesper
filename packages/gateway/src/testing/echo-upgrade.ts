import { createServer, type Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";

export interface EchoServer {
  port: number;
  /** The request lines and headers of every handshake received, so tests can see what the gateway forwarded. */
  readonly handshakes: { url: string; headers: IncomingHttpHeaders }[];
  stop(): Promise<void>;
}

/**
 * A stand-in for the stream of `agent-browser` or the take-over bridge: accepts an HTTP upgrade with a bare `101` and then echoes
 * the bytes it receives, prefixed by `echo:`. Real WebSocket framing is not needed to test a relay that only moves bytes.
 * Like `agent-browser`, it refuses any Origin that is not a loopback name with a 403.
 */
export async function startEchoUpgradeServer(options: { requireToken?: string } = {}): Promise<EchoServer> {
  const handshakes: EchoServer["handshakes"] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => {
    res.writeHead(426).end();
  });
  server.on("upgrade", (req, rawSocket) => {
    const socket = rawSocket as Socket;
    handshakes.push({ url: req.url ?? "", headers: req.headers });
    const origin = req.headers.origin;
    const loopbackOrigin = origin === undefined || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
    const tokenOk = options.requireToken === undefined || new URL(req.url ?? "/", "http://x").searchParams.get("token") === options.requireToken;
    if (!loopbackOrigin || !tokenOk) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    handshakes,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy(); // upgraded sockets are no longer HTTP connections
        server.close(() => resolve());
      }),
  };
}
