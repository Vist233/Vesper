import { describe, expect, it } from "vitest";
import { continueWith, freshName, freshNotices, STARS, starOf } from "../src/bots.js";
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
});

describe("the conversation the page opens with", () => {
  it("continues the one open last time, else the latest, else none", () => {
    const bots = [{ id: "s_new" }, { id: "s_old" }];
    expect(continueWith(bots, "s_old")).toBe("s_old");
    expect(continueWith(bots, "s_gone")).toBe("s_new");
    expect(continueWith(bots, null)).toBe("s_new");
    expect(continueWith([], "s_old")).toBeNull();
  });
});

describe("notices of scheduled runs", () => {
  it("shows a notice newer than the last one shown, never replays old ones on the first look, and forgets deleted bots", () => {
    const first = freshNotices(
      [
        { id: "a", title: "Vega", notice: { at: 10, text: "old" } },
        { id: "b", title: "Lyra" },
      ],
      {},
    );
    expect(first).toEqual({ fresh: [], seen: { a: 10, b: 0 } });
    expect(freshNotices([{ id: "b", title: "Lyra", notice: { at: 5, text: "first" } }], first.seen).fresh).toEqual([{ id: "b", title: "Lyra", text: "first" }]);
    const second = freshNotices([{ id: "a", title: "Vega", notice: { at: 20, text: "price 42" } }], first.seen);
    expect(second).toEqual({ fresh: [{ id: "a", title: "Vega", text: "price 42" }], seen: { a: 20 } });
    expect(freshNotices([{ id: "a", title: "Vega", notice: { at: 20, text: "price 42" } }], second.seen).fresh).toEqual([]);
    expect(freshNotices([], second.seen).seen).toEqual({});
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
