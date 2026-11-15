import { describe, expect, it } from "vitest";
import { createFakeDesktop } from "../src/fake-backend.ts";
import { createGuiKitBackend } from "../src/gui-kit-backend.ts";
import { desktopBackendContract, ELEMENTS } from "./contract.ts";
import { createFakeKit, foldScrolls } from "./fake-kit.ts";

desktopBackendContract("in-memory fake", async () => {
  const backend = createFakeDesktop(ELEMENTS);
  return { backend, actions: () => backend.actions.filter((a) => a !== "screenshot"), cleanup: async () => {} };
});

desktopBackendContract("the owner's gui kit (over a fake kit)", async () => {
  const kit = createFakeKit();
  return { backend: createGuiKitBackend({ run: kit.run }), actions: () => foldScrolls(kit.actions).filter((a) => a !== "screenshot"), cleanup: async () => {} };
});

describe("the gui-kit adapter", () => {
  it("uses the vendored coordinate drag and reports a failed pointer operation", async () => {
    const run = async (command: readonly string[]) => {
      expect(command.slice(2)).toEqual(["drag", "--xy", "20,30", "--to-xy", "80,100", "--no-human"]);
      return { exitCode: 0, stdout: '{"ok":true,"data":{"ok":false},"error":null}', stderr: "", timedOut: false, truncated: false };
    };
    await expect(createGuiKitBackend({ run }).drag(20, 30, 80, 100)).rejects.toThrow("could not complete the drag");
  });

  it("draws a path with one xdotool call: press, move through the points, release", async () => {
    const calls: string[][] = [];
    const run = async (command: readonly string[]) => {
      calls.push([...command]);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    };
    await createGuiKitBackend({ run }).path([
      { x: 1.4, y: 2 },
      { x: 5, y: 6 },
    ]);
    expect(calls.at(-1)).toEqual(["xdotool", "mousemove", "1", "2", "mousedown", "1", "mousemove", "5", "6", "sleep", "0.01", "mouseup", "1"]);
  });

  it("runs the kit's observe and act scripts with the snapshot id, and passes the extra environment of the private desktop", async () => {
    const kit = createFakeKit();
    const backend = createGuiKitBackend({
      run: kit.run,
      kitDirectory: "/kit",
      app: "Pinta",
      limit: 40,
      env: { XDG_RUNTIME_DIR: "/tmp/xdg-a", RTS_DBUS_FILE: "/tmp/dbus.addr" },
    });
    await backend.tree();
    await backend.click({ ref: "w1" });
    await backend.set("w2", "720");
    expect(kit.commands[0]?.command).toEqual(["python3", "/kit/refagent-tools/tools/observe.py", "--app", "Pinta", "--limit", "40"]);
    expect(kit.commands[1]?.command).toEqual(["python3", "/kit/refagent-tools/tools/act.py", "click", "--snapshot", "s1", "--ref", "w1"]);
    expect(kit.commands[2]?.command).toEqual(["python3", "/kit/refagent-tools/tools/act.py", "set", "--snapshot", "s1", "--ref", "w2", "--text", "720"]);
    for (const c of kit.commands) expect(c.env).toEqual({ XDG_RUNTIME_DIR: "/tmp/xdg-a", RTS_DBUS_FILE: "/tmp/dbus.addr" });
  });

  it("refuses to act on a ref before the tree was read, and reports the kit's error code and message", async () => {
    const kit = createFakeKit();
    const backend = createGuiKitBackend({ run: kit.run });
    await expect(backend.click({ ref: "w1" })).rejects.toThrow(/read the tree first/);
    await backend.tree();
    await expect(backend.click({ ref: "w99" })).rejects.toThrow(/REF_NOT_FOUND: w99 is not in s1/);
  });

  it("uses a fresh snapshot after each tree read", async () => {
    const kit = createFakeKit();
    const backend = createGuiKitBackend({ run: kit.run });
    await backend.tree();
    await backend.tree();
    await backend.click({ ref: "w1" });
    expect(kit.commands.at(-1)?.command).toContain("s2");
  });

  it("types, presses keys and scrolls with xdotool, passing text after `--` so it cannot be read as an option", async () => {
    const kit = createFakeKit();
    const backend = createGuiKitBackend({ run: kit.run });
    await backend.type("--clearmodifiers -rm");
    await backend.key("ctrl+a");
    await backend.scroll(-250, 0);
    const xdotool = kit.commands.filter((c) => c.command[0] === "xdotool").map((c) => c.command.slice(1));
    expect(xdotool[0]).toEqual(["type", "--clearmodifiers", "--delay", "20", "--", "--clearmodifiers -rm"]);
    expect(xdotool[1]).toEqual(["key", "--clearmodifiers", "--", "ctrl+a"]);
    expect(xdotool.slice(2)).toEqual([
      ["click", "6"],
      ["click", "6"],
      ["click", "6"],
    ]);
  });

  it("limits a scroll to 20 wheel steps and turns a failing X tool into an error", async () => {
    const kit = createFakeKit();
    await createGuiKitBackend({ run: kit.run }).scroll(0, 100_000);
    expect(kit.commands.filter((c) => c.command[0] === "xdotool")).toHaveLength(20);
    const failing = createGuiKitBackend({ run: async () => ({ exitCode: 1, stdout: "", stderr: "no display", timedOut: false, truncated: false }) });
    await expect(failing.key("Enter")).rejects.toThrow(/xdotool failed \(exit 1\): no display/);
    await expect(failing.screenshot()).rejects.toThrow(/screenshot failed/);
  });

  it("turns an unreadable or timed-out tool run into an error", async () => {
    const base = { exitCode: 0, stderr: "", truncated: false };
    await expect(createGuiKitBackend({ run: async () => ({ ...base, stdout: "Traceback...", timedOut: false }) }).tree()).rejects.toThrow(
      /did not answer with JSON/,
    );
    await expect(createGuiKitBackend({ run: async () => ({ ...base, stdout: "", timedOut: true }) }).tree()).rejects.toThrow(/timed out/);
    await expect(
      createGuiKitBackend({ run: async () => ({ ...base, stdout: JSON.stringify({ ok: true, data: {}, error: null }), timedOut: false }) }).tree(),
    ).rejects.toThrow(/no snapshot id/);
  });

  it("says when the tree is cut, and writes screenshots to its own directory", async () => {
    const run = async (command: readonly string[]) => {
      const text = command[1]?.endsWith("observe.py")
        ? JSON.stringify({ ok: true, data: { snapshot: "s9", app: "Big", count: 500, returned: 120, truncated: true, items: [] }, error: null })
        : "";
      return { exitCode: 0, stdout: text, stderr: "", timedOut: false, truncated: false };
    };
    const backend = createGuiKitBackend({ run, screenshotDirectory: "/shots" });
    expect((await backend.tree()).text).toContain("120 of 500 elements (more not shown");
    expect((await backend.screenshot()).path).toMatch(/^\/shots\/screen-\d+-1\.png$/);
  });
});
