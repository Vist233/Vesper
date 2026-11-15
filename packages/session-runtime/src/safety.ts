import type { SafetyPlugin } from "@vesper/profiles";
import { type LlmClient, type Plugin, redactionPlugin, reviewPlugin } from "sakura-agent";

/**
 * The framework's own review and redaction plugins, wired as the safety floor says. Redaction wraps the reviewer's
 * model too, because the reviewer's requests do not pass the agent's own hook. Order: redaction first.
 */
export function defaultSafetyPlugins(floor: readonly SafetyPlugin[], llm: LlmClient): Plugin[] {
  const plugins: Plugin[] = [];
  const redaction = floor.includes("redaction") ? redactionPlugin() : undefined;
  if (redaction) plugins.push(redaction);
  if (floor.includes("review")) plugins.push(reviewPlugin({ llm: redaction ? redaction.wrap(llm) : llm }));
  return plugins;
}
