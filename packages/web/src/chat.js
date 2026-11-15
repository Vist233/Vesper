// @ts-check
// The conversation as a chat with a person: who said what and when, nothing about how the work was done. Pure: the page
// gives the view model's items and the time, and gets back what to draw. The work itself (tool calls, helpers, wake-ups)
// stays in the journal and the logs.

/** @typedef {import("./model.js").Item} Item */
/**
 * @typedef {{ type: "day", key: string, label: string }
 *   | { type: "msg", key: string, item: Item, side: "in" | "out" | "center", tail: boolean }} ChatEntry
 */

const two = (/** @type {number} */ n) => String(n).padStart(2, "0");
const dayKey = (/** @type {number} */ at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

/** 09:05 */
export function clockTime(/** @type {number} */ at) {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "Today", "Yesterday", a weekday within the week, else "15 Nov 2026" (the year only when it is not this one). */
export function dayLabel(/** @type {number} */ at, /** @type {number} */ now) {
  const days = Math.round((Date.parse(dayKey(now)) - Date.parse(dayKey(at))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(at);
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

/** The time beside a contact: 09:05 today, "Yesterday", a weekday, else a short date. */
export function listTime(/** @type {number} */ at, /** @type {number} */ now) {
  const label = dayLabel(at, now);
  return label === "Today" ? clockTime(at) : label;
}

/** Which side a message sits on; null when the person would not see it in a chat. */
function sideOf(/** @type {Item} */ item) {
  if (item.kind === "user") return "out";
  if (item.kind === "assistant" || item.kind === "say" || item.kind === "question" || item.kind === "approval") return "in";
  if (item.kind === "note") return "center";
  // Text from outside (a mail, a calendar event) is shown, marked; the bot's own wake-ups and the system's signals are not.
  if (item.kind === "signal" && item.trust !== "trusted") return "center";
  return null;
}

/** Messages within this long of each other from the same side form one group (one tail, like a chat app). */
const GROUP_MS = 5 * 60_000;

/**
 * The chat: day separators and messages, each message knowing whether it ends its group (only the last of a group gets
 * the bubble's tail and the time is still on every bubble). `now` decides the day labels.
 * @param {readonly Item[]} items
 * @param {number} now
 * @returns {ChatEntry[]}
 */
export function chatTimeline(items, now) {
  /** @type {ChatEntry[]} */
  const entries = [];
  let lastDay = "";
  for (const item of items) {
    const side = sideOf(item);
    if (!side) continue;
    const day = dayKey(item.at);
    if (day !== lastDay) {
      entries.push({ type: "day", key: `d${day}`, label: dayLabel(item.at, now) });
      lastDay = day;
    }
    entries.push({ type: "msg", key: `i${item.seq}`, item, side, tail: true });
  }
  // A message keeps its tail only when the next one does not continue its group (same side, same day, within five minutes).
  for (let i = 0; i < entries.length - 1; i += 1) {
    const here = entries[i];
    const next = entries[i + 1];
    if (here?.type === "msg" && next?.type === "msg" && here.side === next.side && here.side !== "center" && next.item.at - here.item.at <= GROUP_MS)
      here.tail = false;
  }
  return entries;
}

/**
 * The line under the bot's name, as for a person: typing while it works, waiting when it asked you something, the screen
 * when you have it, else when it was last active.
 * @param {{ run: string, pending: number, takeover: boolean, lastAt: number | null }} bot
 * @param {number} now
 */
export function presence(bot, now) {
  if (bot.takeover) return "you have the screen";
  if (bot.pending > 0) return "waiting for you";
  if (bot.run === "active" || bot.run === "starting") return "typing…";
  if (bot.lastAt === null) return "";
  const label = dayLabel(bot.lastAt, now);
  return `last seen ${label === "Today" ? "today" : label === "Yesterday" ? "yesterday" : label} at ${clockTime(bot.lastAt)}`;
}

/** The preview under a contact's name: what it is doing as a person would show it, else its last message. */
export function preview(
  /** @type {{ last?: { at: number, who: "person" | "bot", text: string }, summary?: string }} */ bot,
  /** @type {"needs" | "error" | "working" | "idle"} */ status,
) {
  if (status === "needs") return { text: "waiting for you", tone: "needs" };
  if (status === "working") return { text: "typing…", tone: "live" };
  const last = bot.last;
  if (!last) return { text: bot.summary ?? "No messages yet", tone: "" };
  const line = last.text.replace(/\s+/g, " ").trim();
  return { text: last.who === "person" ? `You: ${line}` : line, tone: "" };
}
