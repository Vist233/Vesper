// @ts-check
// What the conversation column shows, as pure functions of the view model: folding tool calls into one activity line,
// the words of that line, the cards that need the person, whether the desk should open by itself, and the rail's dot.

import { fmtDuration, hostOf } from "./text.js";

/**
 * @typedef {import("./model.js").Item} Item
 * @typedef {Extract<Item, { kind: "tool" }>} ToolItem
 * @typedef {{ type: "item", key: string, item: Item } | { type: "activity", key: string, tools: ToolItem[] }} Block
 */

/**
 * Tool calls between two other items become ONE block; everything else stays as it is. A block's key is the `seq` of its
 * first item, so a block that grows keeps its key and the renderer updates it instead of building a new one.
 * @param {readonly Item[]} items
 * @returns {Block[]}
 */
export function groupTimeline(items) {
  /** @type {Block[]} */
  const blocks = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      blocks.push({ type: "item", key: `i${item.seq}`, item });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.type === "activity") last.tools.push(item);
    else blocks.push({ type: "activity", key: `g${item.seq}`, tools: [item] });
  }
  return blocks;
}

const PREFIX = /** @type {Record<string, string>} */ ({
  browser: "Browsing",
  computer: "Using the desktop",
  bash: "Running a command",
  read: "Reading files",
  write: "Writing files",
  edit: "Editing files",
  delegate: "Asking a helper",
  tool_search: "Looking for a tool",
  handoff: "Handing work over",
  send_to_user: "Writing to you",
  ask_human: "Asking you",
});

const VERB = /** @type {Record<string, string>} */ ({
  open: "opening",
  navigate: "going to",
  snapshot: "reading the page",
  click: "clicking",
  type: "typing",
  fill: "typing",
  screenshot: "taking a screenshot",
  scroll: "scrolling",
  close: "closing",
  tabs: "listing tabs",
  read: "reading",
  write: "writing",
  run: "running",
  search: "searching",
});

/**
 * The words for one call: `prefix` for the folded line while it runs, `verb` and `target` for the row inside.
 * @param {{ name: string, action: string, target: string }} tool
 */
export function toolLabel(tool) {
  const name = tool.name === "?" || tool.name === "tool_call" ? "tool" : tool.name;
  const prefix = PREFIX[name] ?? (name === "tool" ? "Working" : `Using ${name}`);
  const verb = VERB[tool.action] ?? (tool.action ? tool.action : "working");
  const target = hostOf(tool.target);
  return { prefix, verb, target, text: target ? `${prefix} · ${verb} ${target}` : `${prefix} · ${verb}` };
}

/**
 * The quiet line of one block of tool calls. While a call runs: "Browsing: opening example.com". Afterwards:
 * "Worked 40 s · 7 steps". Refusals and failures are not counted here (the agent deals with them; the logs keep them).
 * Durations come from the journal's own times, so a reload shows the same numbers.
 * @param {readonly ToolItem[]} tools
 */
export function activitySummary(tools) {
  const steps = tools.length;
  const running = tools.filter((tool) => tool.outcome === "running");
  const waiting = tools.filter((tool) => tool.outcome === "needs_approval").length;
  const started = tools.length ? Math.min(...tools.map((tool) => tool.at)) : 0;
  const ended = tools.length ? Math.max(...tools.map((tool) => tool.endAt || tool.at)) : 0;
  const durationMs = Math.max(0, ended - started);
  const current = running.at(-1);
  const label = current ? toolLabel(current.tool).text : `Worked ${fmtDuration(durationMs)} · ${steps} ${steps === 1 ? "step" : "steps"}`;
  return { running: running.length > 0, label, steps, durationMs, waiting };
}

/**
 * What waits for the person: unanswered questions and undecided approvals, oldest first. Expired approvals are not in
 * the list (the page shows them disabled, in place, but nothing is asked of the person).
 * @param {{ items: readonly Item[] }} state
 */
export function needsYou(state) {
  return state.items.filter((item) => (item.kind === "question" && !item.answered) || (item.kind === "approval" && item.status === "pending"));
}

/** Restore an active take-over. Otherwise a recent browser action or open login question highlights the Desk button.
 * @param {{ items: readonly Item[], takeover: unknown, deskTrigger: import("./model.js").DeskTrigger | null }} state
 * @param {number} now
 * @param {number} [recentMs]
 * @returns {{ intent: "stage" | "light-chip", key: number } | null}
 */
export function deskIntent(state, now, recentMs = 30_000) {
  if (state.takeover) return { intent: "stage", key: -1 };
  const question = state.items.findLast((item) => item.kind === "question" && item.ask === "login" && !item.answered);
  if (question) return { intent: "light-chip", key: question.seq };
  const trigger = state.deskTrigger;
  if (trigger?.reason === "browser" && now - trigger.at <= recentMs) return { intent: "light-chip", key: trigger.run || trigger.seq };
  return null;
}

