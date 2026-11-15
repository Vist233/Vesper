// @ts-check
// Small pure helpers for text: plain-text rendering with fenced code kept apart, durations, hosts, titles.

/** @typedef {{ type: "text" | "code", text: string, lang: string }} Segment */

/**
 * Splits agent text into plain text and fenced code blocks (``` ... ```). No markdown beyond that: the text parts are shown
 * as they are with their line breaks. Never throws; an unterminated fence runs to the end of the text; joining the parts
 * with the fences put back gives the original text.
 * @param {string} text
 * @returns {Segment[]}
 */
export function splitFences(text) {
  /** @type {Segment[]} */
  const segments = [];
  const source = typeof text === "string" ? text : "";
  const fence = /^```[ \t]*([^\n`]*)\n?/gm;
  let position = 0;
  /** @type {RegExpExecArray | null} */
  let open = null;
  /** @type {RegExpExecArray | null} */
  let match = fence.exec(source);
  while (match !== null) {
    if (open === null) {
      if (match.index > position) segments.push({ type: "text", text: source.slice(position, match.index), lang: "" });
      open = match;
      position = match.index + match[0].length;
    } else {
      segments.push({ type: "code", text: source.slice(position, match.index).replace(/\n$/, ""), lang: (open[1] ?? "").trim() });
      open = null;
      position = match.index + match[0].length;
    }
    match = fence.exec(source);
  }
  if (open !== null) segments.push({ type: "code", text: source.slice(position).replace(/\n$/, ""), lang: (open[1] ?? "").trim() });
  else if (position < source.length) segments.push({ type: "text", text: source.slice(position), lang: "" });
  return segments;
}

/** "40 s", "2 min 5 s", "under a second". */
export function fmtDuration(/** @type {number} */ ms) {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 1) return "under a second";
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** The host of a URL for a short label, or the text itself (cut) when it is not a URL. */
export function hostOf(/** @type {string} */ target) {
  if (!target) return "";
  try {
    const url = new URL(target);
    return url.hostname || target.slice(0, 60);
  } catch {
    return target.length > 60 ? `${target.slice(0, 57)}...` : target;
  }
}

const KEYSYM_RETURN = 0xff0d;
const KEYSYM_TAB = 0xff09;

/**
 * The key symbols that type `text` on an X desktop: printable ASCII is its own code point, newline is Return, tab is Tab,
 * every other character is `0x01000000 + code point` (the Unicode keysym range), and an emoji in two UTF-16 halves counts
 * as one character. Other control characters are dropped; "\r\n" is one Return.
 * @param {string} text
 * @returns {number[]}
 */
export function textToKeysyms(text) {
  /** @type {number[]} */
  const keysyms = [];
  const source = typeof text === "string" ? text : "";
  for (const char of source) {
    const code = /** @type {number} */ (char.codePointAt(0));
    if (code === 0x0a) keysyms.push(KEYSYM_RETURN);
    else if (code === 0x0d) {
      if (!source.includes("\r\n")) keysyms.push(KEYSYM_RETURN);
    } else if (code === 0x09) keysyms.push(KEYSYM_TAB);
    else if (code >= 0x20 && code <= 0x7e) keysyms.push(code);
    else if (code >= 0xa0) keysyms.push(0x01000000 + code);
  }
  return keysyms;
}

/**
 * The start-up report lines worth showing: warnings only. A line is `{ level, text }`; a plain string (the older shape)
 * counts as a warning, because it cannot say it is only information. Information lines are not shown at all.
 * @param {unknown} lines
 * @returns {string[]}
 */
export function startupWarnings(lines) {
  if (!Array.isArray(lines)) return [];
  /** @type {string[]} */
  const warnings = [];
  for (const line of lines) {
    if (typeof line === "string") {
      if (line.trim()) warnings.push(line);
    } else if (line && typeof line === "object" && /** @type {any} */ (line).level === "warn" && typeof (/** @type {any} */ (line).text) === "string") {
      warnings.push(/** @type {any} */ (line).text);
    }
  }
  return warnings;
}

/** True when the text has a character outside ASCII (Chinese, emoji, accents): the keyboard path cannot carry it, so the whole text goes through the page-input route. */
export function needsInsert(/** @type {string} */ text) {
  for (const char of typeof text === "string" ? text : "") if ((char.codePointAt(0) ?? 0) > 0x7f) return true;
  return false;
}

/** The greeting of the empty state, by the hour of the day (0 to 23). */
export function greeting(/** @type {number} */ hour) {
  const h = Number.isInteger(hour) ? hour : 12;
  if (h >= 5 && h < 12) return "Good morning.";
  if (h >= 12 && h < 18) return "Good afternoon.";
  return "Good evening.";
}

/** "812 B", "1.4 KB", "25 MB". */
export function formatBytes(/** @type {number} */ bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" for the Files list. */
export function ago(/** @type {number} */ then, /** @type {number} */ now) {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (!Number.isFinite(seconds) || seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  const days = Math.round(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
