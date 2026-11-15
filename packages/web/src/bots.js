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

/**
 * The scheduled results the page has not shown yet. `seen` maps a bot to the time of the last notice shown (kept in the
 * browser). A bot seen for the first time with a notice only records it: opening the page must not replay old ones.
 * @param {readonly { id: string, title: string, notice?: { at: number, text: string } }[]} bots
 * @param {Record<string, number>} seen
 * @returns {{ fresh: { id: string, title: string, text: string }[], seen: Record<string, number> }}
 */
export function freshNotices(bots, seen) {
  /** @type {{ id: string, title: string, text: string }[]} */
  const fresh = [];
  /** @type {Record<string, number>} */
  const next = {};
  for (const bot of bots) {
    const at = bot.notice?.at;
    if (at === undefined) {
      next[bot.id] = seen[bot.id] ?? 0; // seen, with nothing to show yet: its first notice will be shown
      continue;
    }
    const last = seen[bot.id];
    if (last !== undefined && at > last && bot.notice) fresh.push({ id: bot.id, title: bot.title, text: bot.notice.text });
    next[bot.id] = Math.max(at, last ?? 0);
  }
  return { fresh, seen: next };
}

/**
 * Which conversation the page opens with: the one the person had open last time if it still exists, else the bot with the
 * latest message (the list is sorted that way), else none (then the page offers a new bot).
 * @param {readonly { id: string }[]} bots
 * @param {string | null} remembered
 */
export function continueWith(bots, remembered) {
  if (remembered && bots.some((bot) => bot.id === remembered)) return remembered;
  return bots[0]?.id ?? null;
}
