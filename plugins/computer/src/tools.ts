import type { PluginContext } from "@vesper/contracts";
import type { Tool } from "sakura-agent";
import type { DesktopBackend } from "./backend.ts";
import { createFakeDesktop } from "./fake-backend.ts";
import { createGuiKitBackend } from "./gui-kit-backend.ts";
import { createComputerTool } from "./tool.ts";

const NOT_BUILT = "No desktop backend for this display name (expected an X display such as :101).";

function unavailable(): DesktopBackend {
  const fail = async (): Promise<never> => {
    throw new Error(NOT_BUILT);
  };
  return { tree: fail, screenshot: fail, click: fail, drag: fail, type: fail, set: fail, key: fail, scroll: fail };
}

/** Entry of the plugin (bundled to dist/tools.js). A display named `fake:...` gets the in-memory demo desktop. */
export function createTools(ctx: PluginContext): Tool[] {
  const display = ctx.workspace.display;
  if (display === undefined) return [];
  // A real display (":101") gets the owner's gui kit; a `fake:` display gets the in-memory demo desktop.
  const backend = display.startsWith("fake:") ? createFakeDesktop() : /^:\d+$/.test(display) ? createGuiKitBackend({ run: ctx.workspace.run }) : unavailable();
  return [createComputerTool({ backend, helpers: ctx.helpers })];
}
