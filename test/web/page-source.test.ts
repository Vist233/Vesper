import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_DIR } from "./harness.ts";

const FORBIDDEN = [
  /\.innerHTML\b/,
  /\.outerHTML\b/,
  /insertAdjacentHTML/,
  /document\.write/,
  /\beval\s*\(/,
  /new Function\s*\(/,
  /setAttribute\(\s*["']on/i,
  /\.srcdoc\b/,
];

describe("the page's source", () => {
  const files = readdirSync(WEB_DIR).filter((name) => name.endsWith(".js") || name.endsWith(".html"));

  it("has files to look at", () => {
    expect(files).toEqual(expect.arrayContaining(["app.js", "model.js", "render.js", "client.js", "sse.js", "index.html"]));
  });

  it.each(files)("%s writes no markup from strings and runs no strings as code", (name) => {
    const source = readFileSync(join(WEB_DIR, name), "utf8");
    for (const pattern of FORBIDDEN) expect(pattern.test(source), `${name} matches ${pattern}`).toBe(false);
  });

  it("index.html has no inline script, no inline handler and no style attribute (the CSP would block them, and they would be a way in)", () => {
    const html = readFileSync(join(WEB_DIR, "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });
});
