import type { Tool } from "sakura-agent";
import { INNER_SUFFIX } from "./events.ts";
import { text } from "./tool-result.ts";

/** What the review plugin offers for calls that do not pass through the loop's own hook (see `ReviewPlugin.authorize`). */
export type Authorize = (
  call: { id: string; name: string; args: unknown },
  context: { log: unknown; signal: AbortSignal; tool(name: string): Tool | undefined; cwd?: string },
) => Promise<{ kind: "allow" } | { kind: "deny"; reason: string }>;

const WORD = /[a-z0-9]+/g;
const words = (value: string): string[] => value.toLowerCase().match(WORD) ?? [];

/** Name matches count more than description matches; a name that is a whole word of the query counts most. */
export function rankTools(catalog: readonly Tool[], query: string): Tool[] {
  const wanted = words(query);
  return catalog
    .map((tool) => {
      const nameWords = words(tool.name);
      const descriptionWords = new Set(words(tool.description));
      let score = 0;
      for (const word of wanted) {
        if (nameWords.includes(word)) score += 4;
        else if (tool.name.toLowerCase().includes(word)) score += 2;
        if (descriptionWords.has(word)) score += 1;
      }
      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map((entry) => entry.tool);
}

export interface SearchToolsOptions {
  /** Every tool that can be found and called by name. Tools in it are already wrapped by their approval gate. */
  catalog: readonly Tool[];
  limit?: number;
  /** The review plugin's `authorize`: asked for the INNER call, with the inner tool's own name, arguments and effect. */
  authorize?: Authorize;
}

/**
 * `tool_search` and `tool_call`: the only two tools declared besides the original ones. We write them ourselves because
 * the framework's `tool_call` reaches review as one call named `tool_call` (T5 test `framework-review`): the reviewer
 * model can read the inner name and arguments inside its arguments, but the call is judged and recorded as an `exec` tool
 * called `tool_call`. Here the inner call is reviewed under its own name and effect, through `authorize`, which is how the
 * framework's own code mode reviews calls from scripts. The loop's review is told to skip `tool_call` (`exempt`) so a call
 * is reviewed once.
 */
export function createSearchTools(options: SearchToolsOptions): Tool[] {
  const limit = options.limit ?? 5;
  const byName = new Map(options.catalog.map((tool) => [tool.name, tool]));
  const search: Tool = {
    name: "tool_search",
    description:
      "Finds tools that are not listed in your tool set. Describe what you need in a few words. Returns the best matches with their descriptions and parameters; run one with tool_call.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What you want to do" } }, required: ["query"] },
    effect: "read",
    async execute(args) {
      const query = typeof (args as { query?: unknown } | null)?.query === "string" ? (args as { query: string }).query : "";
      if (query.trim() === "") return text("'query' must be a non-empty string.", true);
      const found = rankTools(options.catalog, query).slice(0, limit);
      if (found.length === 0) return text(`No tool matches '${query}'. Try other words.`);
      return text(found.map((tool) => `${tool.name}: ${tool.description}\nparameters: ${JSON.stringify(tool.parameters)}`).join("\n\n"));
    },
  };
  const call: Tool = {
    name: "tool_call",
    description: "Runs a tool found with tool_search. 'name' is the tool's name and 'args' are its arguments, as its parameters describe.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Name of the tool" }, args: { type: "object", description: "Arguments for the tool" } },
      required: ["name"],
    },
    effect: "exec",
    replay: "never",
    async execute(args, context) {
      const input = (typeof args === "object" && args !== null ? args : {}) as { name?: unknown; args?: unknown };
      if (typeof input.name !== "string") return text("'name' must be a string.", true);
      const tool = byName.get(input.name);
      if (!tool) return text(`There is no tool named '${input.name}'. Use tool_search to find one.`, true);
      const innerArgs = input.args ?? {};
      if (options.authorize) {
        const decision = await options.authorize(
          { id: `${context.callId}${INNER_SUFFIX}`, name: tool.name, args: innerArgs },
          {
            log: context.log,
            signal: context.signal,
            tool: (wanted) => byName.get(wanted),
            ...(context.env?.cwd !== undefined ? { cwd: context.env.cwd } : {}),
          },
        );
        if (decision.kind === "deny") return { ...text(`Not allowed: ${decision.reason}`, true), details: { outcome: "refused" } };
      }
      return tool.execute(innerArgs, context);
    },
  };
  return [search, call];
}
