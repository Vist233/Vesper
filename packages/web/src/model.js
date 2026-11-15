// @ts-check
import { hostOf } from "./text.js";
// The conversation view model: journal events in, what the page shows out. No DOM, no network, no clock.
//
// Rules the property tests hold it to:
//  - any events in any order (duplicates, gaps, a result before its call, junk payloads) give a valid state and never throw;
//  - an event whose `seq` is not greater than the last one applied is ignored, so a reconnect that repeats a few events
//    gives exactly the state of an uninterrupted stream (replay equals live);
//  - nothing from an event is interpreted as markup: the state holds plain strings, and the renderer uses `textContent`.

/**
 * @typedef {{ v: number, seq: number, at: number, sessionId: string, type: string, payload: any }} SessionEvent
 * @typedef {{ name: string, action: string, target: string }} ToolRef
 * @typedef {{ outcome: string, decidedBy: string, reason: string }} Review
 * @typedef {"running" | "ok" | "error" | "refused" | "needs_approval" | "interrupted"} ToolOutcome
 * @typedef {{ name: string, size: number, path: string }} Attachment
 * @typedef {{ kind: "user", seq: number, at: number, text: string, attachments: Attachment[] }
 *   | { kind: "assistant", seq: number, at: number, text: string }
 *   | { kind: "say", seq: number, at: number, text: string }
 *   | { kind: "signal", seq: number, at: number, source: string, trust: string, text: string }
 *   | { kind: "note", seq: number, at: number, text: string, level: "info" | "error", retryable: boolean }
 *   | { kind: "tool", seq: number, at: number, callId: string, name: string, tool: ToolRef, args: string, outcome: ToolOutcome, endAt: number, output: string, truncated: boolean, review: Review | null }
 *   | { kind: "question", seq: number, at: number, id: string, question: string, ask: string, where: string, answered: boolean, answeredAt: number }
 *   | { kind: "approval", seq: number, at: number, id: string, tool: string, args: string, status: "pending" | "approved" | "denied" | "expired", decidedAt: number }} Item
 * @typedef {{ seq: number, reason: "login" | "browser", at: number, run: number, host: string }} DeskTrigger
 * @typedef {{ lastSeq: number, gaps: number, items: Item[], run: "idle" | "active", lastRunEnd: string, held: boolean, waiting: number,
 *   takeover: { since: number, viewed: boolean } | null, deskTrigger: DeskTrigger | null, runStartAt: number, backFromDesk: boolean, rev: number }} ViewState
 */

const MAX_TEXT = 20_000;
const MAX_ARGS = 2_000;
const BROWSER_TOOLS = new Set(["browser", "computer"]);
const SIGNAL_HEADER = /^\[signal source=(\S+) trust=(\S+) id=(\S+)\]\n?([\s\S]*)$/;

/** @returns {ViewState} */
export function createState() {
  return {
    lastSeq: 0,
    gaps: 0,
    items: [],
    run: "idle",
    lastRunEnd: "",
    held: false,
    waiting: 0,
    takeover: null,
    deskTrigger: null,
    runStartAt: 0,
    backFromDesk: false,
    rev: 0,
    ...hidden(),
  };
}

/** Lookup tables live on the state but are not part of what is compared or shown. */
function hidden() {
  return {
    byCall: /** @type {Map<string, any>} */ (new Map()),
    byQuestion: /** @type {Map<string, any>} */ (new Map()),
    byApproval: /** @type {Map<string, any>} */ (new Map()),
    waitingIds: /** @type {Set<string>} */ (new Set()),
    innerCalls: /** @type {Map<string, any>} */ (new Map()),
  };
}

const isObject = (/** @type {unknown} */ v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (/** @type {unknown} */ v, fallback = "") => (typeof v === "string" ? v : fallback);
const clip = (/** @type {string} */ s, /** @type {number} */ max) => (s.length > max ? s.slice(0, max) : s);

/** The files the runtime says the person attached (`attachments` on the message), cleaned: names and paths as text, sizes as numbers. */
function attachmentsOf(/** @type {any} */ payload) {
  if (!isObject(payload) || !Array.isArray(payload.attachments)) return [];
  return payload.attachments
    .slice(0, 20)
    .flatMap((/** @type {any} */ item) =>
      isObject(item) && typeof item.name === "string"
        ? [{ name: clip(item.name, 200), size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0, path: clip(str(item.path), 500) }]
        : [],
    );
}

/** Plain text of a framework `Content[]`; images and other parts become a short marker. */
function textOf(/** @type {unknown} */ content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isObject(part)) return "";
      if (part.type === "text") return str(part.text);
      if (part.type === "image") return "[image]";
      return "";
    })
    .join("");
}

