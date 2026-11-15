import type { HelperRunner, HelperSpec } from "@vesper/contracts";
import type { Tool, ToolContext } from "sakura-agent";
import { describe, expect, it } from "vitest";
import { createFakeDesktop } from "../src/fake-backend.ts";
import { DisplayLease } from "../src/lease.ts";
import { createComputerTool, HELPER_INSTRUCTIONS } from "../src/tool.ts";

const context = (signal = new AbortController().signal) => ({ signal, log: {} }) as unknown as ToolContext;
const REASON = "No command or API reaches this desktop-only dialog, and the browser does not show it.";
const out = (result: { content: unknown[]; isError?: boolean }) => ({ text: (result.content[0] as { text: string }).text, isError: result.isError === true });

function helpersThat(handler: (spec: HelperSpec) => Promise<{ reason: "done" | "cancelled" | "paused" | "error"; text: string }>) {
  const specs: HelperSpec[] = [];
  const helpers: HelperRunner = {
    run: async (spec) => {
      specs.push(spec);
      return handler(spec);
    },
  };
  return { helpers, specs };
}

describe("the computer tool", () => {
  it("requires a real why_not_cheaper and a task, and does not start a helper without them", async () => {
    const { helpers, specs } = helpersThat(async () => ({ reason: "done", text: "x" }));
    const tool = createComputerTool({ backend: createFakeDesktop(), helpers });
    expect(out(await tool.execute({ task: "click save" }, context()))).toMatchObject({
      isError: true,
      text: expect.stringContaining("'why_not_cheaper' is required"),
    });
    expect(out(await tool.execute({ task: "click save", why_not_cheaper: "too hard" }, context())).isError).toBe(true);
    expect(out(await tool.execute({ task: "click save", why_not_cheaper: 5 }, context())).isError).toBe(true);
    expect(out(await tool.execute({ why_not_cheaper: REASON }, context()))).toMatchObject({ isError: true, text: expect.stringContaining("'task'") });
    expect(out(await tool.execute(null, context())).isError).toBe(true);
    expect(specs).toEqual([]);
    expect(JSON.stringify(tool.parameters)).toContain('"required":["task","why_not_cheaper"]');
    expect(tool).toMatchObject({ name: "computer", effect: "exec", replay: "never" });
  });

  it("runs the helper with the desktop tool only inside the helper and returns the helper's report", async () => {
    const backend = createFakeDesktop();
    const { helpers, specs } = helpersThat(async (spec) => {
      const desktop = spec.tools[0] as Tool;
      await desktop.execute({ action: "tree" }, context());
      await desktop.execute({ action: "click", ref: "w1" }, context());
      return { reason: "done", text: "Saved the file; the title bar now shows 'report.odt'." };
    });
    const tool = createComputerTool({ backend, helpers, maxTurns: 12 });
    const result = out(await tool.execute({ task: "Press Save in the open dialog", why_not_cheaper: REASON }, context()));
    expect(result).toEqual({ text: "Saved the file; the title bar now shows 'report.odt'.", isError: false });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ task: "Press Save in the open dialog", instructions: HELPER_INSTRUCTIONS, maxTurns: 12 });
    expect(((specs[0]?.tools ?? []) as Tool[]).map((t) => t.name)).toEqual(["desktop"]);
    expect(backend.actions).toEqual(["click w1"]);
  });

  it("holds the display lease while a helper works: a second call is refused, and it can try again afterwards", async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { helpers } = helpersThat(async () => {
      await gate;
      return { reason: "done", text: "first done" };
    });
    const tool = createComputerTool({ backend: createFakeDesktop(), helpers });
    const first = tool.execute({ task: "a", why_not_cheaper: REASON }, context());
    await new Promise((r) => setTimeout(r, 10));
    expect(out(await tool.execute({ task: "b", why_not_cheaper: REASON }, context()))).toMatchObject({
      isError: true,
      text: expect.stringContaining("being used by another helper"),
    });
    finish();
    expect(out(await first).text).toBe("first done");
    expect(out(await tool.execute({ task: "c", why_not_cheaper: REASON }, context())).text).toBe("first done"); // lease is free again
  });

  it("releases the lease when the helper fails, and reports a helper that stopped early as an error", async () => {
    let mode: "throw" | "paused" | "empty" = "throw";
    const { helpers } = helpersThat(async () => {
      if (mode === "throw") throw new Error("model down");
      return mode === "paused" ? { reason: "paused" as const, text: "got stuck on a login" } : { reason: "done" as const, text: "  " };
    });
    const tool = createComputerTool({ backend: createFakeDesktop(), helpers });
    const args = { task: "t", why_not_cheaper: REASON };
    expect(out(await tool.execute(args, context()))).toEqual({ text: "The helper failed: model down", isError: true });
    mode = "paused";
    expect(out(await tool.execute(args, context()))).toEqual({ text: "The helper stopped early (paused). got stuck on a login", isError: true });
    mode = "empty";
    expect(out(await tool.execute(args, context()))).toEqual({ text: "(the helper gave no report)", isError: false });
  });

  it("passes the call's abort signal to the helper", async () => {
    const controller = new AbortController();
    const { helpers, specs } = helpersThat(async () => ({ reason: "done", text: "ok" }));
    await createComputerTool({ backend: createFakeDesktop(), helpers }).execute({ task: "t", why_not_cheaper: REASON }, context(controller.signal));
    expect(specs[0]?.signal).toBe(controller.signal);
  });
});

describe("the desktop tool the helper gets", () => {
  async function desktopTool() {
    const backend = createFakeDesktop([{ ref: "w1", role: "button", name: "Save" }]);
    let tool: Tool | undefined;
    const helpers: HelperRunner = {
      run: async (spec) => {
        tool = spec.tools[0] as Tool;
        return { reason: "done", text: "ok" };
      },
    };
    await createComputerTool({ backend, helpers }).execute({ task: "t", why_not_cheaper: REASON }, context());
    return { backend, tool: tool as Tool };
  }

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

describe("DisplayLease", () => {
  it("is held by one owner until released, and a release works once", () => {
    const lease = new DisplayLease();
    const release = lease.acquire("a");
    expect(lease.heldBy()).toBe("a");
    expect(lease.acquire("b")).toBeUndefined();
    release?.();
    release?.();
    expect(lease.heldBy()).toBeUndefined();
    const second = lease.acquire("b");
    release?.(); // a stale release does not free b's lease
    expect(lease.heldBy()).toBe("b");
    second?.();
  });
});
