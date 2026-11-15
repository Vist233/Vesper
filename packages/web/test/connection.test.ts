import { describe, expect, it } from "vitest";
import { afterHealth, afterStream, CONNECTION_WORDS } from "../src/connection.js";

const open = { selected: true, streamLive: true };

describe("what the page says about its connection", () => {
  it("the health poll: unreachable is down, not ready is starting, and coming back depends on the session's stream", () => {
    expect(afterHealth("live", null, open)).toBe("down");
    expect(afterHealth("live", { ready: false }, open)).toBe("starting");
    expect(afterHealth("starting", { ready: true }, open)).toBe("live"); // the stream is up: nothing was missed
    expect(afterHealth("starting", { ready: true }, { selected: true, streamLive: false })).toBe("reconnecting");
    expect(afterHealth("down", { ready: true }, { selected: false, streamLive: false })).toBe("live");
    expect(afterHealth("reconnecting", { ready: true }, { selected: true, streamLive: false })).toBe("reconnecting"); // the stream decides
    expect(afterHealth("unauthorized", { ready: true }, { selected: false, streamLive: false })).toBe("unauthorized");
  });

  it("the stream: it cannot clear starting or down (the poll owns those), and a retry reports the same state again", () => {
    expect(afterStream("starting", "live")).toBe("starting");
    expect(afterStream("down", "reconnecting")).toBe("down");
    expect(afterStream("live", "reconnecting")).toBe("reconnecting");
    expect(afterStream("reconnecting", "reconnecting")).toBe("reconnecting"); // same state: app.js keeps its two-second clock
    expect(afterStream("starting", "unauthorized")).toBe("unauthorized");
  });

  it("only the states that keep the person waiting have a banner", () => {
    expect(
      Object.entries(CONNECTION_WORDS)
        .filter(([, words]) => words !== "")
        .map(([state]) => state),
    ).toEqual(["reconnecting", "starting", "down"]);
  });
});