/** A short single-text rendering of any value (tool arguments). */
function preview(/** @type {unknown} */ value) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return clip(text ?? "", MAX_ARGS);
  } catch {
    return "";
  }
}

/**
 * Applies one event to `state` (in place; returns whether it changed anything). Events with a `seq` not above the last
 * one are ignored. State is mutated rather than copied because a 2000-event conversation would otherwise copy the
 * item list 2000 times; the renderer watches `rev` of the state and of each item instead.
 * @param {ViewState} state
 * @param {SessionEvent} event
 */
export function applyEvent(state, event) {
  if (!isObject(event) || !Number.isInteger(event.seq) || event.seq <= state.lastSeq) return false;
  const at = typeof event.at === "number" && Number.isFinite(event.at) ? event.at : 0;
  if (event.seq > state.lastSeq + 1) state.gaps += 1;
  state.lastSeq = event.seq;
  state.rev += 1;
  const payload = event.payload;
  try {
    handle(state, str(event.type), payload, event.seq, at);
  } catch {
    // A payload shape we did not foresee must not stop the stream; the event is counted as seen and shows nothing.
  }
  return true;
}

/**
 * @param {SessionEvent[]} events
 * @param {ViewState} [state]
 */
export function foldEvents(events, state = createState()) {
  for (const event of events) applyEvent(state, event);
  return state;
}

/** What tests compare: the visible state without the lookup tables. */
export function visible(/** @type {ViewState} */ state) {
  const { byCall: _a, byQuestion: _b, byApproval: _c, waitingIds: _d, innerCalls: _e, ...rest } = /** @type {any} */ (state);
  return rest;
}

/** @param {ViewState} state */
function push(state, /** @type {Item} */ item) {
  state.items.push(item);
  return item;
}

