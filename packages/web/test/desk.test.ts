import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesk } from "../src/desk.js";

class FakeRfb {
  static all: FakeRfb[] = [];
  viewOnly = false;
  scaleViewport = false;
  disconnected = false;
  focused = 0;
  listeners = new Map<string, ((event: unknown) => void)[]>();
  target: unknown;
  url: string;
  options: unknown;
  constructor(target: unknown, url: string, options: unknown) {
    this.target = target;
    this.url = url;
    this.options = options;
    FakeRfb.all.push(this);
  }
  addEventListener(name: string, fn: (event: unknown) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  emit(name: string, detail?: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn({ detail });
  }
  disconnect() {
    this.disconnected = true;
  }
  focus() {
    this.focused += 1;
  }
  keys: unknown[][] = [];
  sendKey(...args: unknown[]) {
    this.keys.push(args);
  }
}

const visibility: (() => void)[] = [];
let hidden = false;
beforeEach(() => {
  FakeRfb.all = [];
  visibility.length = 0;
  hidden = false;
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:8080" });
  vi.stubGlobal("document", {
    get hidden() {
      return hidden;
    },
    addEventListener: (_name: string, fn: () => void) => visibility.push(fn),
    removeEventListener: (_name: string, fn: () => void) => visibility.splice(visibility.indexOf(fn), 1),
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup(overrides: Record<string, unknown> = {}) {
  const changes: [string, string][] = [];
  const calls: string[] = [];
  const api = {
    liveView: async (id: string) => {
      calls.push(`view:${id}`);
      return { url: "/ws/s_a/view?ticket=v1" };
    },
    takeover: async (id: string) => {
      calls.push(`takeover:${id}`);
      return { url: "/ws/s_a/takeover?ticket=t1", since: 1 };
    },
    handback: async (id: string, note: string) => void calls.push(`handback:${id}:${note}`),
    insertText: async (id: string, text: string) => {
      calls.push(`insert:${id}:${text}`);
      return { inserted: [...text].length };
    },
  };
  const screen = { replaceChildren: vi.fn() } as unknown as HTMLElement;
  const desk = createDesk({
    api,
    screen,
    onChange: (mode, message) => changes.push([mode, message]),
    report: vi.fn(),
    hiddenMs: 30,
    keyDelayMs: 1,
    retryDelaysMs: [],
    loadViewer: async () => FakeRfb,
    ...overrides,
  });
  return { desk, changes, calls, screen };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the desk", () => {
  it("watches first: a view ticket, a view-only picture that scales to the window", async () => {
    const { desk, changes, calls } = setup();
    await desk.open("s_a");
    const rfb = FakeRfb.all[0];
    expect(calls).toEqual(["view:s_a"]);
    expect(rfb?.url).toBe("ws://127.0.0.1:8080/ws/s_a/view?ticket=v1");
    expect(rfb).toMatchObject({ viewOnly: true, scaleViewport: true });
    rfb?.emit("connect");
    expect(changes.at(-1)).toEqual(["view", ""]);
  });

  it("take over is a new ticket and a new connection with input, and the keyboard goes to the desktop", async () => {
    const { desk, changes, calls } = setup();
    await desk.open("s_a");
    FakeRfb.all[0]?.emit("connect");
    await desk.takeover();
    const [view, control] = FakeRfb.all;
    expect(view?.disconnected).toBe(true); // the old connection never changes mode; it is dropped
    expect(control?.url).toContain("/takeover?ticket=t1");
    expect(control).toMatchObject({ viewOnly: false, scaleViewport: true });
    control?.emit("connect");
    expect(control?.focused).toBe(1);
    expect(changes.at(-1)).toEqual(["control", ""]);
    expect(calls).toEqual(["view:s_a", "takeover:s_a"]);
  });

  it("opening straight into control (a reload in the middle of a take-over) asks for the control ticket only", async () => {
    const { desk, calls } = setup();
    await desk.open("s_a", "control");
    expect(calls).toEqual(["takeover:s_a"]);
  });

  it("hand back sends the note and goes back to watching", async () => {
    const { desk, calls } = setup();
    await desk.open("s_a", "control");
    FakeRfb.all[0]?.emit("connect");
    await desk.handback("signed in");
    expect(calls).toEqual(["takeover:s_a", "handback:s_a:signed in", "view:s_a"]);
    expect(FakeRfb.all[1]).toMatchObject({ viewOnly: true });
  });

  it("a failed hand-back is reported and keeps the person in control", async () => {
    const report = vi.fn();
    const { desk, calls } = setup({
      report,
      api: {
        liveView: async () => ({ url: "/x" }),
        takeover: async () => ({ url: "/ws/s_a/takeover?ticket=t", since: 1 }),
        handback: async () => {
          throw new Error("down");
        },
      },
    });
    await desk.open("s_a", "control");
    FakeRfb.all[0]?.emit("connect");
    await desk.handback("note");
    expect(report).toHaveBeenCalledTimes(1);
    expect(FakeRfb.all).toHaveLength(1);
    expect(FakeRfb.all[0]?.disconnected).toBe(false);
    expect(calls).toEqual([]);
  });

  it("closing disconnects, so nothing streams behind a closed window", async () => {
    const { desk, changes, screen } = setup();
    await desk.open("s_a");
    FakeRfb.all[0]?.emit("connect");
    desk.close();
    expect(FakeRfb.all[0]?.disconnected).toBe(true);
    expect(changes.at(-1)?.[0]).toBe("closed");
    expect(screen.replaceChildren).toHaveBeenCalled();
  });

  it("a late answer for an old attempt is thrown away", async () => {
    let release: (value: { url: string }) => void = () => {};
    const slow = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    const { desk } = setup({
      api: {
        liveView: () => slow,
        takeover: async () => ({ url: "/ws/s_a/takeover?ticket=t", since: 1 }),
        handback: async () => {},
        insertText: async () => ({ inserted: 0 }),
      },
    });
    const first = desk.open("s_a");
    desk.close();
    release({ url: "/ws/s_a/view?ticket=late" });
    await first;
    expect(FakeRfb.all).toEqual([]);
  });

  it("says plainly when the session has no desktop yet, and when the picture is lost", async () => {
    const report = vi.fn();
    const { desk, changes } = setup({
      report,
      api: {
        liveView: async () => {
          throw Object.assign(new Error("x"), { kind: "unavailable" });
        },
        takeover: async () => ({ url: "", since: 0 }),
        handback: async () => {},
        insertText: async () => ({ inserted: 0 }),
      },
    });
    await desk.open("s_a");
    expect(changes.at(-1)).toEqual(["failed", "The browser did not start. Try again."]);
    expect(report).not.toHaveBeenCalled();
    const second = setup();
    await second.desk.open("s_a");
    FakeRfb.all.at(-1)?.emit("connect");
    FakeRfb.all.at(-1)?.emit("disconnect", { clean: false });
    expect(second.changes.at(-1)).toEqual(["failed", "The picture was lost."]);
  });

  it("a hidden tab disconnects after the limit and comes back with a fresh ticket when shown again", async () => {
    const { desk, calls, changes } = setup();
    await desk.open("s_a");
    FakeRfb.all[0]?.emit("connect");
    hidden = true;
    for (const fn of visibility) fn();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(FakeRfb.all[0]?.disconnected).toBe(true);
    expect(changes.at(-1)?.[1]).toContain("hidden");
    hidden = false;
    for (const fn of visibility) fn();
    await tick();
    expect(calls).toEqual(["view:s_a", "view:s_a"]);
    expect(FakeRfb.all).toHaveLength(2);
  });

  it("a tab that comes back before the limit keeps its picture", async () => {
    const { desk, calls } = setup();
    await desk.open("s_a");
    hidden = true;
    for (const fn of visibility) fn();
    hidden = false;
    for (const fn of visibility) fn();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(FakeRfb.all[0]?.disconnected).toBe(false);
    expect(calls).toEqual(["view:s_a"]);
  });

  it("switching session drops the old picture", async () => {
    const { desk } = setup();
    await desk.open("s_a");
    desk.switchSession();
    expect(FakeRfb.all[0]?.disconnected).toBe(true);
  });

  it("types text key by key, in control only, and stops when the window is closed", async () => {
    const { desk } = setup();
    await desk.open("s_a");
    FakeRfb.all[0]?.emit("connect");
    expect(await desk.sendText("x")).toBe(0); // watching: nothing is typed
    await desk.takeover();
    const control = FakeRfb.all[1];
    control?.emit("connect");
    expect(await desk.sendText("p@ss!\n")).toBe(6);
    expect(control?.keys).toEqual([
      [0x70, null],
      [0x40, null],
      [0x73, null],
      [0x73, null],
      [0x21, null],
      [0xff0d, null],
    ]);
    const long = desk.sendText("a".repeat(50));
    desk.close();
    expect(await long).toBeLessThan(50);
  });

  it("retries a view that never came up (the workspace is still starting) with the waiting message, never 'closed'", async () => {
    vi.useFakeTimers();
    try {
      const { desk, changes } = setup({ retryDelaysMs: [1000, 2000] });
      await desk.open("s_a");
      FakeRfb.all[0]?.emit("disconnect", { clean: true }); // refused before it was ever up
      expect(changes.at(-1)).toEqual(["connecting", "Starting the browser..."]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeRfb.all).toHaveLength(2);
      FakeRfb.all[1]?.emit("disconnect", { clean: false });
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeRfb.all).toHaveLength(3);
      FakeRfb.all[2]?.emit("connect");
      expect(changes.at(-1)).toEqual(["view", ""]);
      expect(changes.some(([, message]) => message.includes("closed"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the last delay and offers a reconnect that starts the counting again", async () => {
    vi.useFakeTimers();
    try {
      const { desk, changes, calls } = setup({ retryDelaysMs: [10] });
      await desk.open("s_a");
      FakeRfb.all[0]?.emit("disconnect", {});
      await vi.advanceTimersByTimeAsync(10);
      FakeRfb.all[1]?.emit("disconnect", {});
      expect(changes.at(-1)).toEqual(["failed", "The browser did not start. Try again."]);
      await desk.reconnect();
      expect(calls).toEqual(["view:s_a", "view:s_a", "view:s_a"]);
      expect(changes.at(-1)?.[0]).toBe("connecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an API error that is not 'no desktop yet' also retries, and is reported once at the end", async () => {
    vi.useFakeTimers();
    try {
      const report = vi.fn();
      let n = 0;
      const { desk } = setup({
        report,
        retryDelaysMs: [5, 5],
        api: {
          liveView: async () => {
            n += 1;
            throw new Error("boom");
          },
          takeover: async () => ({ url: "", since: 0 }),
          handback: async () => {},
          insertText: async () => ({ inserted: 0 }),
        },
      });
      await desk.open("s_a");
      await vi.advanceTimersByTimeAsync(20);
      expect(n).toBe(3);
      expect(report).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing while a retry is waiting cancels it", async () => {
    vi.useFakeTimers();
    try {
      const { desk, calls } = setup({ retryDelaysMs: [100] });
      await desk.open("s_a");
      FakeRfb.all[0]?.emit("disconnect", {});
      desk.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toEqual(["view:s_a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends text with any non-ASCII character as a whole through the page-input route, not as keys", async () => {
    const { desk, calls } = setup();
    await desk.open("s_a", "control");
    const control = FakeRfb.all[0];
    control?.emit("connect");
    expect(await desk.sendText("密码 p@ss 😀")).toBe(9);
    expect(control?.keys).toEqual([]);
    expect(calls).toContain("insert:s_a:密码 p@ss 😀");
    expect(await desk.sendText("plain!")).toBe(6); // ASCII keeps the key path
    expect(control?.keys).toHaveLength(6);
  });

  it("reports a refused insertion and types nothing", async () => {
    const report = vi.fn();
    const { desk } = setup({
      report,
      api: {
        liveView: async () => ({ url: "/x" }),
        takeover: async () => ({ url: "/ws/s_a/takeover?ticket=t", since: 1 }),
        handback: async () => {},
        insertText: async () => {
          throw new Error("denied");
        },
      },
    });
    await desk.open("s_a", "control");
    FakeRfb.all[0]?.emit("connect");
    expect(await desk.sendText("你好")).toBe(0);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("in watch mode nothing is inserted either", async () => {
    const { desk, calls } = setup();
    await desk.open("s_a");
    FakeRfb.all[0]?.emit("connect");
    expect(await desk.sendText("你好")).toBe(0);
    expect(calls).toEqual(["view:s_a"]);
  });
});
