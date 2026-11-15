import type { Tool, ToolResult } from "sakura-agent";
import type { DesktopBackend } from "./backend.ts";

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

/** The helper's own tool. It is never given to the main agent: the helper gets it when `computer` starts it. */
export function createDesktopTool(backend: DesktopBackend): Tool {
  return {
    name: "desktop",
    description:
      "Use the desktop. Actions: tree (read the accessibility tree first), screenshot, click (ref, or x and y), drag (x, y, toX, toY), set (ref, text), type (text), key (such as Enter or ctrl+s), scroll (dy, dx).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["tree", "screenshot", "click", "drag", "set", "type", "key", "scroll"] },
        ref: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        toX: { type: "number" },
        toY: { type: "number" },
        text: { type: "string" },
        key: { type: "string" },
        dx: { type: "number" },
        dy: { type: "number" },
      },
      required: ["action"],
    },
    effect: "exec",
    replay: "never",
    async execute(args) {
      const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      try {
        switch (input.action) {
          case "tree":
            return text((await backend.tree()).text);
          case "screenshot": {
            const shot = await backend.screenshot();
            return { content: [{ type: "image", mediaType: shot.mediaType, ref: shot.path }] };
          }
          case "click":
            if (typeof input.ref === "string") await backend.click({ ref: input.ref });
            else if (typeof input.x === "number" && typeof input.y === "number") await backend.click({ x: input.x, y: input.y });
            else return text("click needs 'ref' or both 'x' and 'y'.", true);
            return text("Clicked.");
          case "set":
            if (typeof input.ref !== "string" || typeof input.text !== "string") return text("'ref' and 'text' are required for set.", true);
            await backend.set(input.ref, input.text);
            return text("Set.");
          case "drag": {
            const { x, y, toX, toY } = input;
            if (![x, y, toX, toY].every((value): value is number => typeof value === "number" && Number.isFinite(value)))
              return text("drag needs finite x, y, toX and toY coordinates.", true);
            await backend.drag(x as number, y as number, toX as number, toY as number);
            return text("Dragged. Check the result on the desktop.");
          }
          case "type":
            if (typeof input.text !== "string") return text("'text' is required for type.", true);
            await backend.type(input.text);
            return text("Typed.");
          case "key":
            if (typeof input.key !== "string") return text("'key' is required for key.", true);
            await backend.key(input.key);
            return text("Pressed.");
          case "scroll":
            await backend.scroll(typeof input.dx === "number" ? input.dx : 0, typeof input.dy === "number" ? input.dy : 0);
            return text("Scrolled.");
          default:
            return text("'action' must be one of tree, screenshot, click, drag, set, type, key, scroll.", true);
        }
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}
