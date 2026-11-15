import { describe, expect, it } from "vitest";
import { CORE_EVENT_TYPES, isSessionEvent } from "../src/index.ts";
import { JOURNAL_FIXTURES } from "../src/testing/index.ts";

describe("journal fixtures", () => {
  for (const [name, make] of Object.entries(JOURNAL_FIXTURES)) {
    it(`${name}: full events, seq from 1 without gaps, time never goes back, known types`, () => {
      const events = make();
      expect(events.length).toBeGreaterThan(0);
      events.forEach((event, index) => {
        expect(isSessionEvent(event)).toBe(true);
        expect(event.seq).toBe(index + 1);
        if (index > 0) expect(event.at).toBeGreaterThanOrEqual(events[index - 1]?.at ?? 0);
        expect((CORE_EVENT_TYPES as readonly string[]).includes(event.type)).toBe(true);
      });
    });
  }
});
