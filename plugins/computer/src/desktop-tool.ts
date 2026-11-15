import type { Tool, ToolResult } from "sakura-agent";
import type { DesktopBackend } from "./backend.ts";

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

/**
 * The desktop of the bot's workspace, for the agent itself and for its sub-agents. Actions run one at a time: two agents
 * moving the same pointer would undo each other.
 */
export function createDesktopTool(backend: DesktopBackend): Tool {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    name: "desktop",
    description:
      "Use this workspace's desktop (programs, dialogs, drawing by hand). For a long desktop job, hand it to a sub-agent with delegate: it has this tool too and its screenshots stay out of your context. Actions: launch (program, args: a list of strings) starts a desktop program such as mtpaint, gimp or libreoffice (the desktop has no menu or terminal, so start programs this way, then wait a moment and look); tree (read the accessibility tree first), screenshot, click (ref, or x and y), drag (x, y, toX, toY), path (points: [{x, y}, ...], the left button held along them: a stroke for drawing by hand, up to 500 points; check with a screenshot), set (ref, text), type (text), key (such as Enter or ctrl+s), scroll (dy, dx).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["launch", "tree", "screenshot", "click", "drag", "path", "set", "type", "key", "scroll"] },
        program: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        points: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
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
    execute(args) {
      const run = queue.then(() => act(args));
      queue = run.catch(() => undefined);
      return run;
    },
  };
  async function act(args: unknown): Promise<ToolResult> {
    {
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
          case "launch": {
            const program = typeof input.program === "string" ? input.program.trim() : "";
            const args = Array.isArray(input.args) ? input.args : [];
            if (!/^[A-Za-z0-9._/+-]{1,200}$/.test(program) || program.startsWith("-"))
              return text("launch needs 'program': a program name or path, such as mtpaint.", true);
            if (args.length > 20 || !args.every((arg) => typeof arg === "string" && arg.length <= 1000))
              return text("'args' must be a list of at most 20 strings.", true);
            await backend.launch(program, args as string[]);
            return text(`Started ${program}. Wait a moment, then take a screenshot or read the tree to find its window.`);
          }
          case "path": {
            const points = Array.isArray(input.points) ? (input.points as { x?: unknown; y?: unknown }[]) : [];
            const valid = points.every(
              (point) => typeof point?.x === "number" && Number.isFinite(point.x) && typeof point?.y === "number" && Number.isFinite(point.y),
            );
            if (points.length < 2 || points.length > 500 || !valid) return text("path needs 2 to 500 points, each with finite x and y.", true);
            await backend.path(points as { x: number; y: number }[]);
            return text(`Drew a stroke through ${points.length} points. Check it with a screenshot.`);
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
            return text("'action' must be one of launch, tree, screenshot, click, drag, path, set, type, key, scroll.", true);
        }
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    }
  }
}
