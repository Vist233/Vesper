// Stands in for x11vnc: a TCP server that greets like a VNC server and then echoes what it receives.
import { createServer } from "node:net";

const port = Number(process.argv[process.argv.indexOf("-rfbport") + 1]);
createServer((socket) => {
  socket.write("RFB 003.008\n");
  socket.on("data", (chunk) => socket.write(chunk));
  socket.on("error", () => {});
}).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
