// Container health check: the desk-daemon answers on its socket. Exit 0 = healthy, 1 = not.
// The s6 supervisor restarts a dead service by itself; this reports the case where it is up but not answering.
import { connect } from "node:net";

const socketPath = process.env.OGB_DESK_SOCKET ?? "/run/ogb/desk-daemon.sock";
const socket = connect(socketPath);
const fail = (reason) => {
  process.stderr.write(`unhealthy: ${reason}\n`);
  process.exit(1);
};
const timer = setTimeout(() => fail("desk-daemon did not answer in 4 s"), 4000);
socket.once("error", (error) => fail(`cannot reach desk-daemon: ${error.code ?? error.message}`));
socket.once("connect", () => socket.write(`${JSON.stringify({ v: 1, id: "hc", method: "health", params: { workspaceId: "healthcheck" } })}\n`));
let received = "";
socket.on("data", (chunk) => {
  received += chunk;
  if (!received.includes("\n")) return;
  clearTimeout(timer);
  try {
    const response = JSON.parse(received.split("\n")[0]);
    if (response.ok === true) process.exit(0);
    fail(`daemon answered with an error of kind ${response.error?.kind}`);
  } catch {
    fail("daemon answered with something that is not JSON");
  }
});
