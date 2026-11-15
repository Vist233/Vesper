import { describe, expect, it } from "vitest";
import { chatTimeline, clockTime, dayLabel, listTime, presence, preview } from "../src/chat.js";

const NOW = new Date(2026, 10, 15, 20, 0).getTime();
const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).getTime();
let seq = 0;
const user = (t: number, text = "hi") => ({ kind: "user", seq: ++seq, at: t, text, attachments: [] }) as any;
const bot = (t: number, text = "ok") => ({ kind: "assistant", seq: ++seq, at: t, text }) as any;
const tool = (t: number) =>
  ({
    kind: "tool",
    seq: ++seq,
    at: t,
    callId: "c",
    name: "bash",
    tool: { name: "bash", action: "", target: "" },
    args: "",
    outcome: "ok",
    endAt: t,
    output: "",
    truncated: false,
    review: null,
  }) as any;
const signal = (t: number, trust: string) =>
  ({ kind: "signal", seq: ++seq, at: t, source: trust === "trusted" ? "system" : "plugin:mail", trust, text: "x" }) as any;

describe("times as a chat shows them", () => {
  it("writes clock times, day labels and contact times", () => {
    expect(clockTime(at(15, 9, 5))).toBe("09:05");
    expect(dayLabel(at(15, 1, 0), NOW)).toBe("Today");
    expect(dayLabel(at(14, 23, 0), NOW)).toBe("Yesterday");
    expect(dayLabel(at(12, 10, 0), NOW)).toBe("Thursday");
    expect(dayLabel(at(1, 10, 0), NOW)).toBe("1 Nov");
    expect(dayLabel(new Date(2025, 0, 3).getTime(), NOW)).toBe("3 Jan 2025");
    expect(listTime(at(15, 9, 5), NOW)).toBe("09:05");
    expect(listTime(at(14, 9, 5), NOW)).toBe("Yesterday");
  });
});

describe("the conversation as a chat", () => {
  it("shows who said what with day separators, groups close messages, and leaves the work out", () => {
    const entries = chatTimeline(
      [
        user(at(14, 10, 0)),
        tool(at(14, 10, 1)),
        bot(at(14, 10, 2)),
        bot(at(14, 10, 3)),
        signal(at(15, 8, 0), "trusted"),
        bot(at(15, 8, 1)),
        signal(at(15, 9, 0), "untrusted"),
      ],
      NOW,
    );
    expect(entries.map((e) => (e.type === "day" ? e.label : `${e.side}${e.tail ? "|" : ""}`))).toEqual([
      "Yesterday",
      "out|",
      "in",
      "in|",
      "Today",
      "in|",
      "center|",
    ]);
  });

  it("starts a new group after five quiet minutes", () => {
    const entries = chatTimeline([bot(at(15, 10, 0)), bot(at(15, 10, 9))], NOW).filter((e) => e.type === "msg");
    expect(entries.map((e) => (e.type === "msg" ? e.tail : null))).toEqual([true, true]);
  });
});

describe("the bot as a person", () => {
  it("is typing while it works, waits when it asked, and was last seen otherwise", () => {
    expect(presence({ run: "active", pending: 0, takeover: false, lastAt: null }, NOW)).toBe("typing…");
    expect(presence({ run: "active", pending: 1, takeover: false, lastAt: null }, NOW)).toBe("waiting for you");
    expect(presence({ run: "idle", pending: 0, takeover: true, lastAt: null }, NOW)).toBe("you have the screen");
    expect(presence({ run: "idle", pending: 0, takeover: false, lastAt: at(15, 9, 5) }, NOW)).toBe("last seen today at 09:05");
    expect(presence({ run: "idle", pending: 0, takeover: false, lastAt: at(14, 9, 5) }, NOW)).toBe("last seen yesterday at 09:05");
    expect(presence({ run: "idle", pending: 0, takeover: false, lastAt: null }, NOW)).toBe("");
  });

  it("previews the last message, marked when it was the person's", () => {
    expect(preview({ last: { at: 1, who: "bot", text: "Price is\n42" } }, "idle")).toEqual({ text: "Price is 42", tone: "" });
    expect(preview({ last: { at: 1, who: "person", text: "thanks" } }, "idle")).toEqual({ text: "You: thanks", tone: "" });
    expect(preview({}, "working")).toEqual({ text: "typing…", tone: "live" });
    expect(preview({}, "needs")).toEqual({ text: "waiting for you", tone: "needs" });
    expect(preview({}, "idle")).toEqual({ text: "No messages yet", tone: "" });
  });
});
