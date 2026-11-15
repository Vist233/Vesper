import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Plugin, Tool } from "sakura-agent";
import { text } from "./tool-result.ts";

/** The person's profile is short on purpose: it is in every bot's prompt (docs/18 section 4; Hermes keeps 1,375 characters). */
export const PERSON_MAX = 1500;

export function readPerson(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function writePerson(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${content.trim()}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * One line added, replaced or removed. Returns the new text, or a sentence saying why not: over the limit the bot must
 * consolidate first (nothing is dropped silently).
 */
export function editPerson(current: string, action: string, line: string, old?: string): { text: string } | { refused: string } {
  const lines = current === "" ? [] : current.split("\n");
  const clean = line.replace(/\s+/g, " ").trim();
  let next: string[];
  if (action === "add") {
    if (clean === "") return { refused: "'line' must say something." };
    next = [...lines, `- ${clean.replace(/^-\s*/, "")}`];
  } else if (action === "replace" || action === "remove") {
    const target = (action === "replace" ? old : line)?.trim();
    if (!target) return { refused: action === "replace" ? "'old' must quote part of the line to replace." : "'line' must quote part of the line to remove." };
    const index = lines.findIndex((candidate) => candidate.includes(target));
    if (index === -1) return { refused: `No line contains "${target}".` };
    next =
      action === "remove" ? lines.filter((_, i) => i !== index) : lines.map((candidate, i) => (i === index ? `- ${clean.replace(/^-\s*/, "")}` : candidate));
  } else return { refused: "'action' must be add, replace or remove." };
  const joined = next.join("\n");
  if (joined.length > PERSON_MAX)
    return { refused: `The profile would be ${joined.length} characters; the limit is ${PERSON_MAX}. Merge or remove lines first.` };
  return { text: joined };
}

let queue: Promise<unknown> = Promise.resolve();

/** `remember_person`: what every bot knows about the person, shared by all bots of the box. */
export function createPersonTool(file: string): Tool {
  return {
    name: "remember_person",
    description:
      "Keeps the profile of the person that every bot of theirs sees: name, role, time zone, how they like to be answered, what to avoid, habits. Use it when you learn something durable about them or they correct you; not for task details, one-off facts or anything secret. Actions: add (line), replace (old: part of the line, line: the new text), remove (line: part of the line).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove"] },
        line: { type: "string" },
        old: { type: "string" },
      },
      required: ["action", "line"],
    },
    effect: "write",
    replay: "never",
    async execute(args) {
      const input = (args ?? {}) as { action?: unknown; line?: unknown; old?: unknown };
      const run = queue.then(() => {
        const result = editPerson(
          readPerson(file),
          String(input.action ?? ""),
          String(input.line ?? ""),
          typeof input.old === "string" ? input.old : undefined,
        );
        if ("refused" in result) return text(result.refused, true);
        writePerson(file, result.text);
        return text("Saved. Every bot sees it from its next run.");
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** Puts the person's profile, as it was when the run started, at the end of the system prompt (a snapshot, like Hermes). */
export function personPlugin(file: string): Plugin {
  let snapshot = "";
  return {
    name: "person-profile",
    setup(api) {
      api.on("request", (request) =>
        snapshot === "" ? undefined : { ...request, system: `${request.system}\n\n# The person (shared by all their bots)\n${snapshot}` },
      );
    },
    async prepare() {
      snapshot = readPerson(file);
    },
  };
}
