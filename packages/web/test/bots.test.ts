import { describe, expect, it } from "vitest";
import { botLine, freshName, STARS, starOf } from "../src/bots.js";
import { parseInline, parseMarkdown, safeHref } from "../src/markdown.js";

describe("bots in the rail", () => {
  it("offers the first free preset name, then numbers it", () => {
    expect(freshName([])).toBe("Vega");
    expect(freshName([{ title: "Vega" }, { title: "lyra" }])).toBe("Altair");
    expect(freshName([{ title: "Rigel" }], "Rigel")).toBe("Rigel 2");
    expect(freshName(STARS.map((s) => ({ title: s.name })))).toBe("Vega 2");
  });

  it("keeps a chosen star, and gives an older session a stable one", () => {
    expect(starOf({ id: "s_1", star: "rigel" }).name).toBe("Rigel");
    expect(starOf({ id: "s_abc" })).toBe(starOf({ id: "s_abc" }));
    expect(STARS.map((s) => s.id)).toEqual(["vega", "lyra", "altair", "polaris", "rigel", "sirius"]);
  });

  it("says what waits, else the task, else the next job", () => {
    expect(botLine({ summary: "watch the inbox" }, "needs")).toBe("Needs you");
    expect(botLine({ summary: "watch the inbox", next: "daily 07:30" }, "working")).toBe("watch the inbox");
    expect(botLine({ next: "daily 07:30" }, "idle")).toBe("next: daily 07:30");
    expect(botLine({}, "idle")).toBe("No task yet");
    expect(botLine({}, "working")).toBe("Working");
  });
});

describe("markdown of a finished message", () => {
  it("reads headings, lists, quotes, rules and code fences", () => {
    const blocks = parseMarkdown("# Plan\n\n- one\n- **two**\n\n1. first\n2. second\n\n> quoted\n\n---\n\n```js\nlet a = 1;\n```\ntail");
    expect(blocks.map((b) => b.type)).toEqual(["h", "ul", "ol", "quote", "hr", "code", "p"]);
    expect(blocks[1]).toMatchObject({ items: [[{ type: "text", text: "one" }], [{ type: "strong", children: [{ type: "text", text: "two" }] }]] });
    expect(blocks[5]).toEqual({ type: "code", text: "let a = 1;", lang: "js" });
  });

  it("keeps line breaks inside a paragraph and reads inline marks", () => {
    expect(parseInline("a *b* `c`\nd")).toEqual([
      { type: "text", text: "a " },
      { type: "em", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "code", text: "c" },
      { type: "br" },
      { type: "text", text: "d" },
    ]);
  });

  it("links only to the web or to a file of this box; markup stays text", () => {
    expect(parseInline("[x](javascript:alert)").some((n) => n.type === "link")).toBe(false);
    expect(parseInline("[site](https://example.com/a)")).toEqual([{ type: "link", href: "https://example.com/a", children: [{ type: "text", text: "site" }] }]);
    expect(safeHref("/api/sessions/s_1/files/cat.png")).toBe(true);
    expect(safeHref("/api/sessions/s_1/files/../x")).toBe(false);
    expect(parseInline("<b>hi</b>")).toEqual([{ type: "text", text: "<b>hi</b>" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
  });
});
