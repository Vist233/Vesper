import { randomBytes } from "node:crypto";
import type { SessionActor } from "./actor.ts";

/** Said to the agent when the person used the desktop. True only because a viewer really connected (usable plan D4). */
export const HANDBACK_VIEWED =
  "The person used this workspace's browser/desktop directly and handed it back. Tabs, focus and page content may have changed; every earlier element ref and tab id is invalid: list tabs and take a new snapshot before acting. Do not repeat your last step without checking.";

/** Said when the person pressed Take over but no viewer ever connected. */
export const HANDBACK_NOT_VIEWED = "The person opened take-over but never saw the desktop; nothing changed.";

/** Said when the take-over ran out of its time limit. */
export const handbackTimedOut = (minutes: number): string =>
  `The take-over ended by timeout after ${minutes} minutes; the page may have changed; take a fresh snapshot.`;

/** Said to the agent when a question to the person ran out of its time limit. A trusted system message. */
export const questionTimedOut = (minutes: number): string =>
  `The person did not answer within ${minutes} minutes. Do not touch the browser for that step. Report what you could not do, or continue with whatever does not need them.`;

/**
 * Ends the open take-over (if any): journals `takeover.closed`, and tells the agent what is true. By the person: the
 * hand-back text (or "never saw it"). By the time limit: the timeout text. A login question is answered by the take-over
 * only if a viewer really connected.
 */
export async function endTakeover(actor: SessionActor, how: { note?: string; text?: string }): Promise<void> {
  const current = actor.waitingFor.takeover;
  if (!current) return;
  await actor.announce("takeover.closed", { ...(how.note ? { note: how.note } : {}), viewed: current.viewed });
  const handback = current.viewed ? `${HANDBACK_VIEWED}${how.note && !how.text ? ` What the person said: ${how.note}` : ""}` : HANDBACK_NOT_VIEWED;
  await actor.message(`m_${randomBytes(8).toString("hex")}`, how.text ?? handback, current.viewed ? "takeover" : false);
  await deliverQueued(actor);
}

/** Delivers what the person wrote during a take-over, after the hand-back text. Does nothing while a take-over is open. */
export async function deliverQueued(actor: SessionActor): Promise<void> {
  if (actor.waitingFor.takeover) return;
  for (const queued of [...actor.waitingFor.queued]) await actor.message(queued.id, queued.text, "person", queued.attachments ?? []);
}
