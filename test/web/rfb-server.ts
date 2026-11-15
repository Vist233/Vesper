import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

export interface FakeDesktop {
  port: number;
  token: string;
  /** Messages the page's viewer sent, by RFB type number (4 key, 5 pointer, 6 cut text), so a test can see what reached the desktop. */
  readonly received: { type: number }[];
  readonly origins: (string | undefined)[];
  /** Connections that completed the RFB handshake and are open now. */
  clients(): number;
  /** Total WebSocket connections that were accepted, ever. */
  readonly accepted: { count: number };
  stop(): Promise<void>;
}

const WIDTH = 320;
const HEIGHT = 200;

function wsFrame(payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x82, length]) : length < 65536 ? Buffer.from([0x82, 126, length >> 8, length & 255]) : Buffer.alloc(10);
  if (length >= 65536) {
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Reads masked client WebSocket frames from a growing buffer; returns the payloads and what is left. */
function unframe(buffer: Buffer): { messages: Buffer[]; rest: Buffer; closed: boolean } {
  const messages: Buffer[] = [];
  let closed = false;
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = (buffer[offset] ?? 0) & 15;
    let length = (buffer[offset + 1] ?? 0) & 127;
    let at = offset + 2;
    if (length === 126) {
      if (buffer.length < at + 2) break;
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      if (buffer.length < at + 8) break;
      length = Number(buffer.readBigUInt64BE(at));
      at += 8;
    }
    if (buffer.length < at + 4 + length) break;
    const mask = buffer.subarray(at, at + 4);
    const body = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((b, i) => b ^ (mask[i % 4] ?? 0)));
    if (opcode === 2 || opcode === 0) messages.push(body);
    if (opcode === 8) closed = true; // the viewer closes: answer like the daemon's bridge does
    offset = at + 4 + length;
  }
  return { messages, rest: buffer.subarray(offset), closed };
}

/** A gradient with a diagonal stripe, so a test can tell that the canvas shows something that is not one colour. */
function pixels(): Buffer {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const stripe = (x + y) % 40 < 6;
      data[i] = stripe ? 255 : (y * 255) / HEIGHT; // blue
      data[i + 1] = stripe ? 255 : (x * 255) / WIDTH; // green
      data[i + 2] = stripe ? 255 : 90; // red
    }
  return data;
}

/**
 * A stand-in for the desk-daemon's stream: a real WebSocket handshake and the RFB protocol (version 3.8, no security, one
 * raw rectangle), enough for noVNC to connect and show a picture. It requires a `token` query parameter, accepts only
 * loopback origins like the daemon's bridge, and records every key, pointer and clipboard message it receives.
 */
export async function startFakeDesktop(token = "daemon-token"): Promise<FakeDesktop> {
  const sockets = new Set<Socket>();
  const received: { type: number }[] = [];
  const origins: (string | undefined)[] = [];
  const accepted = { count: 0 };
  let ready = 0;
  const server: Server = createServer((_req, res) => res.writeHead(426).end());
  server.on("upgrade", (req, rawSocket) => {
    const socket = rawSocket as Socket;
    origins.push(req.headers.origin);
    const okOrigin = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin ?? "");
    if (!okOrigin || new URL(req.url ?? "/", "http://x").searchParams.get("token") !== token)
      return void socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    accepted.count += 1;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const protocol = String(req.headers["sec-websocket-protocol"] ?? "").includes("binary") ? "Sec-WebSocket-Protocol: binary\r\n" : "";
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol}\r\n`);
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (state === "running") ready -= 1;
    });
    socket.on("error", () => {});
    const send = (data: Buffer) => socket.write(wsFrame(data));

    let state: "version" | "security" | "init" | "running" = "version";
    let pending: Buffer = Buffer.alloc(0);
    send(Buffer.from("RFB 003.008\n"));
    const take = (n: number): Buffer | null => {
      if (pending.length < n) return null;
      const out = pending.subarray(0, n);
      pending = pending.subarray(n);
      return out;
    };
    const pump = () => {
      for (;;) {
        if (state === "version") {
          if (!take(12)) return;
          send(Buffer.from([1, 1])); // one security type: None
          state = "security";
        } else if (state === "security") {
          if (!take(1)) return;
          send(Buffer.alloc(4)); // SecurityResult: OK
          state = "init";
        } else if (state === "init") {
          if (!take(1)) return;
          const name = Buffer.from("fake desktop");
          const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(WIDTH, 0);
          init.writeUInt16BE(HEIGHT, 2);
          init.set([32, 24, 0, 1], 4); // bpp, depth, big-endian, true colour
          init.writeUInt16BE(255, 8);
          init.writeUInt16BE(255, 10);
          init.writeUInt16BE(255, 12);
          init.set([16, 8, 0], 14); // shifts: red 16, green 8, blue 0
          init.writeUInt32BE(name.length, 20);
          init.set(name, 24);
          send(init);
          state = "running";
          ready += 1;
        } else {
          const type = pending[0];
          if (type === undefined) return;
          let length: number;
          if (type === 0) length = 20;
          else if (type === 2) length = pending.length >= 4 ? 4 + 4 * pending.readUInt16BE(2) : Number.POSITIVE_INFINITY;
          else if (type === 3) length = 10;
          else if (type === 4) length = 8;
          else if (type === 5) length = 6;
          else if (type === 6) length = pending.length >= 8 ? 8 + pending.readUInt32BE(4) : Number.POSITIVE_INFINITY;
          else {
            received.push({ type });
            socket.destroy(); // an unknown message type: close, as the daemon's view filter does
            return;
          }
          const incremental = type === 3 && pending[1] === 1;
          if (!take(length)) return;
          if (type !== 3) received.push({ type }); // update requests come many times a second; the tests look at input
          if (incremental) {
            // Nothing changed: a real server answers when the screen changes; an immediate full frame would make the
            // viewer ask again at once, a busy loop that starves the test browser.
            const header = Buffer.alloc(4);
            setTimeout(() => {
              if (!socket.destroyed) send(header); // FramebufferUpdate with no rectangles
            }, 200);
          } else if (type === 3) {
            const header = Buffer.alloc(16);
            header[0] = 0; // FramebufferUpdate
            header.writeUInt16BE(1, 2); // one rectangle
            header.writeUInt16BE(WIDTH, 8);
            header.writeUInt16BE(HEIGHT, 10);
            send(Buffer.concat([header, pixels()]));
          }
        }
      }
    };
    let raw: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      const { messages, rest, closed } = unframe(raw);
      raw = rest;
      if (closed) {
        socket.end(Buffer.from([0x88, 0])); // a close frame back, then the connection ends
        return;
      }
      for (const message of messages) pending = Buffer.concat([pending, message]);
      pump();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    port: address.port,
    token,
    received,
    origins,
    accepted,
    clients: () => ready,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
