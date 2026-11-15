import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StartupLine } from "@vesper/contracts";
import { workspaceEnvironment } from "@vesper/session-runtime";

/** Where the image keeps the owner's desktop kit (a vendored copy); the same path the computer plugin defaults to. */
const KIT_OBSERVE = ["image", "vendor", "sandbox-tools", "desktop", "refagent-tools", "tools", "observe.py"];
const WORKER = "sakura-browser-worker";

export interface BackendReport {
  worker: boolean;
  kit: boolean;
  lines: StartupLine[];
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Looks, without starting anything, for the programs the real browser and desktop backends call, so the start-up line can say
 * what will not work. Commands run for a workspace get a fixed PATH, so that is the PATH searched for the worker.
 */
export function checkBackends(appRoot: string, options: { searchPath?: string } = {}): BackendReport {
  // The search path is a parameter so that tests do not depend on what is installed on the machine they run on.
  const path = options.searchPath ?? workspaceEnvironment({ workspaceId: "check", filesDir: appRoot }).PATH ?? "";
  const worker = path
    .split(":")
    .filter(Boolean)
    .some((dir) => isExecutableFile(join(dir, WORKER)));
  const kit = existsSync(join(appRoot, ...KIT_OBSERVE));
  return {
    worker,
    kit,
    lines: [
      worker
        ? { level: "info", text: `browser tool: ${WORKER} found` }
        : {
            level: "warn",
            text: `browser tool: ${WORKER} is not installed in this image, so the browser tool will answer with an error (agent-browser alone is not enough)`,
          },
      kit
        ? { level: "info", text: "desktop tool: the desktop kit is present" }
        : { level: "warn", text: "desktop tool: the desktop kit is missing, so the desktop tool will answer with an error" },
      // Only where the kit is used: without the accessibility bus the desktop tool can click and type but cannot read the interface.
      ...(kit ? [{ level: "info" as const, text: "desktop accessibility bus: not started (the desktop tool cannot read the interface by name yet)" }] : []),
    ],
  };
}
