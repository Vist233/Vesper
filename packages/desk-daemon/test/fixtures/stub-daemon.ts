// The daemon wired to the stub programs, as a separate process, so a test can kill it hard.
import { DeskHost } from "../../src/host.ts";
import { serveWorkspaceHost } from "../../src/server.ts";
import { stubConfig } from "../../src/testing/stub-config.ts";

const [dataDir, socketPath, x11Dir] = process.argv.slice(2) as [string, string, string];
const host = new DeskHost(stubConfig({ dataDir, socketPath, x11Dir }, { portShift: 1000 }), {
  info: () => {},
  warn: () => {},
  error: () => {},
});
await serveWorkspaceHost(host, { socketPath });
console.log("ready");
