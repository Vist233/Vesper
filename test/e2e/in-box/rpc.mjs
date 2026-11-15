// Runs INSIDE the container. Reads one JSON request on stdin, sends it to the desk-daemon socket, prints the response line.
import { connect } from "node:net";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const socket = connect(process.env.OGB_DESK_SOCKET ?? "/run/ogb/desk-daemon.sock");
let received = "";
socket.on("connect", () => socket.write(`${input.trim()}\n`));
socket.on("data", (chunk) => {
  received += chunk;
  if (received.includes("\n")) {
    process.stdout.write(received.split("\n")[0]);
    socket.destroy();
  }
});
socket.on("error", (error) => {
  process.stdout.write(JSON.stringify({ v: 1, id: "x", ok: false, error: { kind: "unavailable", message: String(error.code ?? error.message) } }));
});
