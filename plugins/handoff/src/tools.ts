import type { PluginContext } from "@vesper/contracts";
import type { Tool } from "sakura-agent";
import { createHandoffPort } from "./adapter.ts";
import { secretReview } from "./secret-scan.ts";
import { createHandoffTool } from "./tool.ts";

/** Entry of the plugin (bundled to dist/tools.js). One store for all sessions; this agent's directory and id are passed per handle. */
export function createTools(ctx: PluginContext): Tool[] {
  const port = createHandoffPort({
    storeRoot: ctx.sharedDataDir,
    workDir: ctx.workspace.filesDir,
    agentId: ctx.workspace.workspaceId,
    hooks: { review: secretReview },
  });
  return [createHandoffTool({ port, workDir: ctx.workspace.filesDir })];
}
