import type { SignalDraft, SignalSource } from "../signals.ts";

/** A signal draft with sensible defaults, for tests of any module. */
export function signalDraft(id: string, overrides: Partial<{ source: SignalSource; text: string }> = {}): SignalDraft {
  return { id, source: overrides.source ?? "external:test", text: overrides.text ?? `text of ${id}` };
}

export {
  approvalsPendingAndExpired,
  JOURNAL_FIXTURES,
  messageQueuedDuringTakeover,
  messageWithAttachments,
  loginTakeoverJourney,
  modelQuotaError,
  plainChatTurn,
  refusalAndFailure,
  waitLimitsReached,
} from "./journal-fixtures.ts";
