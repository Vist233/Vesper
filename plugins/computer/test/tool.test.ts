import type { Tool, ToolContext } from "sakura-agent";
import { describe, expect, it } from "vitest";
import { createDesktopTool } from "../src/desktop-tool.ts";
import { createFakeDesktop } from "../src/fake-backend.ts";

const context = (signal = new AbortController().signal) => ({ signal, log: {} }) as unknown as ToolContext;
const out = (result: { content: unknown[]; isError?: boolean }) => ({ text: (result.content[0] as { text: string }).text, isError: result.isError === true });

describe("the desktop tool the agent and its sub-agents use", () => {
  async function desktopTool() {
    const backend = createFakeDesktop([{ ref: "w1", role: "button", name: "Save" }]);
    return { backend, tool: createDesktopTool(backend) as Tool };
  }

  it("runs actions one at a time, in order, even when two agents call at once", async () => {
    const { backend, tool } = await desktopTool();
    await Promise.all([
      tool.execute({ action: "click", x: 1, y: 1 }, context()),
      tool.execute({ action: "type", text: "a" }, context()),
      tool.execute({ action: "key", key: "Enter" }, context()),
    ]);
    expect(backend.actions).toEqual(["click 1,1", "type a", "key Enter"]);
  });

  it("reads the tree first, acts by ref or by position, types, presses keys, scrolls, and takes screenshots as images", async () => {
    const { backend, tool } = await desktopTool();
    expect(out(await tool.execute({ action: "tree" }, context())).text).toBe('w1 button "Save"');
    await tool.execute({ action: "click", ref: "w1" }, context());
    await tool.execute({ action: "click", x: 10, y: 20 }, context());
    await tool.execute({ action: "set", ref: "w1", text: "720" }, context());
    await tool.execute({ action: "type", text: "hello" }, context());
    await tool.execute({ action: "key", key: "ctrl+s" }, context());
    await tool.execute({ action: "scroll", dy: -3 }, context());
    const shot = await tool.execute({ action: "screenshot" }, context());
    expect(shot.content[0]).toEqual({ type: "image", mediaType: "image/png", ref: "/fake/screen.png" });
    expect(backend.actions).toEqual(["click w1", "click 10,20", "set w1=720", "type hello", "key ctrl+s", "scroll 0,-3", "screenshot"]);
  });

  it("starts a desktop program, since the bare desktop has no menu or terminal", async () => {
    const { backend, tool } = await desktopTool();
    expect(out(await tool.execute({ action: "launch", program: "mtpaint", args: ["house.png"] }, context())).text).toContain("Started mtpaint");
    expect(backend.actions).toEqual(["launch mtpaint house.png"]);
    for (const bad of [
      { action: "launch" },
      { action: "launch", program: "-rf" },
      { action: "launch", program: "a; rm" },
      { action: "launch", program: "x", args: [1] },
    ])
      expect(out(await tool.execute(bad, context())).isError, JSON.stringify(bad)).toBe(true);
  });

  it("draws a stroke with the button held along the points (drawing by hand)", async () => {
    const { backend, tool } = await desktopTool();
    const drawn = out(
      await tool.execute(
        {
          action: "path",
          points: [
            { x: 10, y: 10 },
            { x: 20, y: 15 },
            { x: 30, y: 10 },
          ],
        },
        context(),
      ),
    );
    expect(drawn.text).toContain("3 points");
    expect(backend.actions).toEqual(["path 10,10 20,15 30,10"]);
    for (const points of [
      [{ x: 1, y: 1 }],
      [
        { x: 1, y: 1 },
        { x: "a", y: 2 },
      ],
      Array.from({ length: 501 }, (_, i) => ({ x: i, y: i })),
    ])
      expect(out(await tool.execute({ action: "path", points }, context())).isError).toBe(true);
  });

  it("tells the helper what to do about bad input and unknown elements", async () => {
    const { tool } = await desktopTool();
    for (const [args, part] of [
      [{ action: "click" }, "needs 'ref' or both"],
      [{ action: "click", ref: "zz" }, "no element 'zz'"],
      [{ action: "set", ref: "w1" }, "'ref' and 'text' are required"],
      [{ action: "set", ref: "zz", text: "x" }, "no element 'zz'"],
      [{ action: "type" }, "'text' is required"],
      [{ action: "key" }, "'key' is required"],
      [{ action: "jump" }, "'action' must be one of"],
    ] as const) {
      expect(out(await tool.execute(args, context())), JSON.stringify(args)).toMatchObject({ isError: true, text: expect.stringContaining(part) });
    }
    expect(out(await tool.execute(null, context())).isError).toBe(true);
  });
});
