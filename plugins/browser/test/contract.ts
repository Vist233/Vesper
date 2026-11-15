import { describe, expect, it } from "vitest";
import type { BrowserBackend } from "../src/backend.ts";
import type { FakePage } from "../src/fake-backend.ts";

/** The site every backend is tested on. A backend's harness must serve these pages. */
export const SITE: Record<string, FakePage> = {
  "https://site.test/": { title: "Home", text: "Welcome home", elements: [{ ref: "e1", role: "link", name: "Prices", goto: "https://site.test/prices" }] },
  "https://site.test/prices": { title: "Prices", text: "Widget: 10 euros", elements: [] },
  "https://site.test/form": {
    title: "Form",
    text: "Enter a coupon",
    elements: [{ ref: "e1", role: "textbox", name: "Coupon", field: "coupon", submitGoto: "https://site.test/done" }],
  },
  "https://site.test/done": { title: "Done", text: "Coupon accepted", elements: [] },
};

/** What every BrowserBackend must do, as tests. The fake and the worker adapter both pass it; a backend over a real browser must too. */
export function browserBackendContract(name: string, create: () => Promise<{ backend: BrowserBackend; cleanup(): Promise<void> }>): void {
  describe(`browser backend contract: ${name}`, () => {
    async function withBackend(body: (backend: BrowserBackend) => Promise<void>) {
      const made = await create();
      try {
        await body(made.backend);
      } finally {
        await made.cleanup();
      }
    }

    it("opens a page in a new tab and says where it is", async () => {
      await withBackend(async (b) => {
        const page = await b.open("https://site.test/");
        expect(page).toMatchObject({ url: "https://site.test/", title: "Home" });
        expect(page.tab).toBeTruthy();
      });
    });

    it("snapshots the text and the elements with refs", async () => {
      await withBackend(async (b) => {
        const { tab } = await b.open("https://site.test/");
        const shot = await b.snapshot(tab);
        expect(shot.text).toContain("Welcome home");
        expect(shot.title).toBe("Home");
        expect(shot.elements).toContainEqual(expect.objectContaining({ ref: "e1", name: "Prices" }));
      });
    });

    it("clicks a link, navigates, reads text, and scrolls", async () => {
      await withBackend(async (b) => {
        const { tab } = await b.open("https://site.test/");
        expect(await b.click(tab, "e1")).toMatchObject({ url: "https://site.test/prices", title: "Prices" });
        expect((await b.snapshot(tab)).text).toContain("Widget: 10 euros");
        expect(await b.navigate(tab, "https://site.test/")).toMatchObject({ title: "Home" });
        expect(await b.readText(tab, "e1")).toContain("Prices");
        expect(await b.scroll(tab, "down", 300)).toMatchObject({ tab });
      });
    });

    it("types into a field and submits", async () => {
      await withBackend(async (b) => {
        const { tab } = await b.open("https://site.test/form");
        expect(await b.type(tab, "e1", "SAVE10", true)).toMatchObject({ url: "https://site.test/done", title: "Done" });
        expect((await b.snapshot(tab)).text).toContain("Coupon accepted");
      });
    });

    it("keeps tabs apart: acting on one does not change the other", async () => {
      await withBackend(async (b) => {
        const first = await b.open("https://site.test/");
        const second = await b.open("https://site.test/form");
        expect(second.tab).not.toBe(first.tab);
        await b.click(first.tab, "e1");
        expect((await b.snapshot(second.tab)).title).toBe("Form");
        expect((await b.snapshot(first.tab)).title).toBe("Prices");
        await b.type(second.tab, "e1", "x", true);
        expect((await b.snapshot(first.tab)).title).toBe("Prices");
      });
    });

    it("takes a screenshot and gives its path", async () => {
      await withBackend(async (b) => {
        const { tab } = await b.open("https://site.test/");
        const shot = await b.screenshot(tab);
        expect(shot.path).toMatch(/\.png$/);
      });
    });

    it("rejects an element that is not on the page, with a message", async () => {
      await withBackend(async (b) => {
        const { tab } = await b.open("https://site.test/prices");
        await expect(b.click(tab, "e99")).rejects.toThrow();
      });
    });

    it("lets go of a tab it was told to close", async () => {
      await withBackend(async (b) => {
        const { tab } = await b.open("https://site.test/");
        await expect(b.close(tab)).resolves.toBeUndefined();
      });
    });
  });
}
