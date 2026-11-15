import type { HelperRunner } from "@vesper/contracts";
import type { Tool, ToolResult } from "sakura-agent";
import type { DesktopBackend } from "./backend.ts";
import { createDesktopTool } from "./desktop-tool.ts";
import { DisplayLease } from "./lease.ts";

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

const MIN_REASON_LENGTH = 20;

export const HELPER_INSTRUCTIONS = `You operate a desktop for another agent. You have one tool, \`desktop\`. Read the accessibility tree first (action "tree") and act on elements by their ref; take a screenshot only when the tree is not enough to decide. Do exactly the task you were given, nothing else. When you are done, or you cannot do it, reply with a short report in words: what you did, what the screen shows now, and anything that went wrong. Never enter a password or a one-time code you were not given in the task; if the screen asks for one, stop and say so.`;

export interface ComputerToolOptions {
  backend: DesktopBackend;
  helpers: HelperRunner;
  maxTurns?: number;
}

/**
 * `computer` is a front for a helper agent. The desktop tool exists only inside the helper's run, so its screenshots and
 * trees fill the helper's context and never the main agent's, and the main agent must say why nothing cheaper works.
 * A display has one lease: a second call while a helper is working is refused with a message to try again later.
 */
export function createComputerTool(options: ComputerToolOptions): Tool {
  const lease = new DisplayLease();
  let calls = 0;
  return {
    name: "computer",
    description:
      "Hands a task on the desktop (pointer, keyboard, any program) to a helper agent and returns its report. The most expensive channel: use it only when a command, an API and the browser cannot do the job. You must give 'why_not_cheaper'. Describe the whole task and what done looks like.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The whole task, with everything the helper needs and what done looks like" },
        why_not_cheaper: { type: "string", description: "Why a command, an API or the browser cannot do this" },
      },
      required: ["task", "why_not_cheaper"],
    },
    effect: "exec",
    replay: "never",
    async execute(args, context) {
      const input = (typeof args === "object" && args !== null ? args : {}) as { task?: unknown; why_not_cheaper?: unknown };
      if (typeof input.task !== "string" || input.task.trim() === "") return text("'task' must say what to do on the desktop.", true);
      if (typeof input.why_not_cheaper !== "string" || input.why_not_cheaper.trim().length < MIN_REASON_LENGTH) {
        return text("'why_not_cheaper' is required: explain in a sentence why a command, an API or the browser cannot do this. Try those first.", true);
      }
      const release = lease.acquire(`call-${++calls}`);
      if (!release) return text("The desktop is being used by another helper. Wait for it to finish and try again.", true);
      try {
        const result = await options.helpers.run({
          instructions: HELPER_INSTRUCTIONS,
          task: input.task,
          tools: [createDesktopTool(options.backend)],
          maxTurns: options.maxTurns ?? 30,
          signal: context.signal,
        });
        const report = result.text.trim() === "" ? "(the helper gave no report)" : result.text;
        return result.reason === "done" ? text(report) : text(`The helper stopped early (${result.reason}). ${report}`, true);
      } catch (error) {
        return text(`The helper failed: ${error instanceof Error ? error.message : String(error)}`, true);
      } finally {
        release();
      }
    },
  };
}
