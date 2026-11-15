import type { Plugin } from "sakura-agent";

/**
 * Ends the run after a turn in which a tool asked for the person (`details.pause === "input"`, which `ask_human` sets for a
 * login or a code). The framework reports the run as paused for input; the actor then holds the session until the person writes.
 */
export function waitingForPersonPlugin(): Plugin {
  return {
    name: "waiting-for-person",
    setup(api) {
      let asked = false;
      api.on("tool.after", (_call, result) => {
        if ((result.details as { pause?: unknown } | undefined)?.pause === "input") asked = true;
      });
      api.on("turn.end", () => {
        if (!asked) return;
        asked = false;
        return { pause: "input" };
      });
    },
  };
}
