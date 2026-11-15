import { mkdir } from "node:fs/promises";
import { createHandoff, type Hooks } from "step-by-step-handoff-mcp/core";
import type { HandoffPort } from "./port.ts";

export interface AdapterOptions {
  /** The store all sessions of the box share. */
  storeRoot: string;
  /** This agent's files directory; pulls land in `<workDir>/.exchange/`. */
  workDir: string;
  /** Recorded as the author of what this agent publishes. */
  agentId: string;
  hooks?: Partial<Hooks>;
}

/** The one place that imports `step-by-step-handoff-mcp/core`. */
export function createHandoffPort(options: AdapterOptions): HandoffPort {
  const handoff = createHandoff({
    storeRoot: options.storeRoot,
    workDir: options.workDir,
    agentId: options.agentId,
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  const ready = mkdir(options.storeRoot, { recursive: true });
  return {
    async search(query, limit) {
      await ready;
      return handoff.search({ query, ...(limit !== undefined ? { limit } : {}) });
    },
    async peek(id, path) {
      await ready;
      return { ...(await handoff.peek({ id, path })) };
    },
    async pull(id, verify) {
      await ready;
      return { ...(await handoff.pull({ id, verify })) };
    },
    async publish(source) {
      await ready;
      return handoff.publish(source);
    },
  };
}
