import { type WorkspaceHost, workspaceIdFor } from "@vesper/contracts";
import { runInWorkspace, workspaceEnvironment } from "./run-command.ts";
import type { WorkspaceInfo, WorkspaceProvider } from "./types.ts";

/** Adapts a `WorkspaceHost` (the desk-daemon through `workspace-client`, or a fake) to what the runtime asks for. */
export function createHostWorkspaces(host: WorkspaceHost): WorkspaceProvider {
  return {
    async ensure(sessionId): Promise<WorkspaceInfo> {
      const workspaceId = workspaceIdFor(sessionId);
      const info = await host.ensure({ workspaceId });
      const target = { workspaceId, filesDir: info.filesDir, display: info.display, cdpUrl: info.cdpUrl, appDataDir: info.appDataDir };
      return {
        ...target,
        hasDisplay: true,
        hasBrowser: true,
        environment: workspaceEnvironment(target),
        run: (command, options) => runInWorkspace(target, command, options),
      };
    },
    async destroy(sessionId) {
      await host.destroy(workspaceIdFor(sessionId));
    },
  };
}
