import type { HelperRunner } from "@vesper/contracts";
import { textOf } from "./events.ts";
import { type Agent, type AgentConfig, type Environment, limitsPlugin, type LlmClient, type Plugin, type Tool } from "sakura-agent";

export interface HelperRunnerOptions {
  llm: LlmClient;
  cwd: string;
  /** Where the helper's own tools run: the session's workspace shell, like the main agent's. */
  environment?: Environment;
  /** The session's safety plugins: a helper is reviewed and redacted exactly like the main agent. */
  safety: readonly Plugin[];
  createAgent: (config: AgentConfig) => Promise<Agent>;
  log: (entry: Record<string, unknown>) => void;
}

const DEFAULT_TURNS = 30;

export function createHelperRunner(options: HelperRunnerOptions): HelperRunner {
  return {
    async run(spec) {
      const agent = await options.createAgent({
        model: options.llm,
        cwd: options.cwd,
        ...(options.environment ? { environment: options.environment } : {}),
        system: spec.instructions,
        tools: [...(spec.tools as Tool[])],
        plugins: [...options.safety, limitsPlugin({ maxTurns: spec.maxTurns ?? DEFAULT_TURNS })],
        compaction: false,
      });
      const onAbort = () => agent.cancel();
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        let last = "";
        const run = agent.run(spec.task);
        for await (const event of run.events) {
          if (event.type === "message_end" && event.message.role === "assistant") {
            const text = textOf(event.message.content);
            if (text !== "") last = text;
          }
        }
        const result = await run.result;
        if (result.error) options.log({ level: "warn", message: "helper run ended with an error", error: result.error });
        return { reason: result.reason, text: last };
      } finally {
        spec.signal?.removeEventListener("abort", onAbort);
        await agent.close();
      }
    },
  };
}