/** @param {ViewState} state */
function handle(state, /** @type {string} */ type, /** @type {any} */ payload, /** @type {number} */ seq, /** @type {number} */ at) {
  const s = /** @type {any} */ (state);
  switch (type) {
    case "run.started":
      state.run = "active";
      state.runStartAt = at;
      return;
    case "run.finished": {
      state.run = "idle";
      state.runStartAt = 0;
      for (const tool of s.byCall.values())
        if (tool.outcome === "running") {
          // A call that never got its result when the run ended was cut off; showing it as running for ever is a lie.
          tool.outcome = "interrupted";
          tool.endAt = at;
          touch(tool);
        }
      state.lastRunEnd = isObject(payload) ? str(payload.reason) : "";
      const pause = isObject(payload) && isObject(payload.pause) ? str(payload.pause.reason) : "";
      if (pause && pause !== "input" && pause !== "blocked") push(state, note(seq, at, `The agent paused: ${PAUSE_WORDS[pause] ?? pause}.`, "info"));
      return;
    }
    case "router.input":
      return routerInput(state, payload);
    case "message.user": {
      const text = clip(isObject(payload) ? textOf(payload.content) : "", MAX_TEXT);
      const header = SIGNAL_HEADER.exec(text);
      if (header) {
        const body = (header[4] ?? "")
          .split("\n")
          .map((line) => (line.startsWith("| ") ? line.slice(2) : line))
          .join("\n");
        push(state, { kind: "signal", seq, at, source: header[1] ?? "", trust: header[2] ?? "", text: body });
      } else {
        // The message right after a hand-back is the runtime's instruction to the agent; the person sees only their own note.
        const handback = s.afterTakeover;
        s.afterTakeover = null;
        if (!handback) push(state, { kind: "user", seq, at, text, attachments: attachmentsOf(payload) });
        else if (handback.note) push(state, { kind: "user", seq, at, text: handback.note, attachments: [] });
        else push(state, note(seq, at, "You handed the desk back.", "info"));
        for (const question of s.byQuestion.values())
          if (!question.answered) {
            question.answered = true;
            question.answeredAt = at;
            touch(question);
          }
      }
      return;
    }
    case "message.assistant": {
      if (!isObject(payload) || payload.role !== "assistant") return; // tool messages are shown through the tool rows
      const text = clip(textOf(payload.content).trim(), MAX_TEXT);
      // A scheduled run that has nothing to say answers only [SILENT]: the run happened, the person is not disturbed.
      if (text && !/^\[SILENT\]$/.test(text)) push(state, { kind: "assistant", seq, at, text });
      return;
    }
    case "agent.message": {
      const text = clip(isObject(payload) ? str(payload.text) : "", MAX_TEXT);
      if (text) push(state, { kind: "say", seq, at, text });
      return;
    }
    case "tool.call":
      return toolCall(state, payload, seq, at);
    case "tool.result":
      return toolResult(state, payload, seq, at);
    case "agent.plugin.review": {
      if (!isObject(payload)) return;
      const tool = upsertTool(state, str(payload.callId), seq, at);
      if (tool.name === "?") tool.name = tool.tool.name = str(payload.tool, "?");
      tool.review = { outcome: str(payload.outcome), decidedBy: str(payload.decidedBy), reason: clip(str(payload.reason), 2000) };
      touch(tool);
      return;
    }
    case "human.question": {
      if (!isObject(payload)) return;
      const id = str(payload.id);
      if (!id || s.byQuestion.has(id)) return;
      const item = push(state, {
        kind: "question",
        seq,
        at,
        id,
        question: clip(str(payload.question), MAX_TEXT),
        ask: str(payload.kind),
        where: clip(str(payload.where), 500),
        answered: false,
        answeredAt: 0,
      });
      s.byQuestion.set(id, item);
      if (str(payload.kind) === "login") state.deskTrigger = { seq, reason: "login", at, run: state.runStartAt, host: hostOf(str(payload.where)) };
      return;
    }
    case "human.answered": {
      const question = isObject(payload) ? s.byQuestion.get(str(payload.id)) : undefined;
      if (question && !question.answered) {
        question.answered = true;
        question.answeredAt = at;
        touch(question);
      }
      return;
    }
    case "approval.requested": {
      if (!isObject(payload)) return;
      const id = str(payload.id);
      if (!id) return;
      const existing = s.byApproval.get(id);
      if (existing) {
        if (existing.tool === "?") existing.tool = str(payload.tool, "?");
        if (existing.args === "") existing.args = preview(payload.args);
        touch(existing);
        return;
      }
      s.byApproval.set(
        id,
        push(state, { kind: "approval", seq, at, id, tool: str(payload.tool, "?"), args: preview(payload.args), status: "pending", decidedAt: 0 }),
      );
      return;
    }
    case "approval.decided":
    case "approval.expired": {
      if (!isObject(payload)) return;
      const id = str(payload.id);
      if (!id) return;
      let item = s.byApproval.get(id);
      if (!item) {
        item = push(state, { kind: "approval", seq, at, id, tool: "?", args: "", status: "pending", decidedAt: 0 });
        s.byApproval.set(id, item);
      }
      if (item.status === "pending") {
        item.status = type === "approval.expired" ? "expired" : payload.approved === true ? "approved" : "denied";
        item.decidedAt = at;
      }
      touch(item);
      return;
    }
    case "takeover.opened":
      state.takeover = { since: isObject(payload) && typeof payload.since === "number" ? payload.since : at, viewed: false };
      return;
    case "takeover.viewer_connected":
      if (state.takeover) state.takeover.viewed = true;
      return;
    case "takeover.closed":
      // After a hand-back that the person really used, the agent first looks at the page again: the Now line says so.
      state.backFromDesk = isObject(payload) && payload.viewed === true;
      state.takeover = null;
      s.afterTakeover = { note: isObject(payload) && typeof payload.note === "string" ? clip(payload.note, MAX_TEXT) : "" };
      return;
    case "agent.paused":
      push(state, note(seq, at, str(payload) === "input" ? "Waiting for you." : `Paused: ${clip(str(payload, "waiting"), 200)}`, "info"));
      return;
    case "agent.compaction":
      push(state, note(seq, at, "Earlier conversation was summarised to save room.", "info"));
      return;
    case "session.error": {
      const cause = isObject(payload) ? clip(str(payload.message, "A session error occurred."), 2000) : clip(str(payload, "A session error occurred."), 2000);
      const kind = isObject(payload) ? str(payload.kind) : "";
      const item = note(seq, at, kind ? `${cause} (${kind})` : cause, "error");
      item.retryable = isObject(payload) && payload.retryable === true;
      push(state, item);
      return;
    }
    default:
      return; // router decisions, deliveries, goals, plugin events of other plugins: not shown
  }
}

const PAUSE_WORDS = /** @type {Record<string, string>} */ ({
  budget: "the budget is used up",
  time: "the time limit was reached",
  quota: "the model quota is used up",
  stuck: "it seemed to be going in circles",
});

/** @returns {Extract<Item, { kind: "note" }>} */
function note(/** @type {number} */ seq, /** @type {number} */ at, /** @type {string} */ text, /** @type {"info" | "error"} */ level) {
  return { kind: "note", seq, at, text, level, retryable: false };
}

/** What a call was about, from the unwrapped `tool` field when the runtime sends one, else from the call's own name and arguments. */
function toolRefOf(/** @type {any} */ payload) {
  const ref = isObject(payload.tool) ? payload.tool : {};
  const args = isObject(payload.arguments) ? payload.arguments : isObject(payload.args) ? payload.args : {};
  return {
    name: str(ref.name, str(payload.name, "?")),
    action: str(ref.action, str(args.action)),
    target: clip(str(ref.target, str(args.url, str(args.path, str(args.target)))), 500),
  };
}

