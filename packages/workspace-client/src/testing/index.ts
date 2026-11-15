import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceClient, type WorkspaceClientOptions } from "../client.ts";
import { type HostHarness, workspaceHostContract } from "./contract.ts";
import { createFakeWorkspaceHost, type FakeWorkspaceHost } from "./fake-host.ts";
import { serveWorkspaceHost, type TestSocketServer } from "./serve.ts";

export { createFakeWorkspaceHost, type FakeWorkspaceHost, type HostHarness, serveWorkspaceHost, type TestSocketServer, workspaceHostContract };

/** A fake host served on a Unix socket plus a client connected to it, for tests of the client and of code that uses one. */
export async function createSocketRig(clientOptions: Partial<WorkspaceClientOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ogb-wsc-"));
  const clock = { time: 1_000_000 };
  const fake = createFakeWorkspaceHost({ root: join(root, "ws"), now: () => clock.time });
  const socketPath = join(root, "d.sock");
  const server = await serveWorkspaceHost(fake, socketPath);
  const client = createWorkspaceClient({ socketPath, sleep: async () => {}, ...clientOptions });
  return {
    root,
    fake,
    server,
    client,
    clock,
    socketPath,
    async cleanup() {
      client.close();
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
