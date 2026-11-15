import { parseProfileConfig } from "../config.ts";
import type { ProfileConfig } from "../types.ts";

/** A small valid config with two profiles, for tests of modules that need profiles. */
export function sampleProfileConfig(): ProfileConfig {
  return parseProfileConfig({
    default: "general",
    profiles: {
      general: {
        description: "Everyday work: the original tools, the browser and handoff.",
        plugins: ["handoff", "browser"],
        optionalPlugins: ["computer", "mail-sim"],
        model: "main",
        alwaysDeclaredTools: [],
        settings: { quietByDefault: true },
      },
      minimal: { plugins: [] },
    },
  });
}
