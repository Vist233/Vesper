// Stands in for openbox: stays up while the X socket accepts connections, exits when it does not (like a lost X connection).
import { connect } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const path = join(process.env.OGB_X11_DIR, `X${process.env.DISPLAY.slice(1)}`);
const check = () => {
  const socket = connect(path);
  socket.on("connect", () => socket.destroy());
  socket.on("error", () => process.exit(1));
};
writeFileSync(join(process.env.OGB_X11_DIR, `openbox-${process.env.DISPLAY.slice(1)}.pid`), String(process.pid)); // lets tests find it
check();
setInterval(check, 100);
process.on("SIGTERM", () => process.exit(0));
