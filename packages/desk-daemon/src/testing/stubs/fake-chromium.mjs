// Stands in for Chromium: needs a live X socket and an unlocked profile, serves /json/version on the debugging port,
// records every start in the profile, and spawns a child that would be orphaned by a careless kill.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const profile = arg("user-data-dir");
const port = Number(arg("remote-debugging-port"));
const xsocket = join(process.env.OGB_X11_DIR, `X${process.env.DISPLAY.slice(1)}`);

mkdirSync(profile, { recursive: true });
if (existsSync(join(profile, "SingletonLock"))) {
  console.error("profile is in use");
  process.exit(1);
}
writeFileSync(join(profile, "SingletonLock"), String(process.pid));
appendFileSync(join(profile, "starts.log"), `${process.pid} ${process.env.DISPLAY} ${process.argv.includes("--no-sandbox")}\n`);
const helper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(join(profile, "helper.pid"), String(helper.pid));

// DevTools: /json/version, /json/list (two pages and a worker) and a WebSocket per page that answers
// Runtime.evaluate("document.hasFocus()") and Input.insertText. The page named in `<profile>/focus` (default "a") has
// focus; every inserted text is appended to `<profile>/inserted.log` as {target, text} (a test stub, never the daemon).
const pageUrl = (id) => `ws://127.0.0.1:${port}/devtools/page/${id}`;
const targets = [
  { id: "a", type: "page", url: "https://a.test/", webSocketDebuggerUrl: pageUrl("a") },
  { id: "w", type: "service_worker", url: "https://a.test/sw.js", webSocketDebuggerUrl: pageUrl("w") },
  { id: "b", type: "page", url: "https://b.test/", webSocketDebuggerUrl: pageUrl("b") },
];
const focused = () => (existsSync(join(profile, "focus")) ? readFileSync(join(profile, "focus"), "utf8").trim() : "a");

const server = createServer((req, res) => {
  if (req.url === "/json/list") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(targets));
  else res.writeHead(req.url === "/json/version" ? 200 : 404).end("{}");
});
server.on("upgrade", (req, socket) => {
  const target = req.url.split("/").pop();
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  const send = (object) => {
    const body = Buffer.from(JSON.stringify(object));
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([head, body]));
  };
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (buffer.length < offset + 4 + length) return;
      const opcode = buffer[0] & 0x0f;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length)).map((b, i) => b ^ mask[i % 4]);
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 8) return socket.end();
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString());
      if (message.method === "Runtime.evaluate") send({ id: message.id, result: { result: { type: "boolean", value: focused() === target } } });
      else if (message.method === "Input.insertText") {
        appendFileSync(join(profile, "inserted.log"), `${JSON.stringify({ target, text: message.params.text })}\n`);
        send({ id: message.id, result: {} });
      } else send({ id: message.id, error: { code: -32601, message: "no such method" } });
    }
  });
});
server.listen(port, "127.0.0.1");

const check = () => {
  const socket = connect(xsocket);
  socket.on("connect", () => socket.destroy());
  socket.on("error", () => process.exit(1));
};
setInterval(check, 100);
process.on("SIGTERM", () => process.exit(0));
