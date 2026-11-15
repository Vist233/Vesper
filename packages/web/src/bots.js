// @ts-check
// What the page knows about bots that is not in the journal: the six preset stars and the line under a bot's name.

/** The preset stars (docs/18 section 1): id (what the server keeps), name offered with it, and its tint. */
export const STARS = /** @type {const} */ ([
  { id: "vega", name: "Vega", tint: "#5b7fa6" },
  { id: "lyra", name: "Lyra", tint: "#7a86b8" },
  { id: "altair", name: "Altair", tint: "#4f8f94" },
  { id: "polaris", name: "Polaris", tint: "#6c7a89" },
  { id: "rigel", name: "Rigel", tint: "#4a6fd1" },
  { id: "sirius", name: "Sirius", tint: "#8aa4c2" },
]);

/** The star of a bot; an older session without one gets a star picked from its id, so each keeps its own look. */
export function starOf(/** @type {{ id: string, star?: string }} */ bot) {
  const chosen = STARS.find((candidate) => candidate.id === bot.star);
  if (chosen) return chosen;
  let hash = 0;
  for (const char of bot.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return /** @type {(typeof STARS)[number]} */ (STARS[hash % STARS.length]);
}

/** A name for a new bot: the first preset star whose name no bot has yet, then "Vega 2", "Vega 3"... */
export function freshName(/** @type {readonly { title: string }[]} */ bots, /** @type {string} */ preferred = "") {
  const taken = new Set(bots.map((bot) => bot.title.trim().toLowerCase()));
  if (preferred && !taken.has(preferred.toLowerCase())) return preferred;
  if (!preferred) {
    const free = STARS.find((candidate) => !taken.has(candidate.name.toLowerCase()));
    if (free) return free.name;
  }
  const base = preferred || /** @type {string} */ (STARS[0]?.name);
  for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

const STATUS_LINE = { needs: "Needs you", error: "Stopped with an error", working: "Working", idle: "" };

/**
 * The line under a bot's name in the rail: what it waits for, else its task summary, else the next scheduled job.
 * @param {{ summary?: string, next?: string }} bot
 * @param {"needs" | "error" | "working" | "idle"} status
 */
export function botLine(bot, status) {
  if (status === "needs") return STATUS_LINE.needs;
  const next = bot.next ? `next: ${bot.next}` : "";
  return bot.summary || next || STATUS_LINE[status] || "No task yet";
}
