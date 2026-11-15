// Stands in for Xvfb in tests: creates the X socket file and listens on it. Not part of the shipped daemon.
import { createServer } from "node:net";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const display = process.argv.find((a) => /^:\d+$/.test(a));
if (!display) process.exit(2);
const path = join(process.env.OGB_X11_DIR, `X${display.slice(1)}`);
const server = createServer((socket) => socket.on("error", () => {}));
server.listen(path);
writeFileSync(join(process.env.OGB_X11_DIR, `xvfb-${display.slice(1)}.pid`), String(process.pid)); // lets tests find it
const stop = () => {
  rmSync(path, { force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
