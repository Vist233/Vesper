import { describe, expect, it } from "vitest";
import type { DesktopBackend } from "../src/backend.ts";

export interface DesktopHarness {
  backend: DesktopBackend;
  /** What was done to the desktop, as `click w1`, `set w2=720`, `type hi`, `key ctrl+s`, `scroll 0,300`, `screenshot`. */
  actions(): string[];
  cleanup(): Promise<void>;
}

/** The screen every backend is tested on: a Save button `w1` and a Width field `w2`. */
export const ELEMENTS = [
  { ref: "w1", role: "push button", name: "Save" },
  { ref: "w2", role: "text", name: "Width" },
];

/** What every DesktopBackend must do, as tests. The fake and the gui-kit adapter pass it; a backend on a real desktop must too. */
export function desktopBackendContract(name: string, create: () => Promise<DesktopHarness>): void {
  describe(`desktop backend contract: ${name}`, () => {
    async function withDesktop(body: (h: DesktopHarness) => Promise<void>) {
      const made = await create();
      try {
        await body(made);
      } finally {
        await made.cleanup();
      }
    }

    it("reads the tree: text with one line per element and the elements with their refs", async () => {
      await withDesktop(async ({ backend }) => {
        const tree = await backend.tree();
        expect(tree.elements).toEqual(ELEMENTS);
        expect(tree.text).toContain('w1 push button "Save"');
        expect(tree.text).toContain('w2 text "Width"');
      });
    });

    it("acts on elements by ref: click and set", async () => {
      await withDesktop(async ({ backend, actions }) => {
        await backend.tree();
        await backend.click({ ref: "w1" });
        await backend.set("w2", "720");
        expect(actions().filter((a) => a.startsWith("click") || a.startsWith("set"))).toEqual(["click w1", "set w2=720"]);
      });
    });

    it("clicks a position, types, presses a key and scrolls on the focused window", async () => {
      await withDesktop(async ({ backend, actions }) => {
        await backend.click({ x: 40, y: 50 });
        await backend.type("hello world");
        await backend.key("ctrl+s");
        await backend.scroll(0, 300);
        expect(actions()).toEqual(["click 40,50", "type hello world", "key ctrl+s", "scroll 0,300"]);
      });
    });

    it("refuses a ref that is not on the screen, with a message that says to read the tree again", async () => {
      await withDesktop(async ({ backend }) => {
        await backend.tree();
        await expect(backend.click({ ref: "w99" })).rejects.toThrow();
        await expect(backend.set("w99", "x")).rejects.toThrow();
      });
    });

    it("takes a screenshot and gives a PNG path", async () => {
      await withDesktop(async ({ backend }) => {
        const shot = await backend.screenshot();
        expect(shot.mediaType).toBe("image/png");
        expect(shot.path).toMatch(/\.png$/);
      });
    });
  });
}
