import { EVENT_SCHEMA_VERSION, type SessionEvent } from "../events.ts";
import type { JsonValue } from "../json.ts";

/*
 * Journal fixtures for the page and the gateway: full events (version, seq from 1 without gaps, timestamps, session id) in
 * the D6 vocabulary. They are the contract in executable form: a page built against them reads what the runtime will write.
 */

const T0 = 1_800_000_000_000;

function journal(sessionId: string, drafts: [offsetSeconds: number, type: string, payload: JsonValue][]): SessionEvent[] {
  return drafts.map(([offset, type, payload], index) => ({ v: EVENT_SCHEMA_VERSION, seq: index + 1, at: T0 + offset * 1000, sessionId, type, payload }));
}
const user = (text: string): JsonValue => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): JsonValue => ({ role: "assistant", content: [{ type: "text", text }] });
const text = (value: string): JsonValue => ({ content: [{ type: "text", text: value }] });
const fail = (value: string): JsonValue => ({ content: [{ type: "text", text: value }], isError: true });

/** (a) A plain chat turn. */
export const plainChatTurn = (sessionId = "s_chat"): SessionEvent[] =>
  journal(sessionId, [
    [0, "run.started", null],
    [0, "message.user", user("What is 2 + 2?")],
    [2, "message.assistant", assistant("4.")],
    [2, "run.finished", { reason: "end" }],
  ]);

const BILIBILI = "https://space.bilibili.com/1/video";
const SIGN_IN = "https://passport.bilibili.com/login";
const call = (id: string, name: string, tool?: { name: string; action?: string; target?: string }, parentCallId?: string): JsonValue => ({
  id,
  name,
  arguments: {},
  ...(tool ? { tool } : {}),
  ...(parentCallId ? { parentCallId } : {}),
});

/**
 * (b) The owner's failed case: browser calls, a login question, a take-over that nobody looked at, a second take-over that
 * was viewed and handed back with a note, then more browser calls. The inner review event carries `parentCallId`.
 */
export const loginTakeoverJourney = (sessionId = "s_login"): SessionEvent[] => {
  const open = call("c1", "tool_call", { name: "browser", action: "open", target: BILIBILI });
  const review = call("r1", "review", { name: "browser", action: "open", target: BILIBILI }, "c1");
  const snapshot = call("c2", "tool_call", { name: "browser", action: "snapshot", target: BILIBILI });
  const click = call("c3", "tool_call", { name: "browser", action: "click", target: SIGN_IN });
  const reopen = call("c4", "tool_call", { name: "browser", action: "snapshot", target: BILIBILI });
  return journal(sessionId, [
    [0, "run.started", null],
    [0, "message.user", user("Read my play counts on Bilibili.")],
    [3, "tool.call", open],
    [3, "tool.call", review],
    [3, "tool.result", { call: review, result: text("allowed"), outcome: "ok" }],
    [6, "tool.result", { call: open, result: text("opened"), outcome: "ok" }],
    [7, "tool.call", snapshot],
    [8, "tool.result", { call: snapshot, result: text("signed out"), outcome: "ok" }],
    [9, "tool.call", click],
    [10, "tool.result", { call: click, result: text("login page"), outcome: "ok" }],
    [12, "human.question", { id: "q_1", question: "Please sign in to Bilibili in the browser.", kind: "login", where: SIGN_IN }],
    [12, "run.finished", { reason: "pause", pause: { reason: "input", detail: "waiting for the person to sign in" } }],
    // A take-over that nobody looked at: opened and closed with no viewer.
    [60, "takeover.opened", { since: T0 + 60_000, workspaceId: "w_login" }],
    [75, "takeover.closed", { viewed: false }],
    // A second one: a viewer connected, the person signed in, handed back with a note.
    [120, "takeover.opened", { since: T0 + 120_000, workspaceId: "w_login" }],
    [124, "takeover.viewer_connected", {}],
    [200, "takeover.closed", { note: "Signed in.", viewed: true }],
    [200, "human.answered", { id: "q_1", by: "takeover" }],
    [200, "message.user", user("I took over the desktop and handed it back. Signed in.")],
    [201, "run.started", null],
    [203, "tool.call", reopen],
    [205, "tool.result", { call: reopen, result: text("signed in; 1,234 plays"), outcome: "ok" }],
    [207, "message.assistant", assistant("Your play count is 1,234.")],
    [207, "run.finished", { reason: "end" }],
  ]);
};

