import { randomBytes } from "node:crypto";

export type TicketKind = "view" | "takeover";

export interface TicketTarget {
  sessionId: string;
  kind: TicketKind;
  /** Where the daemon's stream is and the daemon's own token for it (from `view.open` or `takeover.open`, fetched when the page ticket is made). */
  upstream: { port: number; token: string };
}

/**
 * One-time tickets for WebSocket connections. A browser cannot put an `Authorization` header on a WebSocket, and a
 * long-lived token must not travel in a URL (logs, history), so the page asks over the authenticated API for a ticket
 * that works once, for one session and one kind of view, for a few seconds.
 */
export class TicketBook {
  private readonly tickets = new Map<string, TicketTarget & { expiresAt: number }>();
  private readonly lifetimeMs: number;
  private readonly now: () => number;
  private static readonly MAX_OUTSTANDING = 1000;

  constructor(lifetimeMs: number, now: () => number) {
    this.lifetimeMs = lifetimeMs;
    this.now = now;
  }

  mint(target: TicketTarget): string {
    this.sweep();
    if (this.tickets.size >= TicketBook.MAX_OUTSTANDING) this.tickets.delete(this.tickets.keys().next().value as string); // the oldest goes
    const id = randomBytes(24).toString("base64url");
    this.tickets.set(id, { ...target, expiresAt: this.now() + this.lifetimeMs });
    return id;
  }

  /** Returns the target once; a second use, an expired ticket or an unknown one gives undefined. */
  redeem(id: string, expected: { sessionId: string; kind: TicketKind }): TicketTarget | undefined {
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);
    if (!ticket || ticket.expiresAt < this.now()) return undefined;
    if (ticket.sessionId !== expected.sessionId || ticket.kind !== expected.kind) return undefined;
    return ticket;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt < now) this.tickets.delete(id);
  }
}
