/**
 * Who a signal comes from. `user` and `system` are ours; everything else is outside text and untrusted.
 * Shape: `user`, `system`, `plugin:<name>` (for example `plugin:mail-sim`) or `external:<name>`.
 */
export type SignalSource = "user" | "system" | `plugin:${string}` | `external:${string}`;

export type Trust = "trusted" | "untrusted";

/** `user` messages jump the line; everything else keeps arrival order. Derived from the source, never chosen by a producer. */
export type SignalPriority = "user" | "normal";

/** What a producer hands over. It has no trust and no priority field on purpose: the router decides both from the source. */
export interface SignalDraft {
  id: string; // unique per session; a producer that retries must reuse the id
  source: SignalSource;
  text: string;
}

export interface Signal {
  id: string;
  source: SignalSource;
  trust: Trust;
  priority: SignalPriority;
  at: number; // when the router received it (ms)
  text: string;
}

/**
 * What the router decides for one session. The runtime executes it and reports the result back.
 * - start-run: the session is idle; begin a run whose input is `input`.
 * - steer: a run is active; hand `text` to it (the framework drops a steer when no run is active, which is why the router decides).
 * - stop: end the active run.
 */
export type Delivery =
  | { kind: "start-run"; id: string; sessionId: string; signalIds: string[]; input: string }
  | { kind: "steer"; id: string; sessionId: string; signalIds: string[]; text: string }
  | { kind: "stop"; id: string; sessionId: string; signalIds: string[] };

/** Why a signal did not lead to a delivery right now, for the journal. */
export type DecisionOutcome = "queued" | "duplicate" | "absorbed";

export interface Decision {
  sessionId: string;
  signalId: string;
  outcome: DecisionOutcome;
  signal?: Signal; // present for "queued", so the journal records source and trust
}
