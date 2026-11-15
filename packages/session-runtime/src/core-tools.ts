import { randomBytes } from "node:crypto";
import type { Tool } from "sakura-agent";
import type { Scheduler } from "./scheduler.ts";
import { text } from "./tool-result.ts";
import type { WorkspaceInfo } from "./types.ts";

const stringArg = (args: unknown, key: string): string | undefined => {
  const value = (args as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

export interface CoreToolServices {
  /** Writes an informational event to the session's journal; the page reads it. */
  announce(type: string, payload: unknown): Promise<void>;
  workspace: WorkspaceInfo;
  sessionId?: string;
  /** The bots' clock; without it there is no `schedule` tool. */
  scheduler?: Scheduler;
}

/**
 * The tools every session has besides the original four and search: speaking to the person, asking them, and describing
 * the workspace. They are found with `tool_search` like any plugin tool. None of them blocks: the person's answer
 * arrives as a message (a signal) and starts or steers a run, which is crash-safe and needs no waiting state.
 */
export function createCoreTools(services: CoreToolServices): Tool[] {
  const sendToUser: Tool = {
    name: "send_to_user",
    description:
      "Tells the person something they must see while you keep working: a problem, a decision, an early result. Your last reply of the run is shown to them anyway, so never repeat it here. Do not narrate each step." +
      (services.sessionId
        ? ` To send a file from the session files directory, include [Download filename](/api/sessions/${services.sessionId}/files/ENCODED_NAME), with the URL-encoded basename.`
        : ""),
    parameters: { type: "object", properties: { text: { type: "string", description: "The message" } }, required: ["text"] },
    effect: "write",
    replay: "never", // a message to the person is not sent twice after a crash
    async execute(args) {
      const message = stringArg(args, "text");
      if (!message) return text("'text' must be a non-empty string.", true);
      await services.announce("agent.message", { text: message });
      return text("Sent.");
    },
  };
  const askHuman: Tool = {
    name: "ask_human",
    description:
      "Asks the person a question and needs their answer: a login, a one-time code, a QR code, a choice, or approval of something unclear. The question is shown to them; their answer arrives later as a message. After asking, stop working on what needs the answer: do other useful work or end your turn.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What you need to know, with everything they need to answer" },
        kind: { type: "string", enum: ["login", "code", "choice", "info"], description: "What sort of help this is (optional)" },
        where: { type: "string", description: "Where the person has to look: the url of the tab, for a login or a code (optional)" },
      },
      required: ["question"],
    },
    effect: "write",
    replay: "never", // asking twice after a crash would show the person two cards
    async execute(args) {
      const question = stringArg(args, "question");
      if (!question) return text("'question' must be a non-empty string.", true);
      const id = `q_${randomBytes(4).toString("hex")}`;
      const kind = stringArg(args, "kind");
      const where = stringArg(args, "where");
      await services.announce("human.question", { id, question, ...(kind ? { kind } : {}), ...(where ? { where } : {}) });
      if (kind === "login" || kind === "code") {
        // The run ends after this turn (the `waiting-for-the-person` plugin reads `details.pause`) and the session is held.
        return {
          ...text(`The person has been asked (question ${id}). Stop now; do not touch the browser until the person answers.`),
          details: { pause: "input" },
        };
      }
      return text(`The person has been asked (question ${id}). Their answer will arrive as a message. Do not wait for it inside this turn.`);
    },
  };
  const workspaceInfo: Tool = {
    name: "workspace_info",
    description: "Describes this session's workspace: its files directory and whether it has a display and a browser.",
    parameters: { type: "object", properties: {} },
    effect: "read",
    async execute() {
      const { workspaceId, filesDir, hasDisplay, hasBrowser } = services.workspace;
      return text(JSON.stringify({ workspaceId, filesDir, hasDisplay, hasBrowser }));
    },
  };
  const tools = [sendToUser, askHuman, workspaceInfo];
  const { scheduler, sessionId } = services;
  if (scheduler && sessionId)
    tools.push({
      name: "schedule",
      description:
        "Wakes you up later in this same conversation, so you can check something or report on your own: add (when, prompt), list, cancel (id). " +
        "when: 'in 30m', 'every 2h', 'daily 07:30' (the box's time zone) or an ISO time. prompt: self-contained, what to do and how to report. " +
        "When a scheduled run has nothing worth telling the person, reply exactly [SILENT].",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "list", "cancel"] },
          when: { type: "string" },
          prompt: { type: "string" },
          id: { type: "string" },
        },
        required: ["action"],
      },
      effect: "write",
      replay: "never",
      async execute(args) {
        const action = stringArg(args, "action");
        try {
          if (action === "list")
            return text(
              JSON.stringify((await scheduler.list(sessionId)).map(({ id, when, prompt, next }) => ({ id, when, prompt, next: new Date(next).toISOString() }))),
            );
          if (action === "cancel") {
            const id = stringArg(args, "id");
            if (!id) return text("'id' is required for cancel.", true);
            return text((await scheduler.cancel(sessionId, id)) ? "Cancelled." : `No job '${id}'.`, true);
          }
          if (action === "add") {
            const when = stringArg(args, "when");
            const prompt = stringArg(args, "prompt");
            if (!when || !prompt) return text("'when' and 'prompt' are required for add.", true);
            const job = await scheduler.add(sessionId, when, prompt);
            await services.announce("schedule.changed", { added: { id: job.id, when: job.when, next: job.next } });
            return text(`Scheduled ${job.id}: next at ${new Date(job.next).toISOString()}.`);
          }
          return text("'action' must be add, list or cancel.", true);
        } catch (error) {
          return text(error instanceof Error ? error.message : String(error), true);
        }
      },
    });
  return tools;
}