/**
 * The dot in the rail. Needs you beats error beats working beats idle; a take-over counts as needing the person.
 * @param {{ state?: { run: string } | null, pending?: number, lastRunEnd?: string | null, takeover?: boolean }} row
 * @returns {"needs" | "error" | "working" | "idle"}
 */
export function railStatus(row) {
  if ((row.pending ?? 0) > 0 || row.takeover) return "needs";
  if (row.state && row.state.run !== "idle") return "working";
  if (row.lastRunEnd === "error") return "error";
  return "idle";
}

/**
 * What the round button of the composer is. While a run goes it is Stop; with text in the box it steers instead (Enter
 * always sends the text, a click has to be able to as well); with nothing to send and nothing to stop it is disabled.
 * While the person is in control of the desktop nothing can be sent: a message would end the hold and let the agent act.
 * @param {boolean} running
 * @param {boolean} hasText
 * @param {boolean} [locked]
 * @returns {{ label: "Send" | "Steer" | "Stop", glyph: string, disabled: boolean, stops: boolean }}
 */
export function composerButton(running, hasText, locked = false) {
  if (locked) return { label: "Send", glyph: "↑", disabled: true, stops: false };
  if (running && !hasText) return { label: "Stop", glyph: "■", disabled: false, stops: true };
  return { label: running ? "Steer" : "Send", glyph: "↑", disabled: !hasText, stops: false };
}

/**
 * The Now line: the one line above the composer that says whether the agent is working, needs the person, has been
 * stopped, or is waiting while the person has the desktop. Pure, so a reload shows the same thing as the stream did.
 * `label` and `detail` are separate so the page can style them; `sinceMs` is how long the run has been going.
 * @param {import("./model.js").ViewState} state
 * @param {number} now
 * @returns {{ tone: "idle" | "working" | "needs" | "control" | "error", label: string, detail: string, sinceMs: number }}
 */
export function nowLine(state, now) {
  if (state.takeover) return { tone: "control", label: "You have control", detail: "the agent is waiting", sinceMs: ageMs(now, state.takeover.since) };
  const waiting = needsYou(state);
  const first = waiting[0];
  if (first) {
    const detail = first.kind === "approval" ? `allow ${first.tool}?` : first.kind === "question" && first.ask === "login" ? "sign in" : "a question";
    return { tone: "needs", label: "Needs you", detail, sinceMs: 0 };
  }
  if (state.run === "active") {
    const sinceMs = state.runStartAt ? ageMs(now, state.runStartAt) : 0;
    const running = state.items.findLast((item) => item.kind === "tool" && item.outcome === "running");
    if (running?.kind === "tool") {
      const label = toolLabel(running.tool);
      return { tone: "working", label: label.prefix, detail: label.target ? `${label.verb} ${label.target}` : label.verb, sinceMs };
    }
    if (state.backFromDesk) return { tone: "working", label: "Back with you", detail: "checking the page", sinceMs };
    return { tone: "working", label: "Thinking", detail: "", sinceMs };
  }
  if (state.lastRunEnd === "error") {
    const note = state.items.findLast((item) => item.kind === "note" && item.level === "error");
    return { tone: "error", label: "Stopped by an error", detail: note?.kind === "note" ? note.text.slice(0, 80) : "", sinceMs: 0 };
  }
  if (state.held) return { tone: "idle", label: "Stopped", detail: "say something to continue", sinceMs: 0 };
  return { tone: "idle", label: "", detail: "", sinceMs: 0 };
}

/** How long ago `since` was, never negative and never NaN (the journal clock and the page clock may disagree). */
function ageMs(/** @type {number} */ now, /** @type {number} */ since) {
  const age = now - since;
  return Number.isFinite(age) ? Math.max(0, age) : 0;
}

/** "0:42", "12:05". */
export function clock(/** @type {number} */ ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The one-line marker the timeline keeps for a question or an approval once its card is pinned above the composer (the card
 * exists once; the timeline only remembers that it happened and, when it is over, how long it took).
 * @param {Item} item
 * @returns {string}
 */
export function questionMarker(item) {
  if (item.kind === "question") {
    const login = item.ask === "login";
    if (!item.answered) return login ? "Asked you to sign in" : "Asked you a question";
    const took = item.answeredAt > item.at ? ` · ${fmtDuration(item.answeredAt - item.at)}` : "";
    return `${login ? "You signed in" : "You answered"}${took}`;
  }
  if (item.kind === "approval") {
    if (item.status === "pending") return `Asked you to allow ${item.tool}`;
    if (item.status === "approved") return `You allowed ${item.tool}`;
    if (item.status === "denied") return `You refused ${item.tool}`;
    return `Expired: ${item.tool}`;
  }
  return "";
}

/** The tab title: the name, with how many things wait for the person in front of it. */
export function titleBadge(/** @type {number} */ count) {
  return Number.isInteger(count) && count > 0 ? `(${count}) Vesper` : "Vesper";
}
