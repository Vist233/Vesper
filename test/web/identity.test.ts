import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, WEB_DIR } from "./harness.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("the tab icon and the logo", () => {
  const html = readFileSync(join(WEB_DIR, "index.html"), "utf8");

  it("the page head links the favicon and the apple-touch icon", () => {
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />');
    expect(html).toContain("<title>Vesper</title>");
  });

  it("the server answers 200 with image/png for each, and the page's policy allows images from its own origin only", async () => {
    harness = await startHarness();
    for (const path of ["/favicon-32.png", "/apple-touch-icon.png", "/vesper-logo.png"]) {
      const response = await fetch(`${harness.url}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
    const page = await fetch(`${harness.url}/`);
    expect(page.headers.get("content-security-policy")).toContain("img-src 'self'");
  });

  it("the top bar mark is the star (an inline SVG), not the picture of the logo", () => {
    const mark = html.slice(html.indexOf('<span class="mark">'), html.indexOf("</span>", html.indexOf('<span class="mark">')));
    expect(mark).toContain("<svg");
    expect(mark).not.toContain("<img");
  });
});