/** @param {ViewState} state */
function toolCall(state, /** @type {any} */ payload, /** @type {number} */ seq, /** @type {number} */ at) {
  const s = /** @type {any} */ (state);
  if (!isObject(payload)) return;
  const id = str(payload.id);
  const parentId = str(payload.parentCallId);
  if (parentId) {
    // The review of an inner call: it belongs to its parent's row, it is not a row of its own.
    const parent = upsertTool(state, parentId, seq, at);
    if (id) s.innerCalls.set(id, parent);
    parent.review ??= { outcome: "pending", decidedBy: str(isObject(payload.tool) ? payload.tool.name : payload.name), reason: "" };
    touch(parent);
    return;
  }
  const tool = upsertTool(state, id, seq, at);
  const ref = toolRefOf(payload);
  tool.name = ref.name;
  tool.tool = ref;
  tool.args = preview(isObject(payload.arguments) || typeof payload.arguments === "string" ? payload.arguments : payload.args);
  tool.at = at;
  state.backFromDesk = false;
  if (BROWSER_TOOLS.has(ref.name)) state.deskTrigger = { seq, reason: "browser", at, run: state.runStartAt, host: hostOf(ref.target) };
  touch(tool);
}

/** @param {ViewState} state */
function toolResult(state, /** @type {any} */ payload, /** @type {number} */ seq, /** @type {number} */ at) {
  const s = /** @type {any} */ (state);
  if (!isObject(payload) || !isObject(payload.call)) return;
  const id = str(payload.call.id);
  const result = isObject(payload.result) ? payload.result : {};
  const out = textOf(result.content);
  const inner = s.innerCalls.get(id);
  if (inner) {
    const refused = payload.outcome === "refused" || payload.outcome === "error";
    inner.review = { outcome: refused ? "deny" : "allow", decidedBy: inner.review?.decidedBy ?? "", reason: refused ? clip(out, 2000) : "" };
    touch(inner);
    return;
  }
  const tool = upsertTool(state, id, seq, at);
  if (tool.name === "?") {
    const ref = toolRefOf(payload.call);
    tool.name = ref.name;
    tool.tool = ref;
  }
  if (tool.args === "") tool.args = preview(isObject(payload.call.arguments) ? payload.call.arguments : payload.call.args);
  tool.truncated = out.length > MAX_TEXT;
  tool.output = clip(out, MAX_TEXT);
  tool.endAt = at;
  const named = typeof payload.outcome === "string" && ["ok", "error", "refused", "needs_approval", "interrupted"].includes(payload.outcome);
  tool.outcome = named ? payload.outcome : result.isError === true ? "error" : "ok";
  touch(tool);
}

/** The held/waiting banner comes from what the router was given: Stop holds, the person's next message releases. */
function routerInput(/** @type {ViewState} */ state, /** @type {any} */ input) {
  const s = /** @type {any} */ (state);
  if (!isObject(input)) return;
  if (input.type === "stop") {
    state.held = true;
    return;
  }
  if (input.type !== "signal" || !isObject(input.draft)) return;
  const source = str(input.draft.source);
  if (source === "user") {
    state.held = false;
    state.waiting = 0;
    s.waitingIds.clear();
  } else if (state.held && source !== "system") {
    const id = `${source}:${str(input.draft.id)}`;
    if (!s.waitingIds.has(id)) {
      s.waitingIds.add(id);
      state.waiting = s.waitingIds.size;
    }
  }
}

/** @param {ViewState} state */
function upsertTool(state, /** @type {string} */ callId, /** @type {number} */ seq, /** @type {number} */ at) {
  const s = /** @type {any} */ (state);
  const key = callId || `anonymous-${seq}`;
  let tool = s.byCall.get(key);
  if (!tool) {
    tool = push(state, {
      kind: "tool",
      seq,
      at,
      callId: key,
      name: "?",
      tool: { name: "?", action: "", target: "" },
      args: "",
      outcome: "running",
      endAt: 0,
      output: "",
      truncated: false,
      review: null,
    });
    s.byCall.set(key, tool);
  }
  return tool;
}

function touch(/** @type {any} */ item) {
  item.rev = (item.rev ?? 0) + 1;
}

/** Items the person has to act on, for the badge in the session list. */
export function pendingActions(/** @type {ViewState} */ state) {
  let count = 0;
  for (const item of state.items) {
    if (item.kind === "approval" && item.status === "pending") count += 1;
    if (item.kind === "question" && !item.answered) count += 1;
  }
  return count;
}
