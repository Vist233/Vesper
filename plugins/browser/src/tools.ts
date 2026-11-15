import type { PluginContext } from "@vesper/contracts";
import type { Tool } from "sakura-agent";
import type { BrowserBackend } from "./backend.ts";
import { createFakeBrowser } from "./fake-backend.ts";
import { createWorkerBackend } from "./worker-backend.ts";
import { createBrowserTool } from "./tool.ts";

const NOT_BUILT = "No browser backend for this workspace address (expected a loopback http://127.0.0.1:<port> DevTools address).";

function unavailable(): BrowserBackend {
  const fail = async (): Promise<never> => {
    throw new Error(NOT_BUILT);
  };
  return {
    open: fail,
    navigate: fail,
    snapshot: fail,
    click: fail,
    type: fail,
    press: fail,
    readText: fail,
    scroll: fail,
    screenshot: fail,
    evaluate: fail,
    fill: fail,
    check: fail,
    close: fail,
  };
}

/**
 * Entry of the plugin (bundled to dist/tools.js). A workspace whose DevTools address starts with `fake:` gets the in-memory
 * demo browser; a loopback `http://127.0.0.1:<port>` address gets the owner's worker as backend (worker-backend.ts); anything
 * else gets a tool that says so.
 */
export function createTools(ctx: PluginContext): Tool[] {
  const cdpUrl = ctx.workspace.cdpUrl;
  if (cdpUrl === undefined) return [];
  const backend = cdpUrl.startsWith("fake:")
    ? createFakeBrowser({
        "https://example.test/": {
          title: "Example",
          text: "Welcome to the example site.",
          elements: [{ ref: "e1", role: "link", name: "Prices", goto: "https://example.test/prices" }],
        },
        "https://example.test/prices": { title: "Prices", text: "Widget: 10 euros", elements: [] },
      })
    : /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(cdpUrl)
      ? createWorkerBackend({ run: ctx.workspace.run, agentId: ctx.workspace.workspaceId, cdpUrl: cdpUrl.endsWith("/") ? cdpUrl : `${cdpUrl}/` })
      : unavailable();
  return [createBrowserTool({ backend })];
}
