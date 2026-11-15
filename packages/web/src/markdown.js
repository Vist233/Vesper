// @ts-check
// A small Markdown reader for the agent's finished messages: it returns a tree, and render.js builds DOM nodes from it
// with `textContent` only. Raw HTML is never interpreted: `<b>` stays the characters it is made of.
// Supported: paragraphs with line breaks, headings, bullet and numbered lists, quotes, rules, fenced code, and inline
// **bold**, *italic*, `code` and [links](https://...). Links that are not http(s) or a file of this box stay text.

import { splitFences } from "./text.js";

/**
 * @typedef {{ type: "text", text: string } | { type: "br" } | { type: "code", text: string }
 *   | { type: "strong" | "em", children: Inline[] } | { type: "link", href: string, children: Inline[] }} Inline
 * @typedef {{ type: "p" | "quote", inlines: Inline[] } | { type: "h", level: number, inlines: Inline[] }
 *   | { type: "ul" | "ol", items: Inline[][], start: number } | { type: "code", text: string, lang: string } | { type: "hr" }} Block
 */

/** A link target the page may follow: a web address, or a file of a session of this box. */
export function safeHref(/** @type {string} */ href) {
  if (/^https?:\/\/[^\s]+$/i.test(href)) return true;
  return /^\/api\/sessions\/[A-Za-z0-9_-]+\/files\/[^\s()/?#]+$/.test(href);
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** @returns {Inline[]} */
export function parseInline(/** @type {string} */ text) {
  /** @type {Inline[]} */
  const out = [];
  const pushText = (/** @type {string} */ value) => {
    const lines = value.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) out.push({ type: "br" });
      if (line) out.push({ type: "text", text: line });
    });
  };
  let end = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    pushText(text.slice(end, index));
    const [whole, , code, strong, strong2, em, label, href] = match;
    if (code !== undefined) out.push({ type: "code", text: code.trim() === "" ? code : code.replace(/^ (.*) $/s, "$1") });
    else if (strong !== undefined || strong2 !== undefined) out.push({ type: "strong", children: parseInline(/** @type {string} */ (strong ?? strong2)) });
    else if (em !== undefined) out.push({ type: "em", children: parseInline(em) });
    else if (label !== undefined && href !== undefined && safeHref(href)) out.push({ type: "link", href, children: parseInline(label) });
    else pushText(whole);
    end = index + whole.length;
  }
  pushText(text.slice(end));
  return out;
}

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Blocks of text outside code fences. */
function parseText(/** @type {string} */ text) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "p", inlines: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = /** @type {string} */ (lines[i]);
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "h", level: /** @type {string} */ (heading[1]).length, inlines: parseInline(/** @type {string} */ (heading[2])) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: "hr" });
      continue;
    }
    const kind = BULLET.test(line) ? "ul" : NUMBER.test(line) ? "ol" : null;
    if (kind) {
      flush();
      const pattern = kind === "ul" ? BULLET : NUMBER;
      /** @type {string[]} */
      const items = [];
      const start = kind === "ol" ? Number(/** @type {RegExpExecArray} */ (NUMBER.exec(line))[1]) : 1;
      while (i < lines.length) {
        const current = /** @type {string} */ (lines[i]);
        const item = pattern.exec(current);
        if (item) items.push(/** @type {string} */ (kind === "ul" ? item[1] : item[2]));
        else if (current.trim() !== "" && /^\s+/.test(current) && items.length > 0) items[items.length - 1] += `\n${current.trim()}`;
        else break;
        i += 1;
      }
      i -= 1;
      blocks.push({ type: kind, items: items.map(parseInline), start });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      /** @type {string[]} */
      const quoted = [];
      while (i < lines.length && QUOTE.test(/** @type {string} */ (lines[i]))) {
        quoted.push(/** @type {string} */ (/** @type {RegExpExecArray} */ (QUOTE.exec(/** @type {string} */ (lines[i])))[1]));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: "quote", inlines: parseInline(quoted.join("\n")) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** The whole message as blocks. */
export function parseMarkdown(/** @type {string} */ text) {
  /** @type {Block[]} */
  const blocks = [];
  for (const part of splitFences(text)) {
    if (part.type === "code") blocks.push({ type: "code", text: part.text, lang: part.lang });
    else blocks.push(...parseText(part.text));
  }
  return blocks;
}