/** (c) A refused call and a failed tool. */
export const refusalAndFailure = (sessionId = "s_fail"): SessionEvent[] => {
  const refused = call("c1", "bash", { name: "bash", action: "run" });
  const broken = call("c2", "read", { name: "read", action: "read", target: "/files/missing.txt" });
  return journal(sessionId, [
    [0, "run.started", null],
    [0, "message.user", user("Clean up, then read missing.txt.")],
    [1, "tool.call", refused],
    [1, "tool.result", { call: refused, result: fail("refused by review: deletes files outside the workspace"), outcome: "refused" }],
    [2, "tool.call", broken],
    [2, "tool.result", { call: broken, result: fail("ENOENT: no such file"), outcome: "error" }],
    [3, "message.assistant", assistant("I could not do either; the file does not exist.")],
    [3, "run.finished", { reason: "end" }],
  ]);
};

/** (d) The model failed with a quota error. */
export const modelQuotaError = (sessionId = "s_quota"): SessionEvent[] =>
  journal(sessionId, [
    [0, "run.started", null],
    [0, "message.user", user("Summarise the news.")],
    [1, "session.error", { kind: "quota", message: "The model provider says the quota is used up.", retryable: false }],
    [1, "run.finished", { reason: "error", pause: { reason: "quota" } }],
  ]);

/** (e) One approval waiting and one that expired (a restart left it without a decision). */
export const approvalsPendingAndExpired = (sessionId = "s_approve"): SessionEvent[] =>
  journal(sessionId, [
    [0, "run.started", null],
    [0, "message.user", user("Send the report to Sam, then post it.")],
    [2, "approval.requested", { id: "a_1", tool: "mail_send", args: { to: "sam@example.test" } }],
    [3, "approval.requested", { id: "a_2", tool: "post_public", args: { text: "report" } }],
    [4, "run.finished", { reason: "pause", pause: { reason: "blocked", detail: "waiting for approval" } }],
    [100, "approval.expired", { id: "a_1", reason: "restart" }],
  ]);

/** (f) A login question that nobody answered within the optional limit, then a take-over that ran out of time. */
export const waitLimitsReached = (sessionId = "s_wait"): SessionEvent[] =>
  journal(sessionId, [
    [0, "run.started", null],
    [0, "message.user", user("Read my play counts on Bilibili.")],
    [5, "human.question", { id: "q_1", question: "Please sign in to Bilibili.", kind: "login", where: SIGN_IN }],
    [5, "run.finished", { reason: "pause", pause: { reason: "input" } }],
    [1805, "human.expired", { id: "q_1", afterMinutes: 30 }],
    [1805, "message.user", user("The person did not answer within 30 minutes. Do not touch the browser for that step.")],
    [1806, "run.started", null],
    [1810, "message.assistant", assistant("I could not sign in; the person did not answer.")],
    [1810, "run.finished", { reason: "end" }],
    [2000, "takeover.opened", { since: T0 + 2_000_000, workspaceId: "w_wait" }],
    [2004, "takeover.viewer_connected", {}],
    [5600, "takeover.closed", { note: "timeout", viewed: true }],
    [5600, "message.user", user("The take-over ended by timeout after 60 minutes; the page may have changed; take a fresh snapshot.")],
  ]);

/** (g) The person writes while a take-over is open: the text is queued, then delivered after the hand-back. */
export const messageQueuedDuringTakeover = (sessionId = "s_queue"): SessionEvent[] =>
  journal(sessionId, [
    [0, "takeover.opened", { since: T0, workspaceId: "w_queue" }],
    [4, "takeover.viewer_connected", {}],
    [20, "message.queued", { id: "m_1", text: "Also check the second tab." }],
    [60, "takeover.closed", { note: "Signed in.", viewed: true }],
    [60, "message.user", user("I took over the desktop and handed it back. Signed in.")],
    [60, "message.user", user("Also check the second tab.")],
  ]);

/** (h) The person attaches a file: `message.user` carries `attachments`, and the text the agent read ends with one line naming them. */
export const messageWithAttachments = (sessionId = "s_files"): SessionEvent[] =>
  journal(sessionId, [
    [0, "run.started", null],
    [
      0,
      "message.user",
      {
        ...(user("Summarise this report.\n\nThe person attached 1 file: report.pdf (12.0 KB) at /data/workspaces/w_files/files/report.pdf") as object),
        attachments: [{ name: "report.pdf", size: 12_288, path: "/data/workspaces/w_files/files/report.pdf" }],
      },
    ],
    [3, "message.assistant", assistant("The report says ...")],
    [3, "run.finished", { reason: "end" }],
  ]);

export const JOURNAL_FIXTURES = {
  plainChatTurn,
  loginTakeoverJourney,
  refusalAndFailure,
  modelQuotaError,
  approvalsPendingAndExpired,
  waitLimitsReached,
  messageQueuedDuringTakeover,
  messageWithAttachments,
} satisfies Record<string, (sessionId?: string) => SessionEvent[]>;
