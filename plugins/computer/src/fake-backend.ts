import type { DesktopBackend, DesktopElement } from "./backend.ts";

/** A desktop in memory that records what was done to it; also the demo backend (a display whose name starts with `fake:`). */
export function createFakeDesktop(elements: DesktopElement[] = [{ ref: "w1", role: "button", name: "Save" }]): DesktopBackend & { actions: string[] } {
  const actions: string[] = [];
  return {
    actions,
    async tree() {
      return { text: elements.map((e) => `${e.ref} ${e.role} "${e.name}"`).join("\n"), elements };
    },
    async screenshot() {
      actions.push("screenshot");
      return { path: "/fake/screen.png", mediaType: "image/png" };
    },
    async click(target) {
      if ("ref" in target && !elements.some((e) => e.ref === target.ref)) throw new Error(`no element '${target.ref}' (read the tree again)`);
      actions.push(`click ${"ref" in target ? target.ref : `${target.x},${target.y}`}`);
    },
    async type(text) {
      actions.push(`type ${text}`);
    },
    async drag(x, y, toX, toY) {
      actions.push(`drag ${x},${y} ${toX},${toY}`);
    },
    async set(ref, text) {
      if (!elements.some((e) => e.ref === ref)) throw new Error(`no element '${ref}' (read the tree again)`);
      actions.push(`set ${ref}=${text}`);
    },
    async key(key) {
      actions.push(`key ${key}`);
    },
    async scroll(dx, dy) {
      actions.push(`scroll ${dx},${dy}`);
    },
  };
}
