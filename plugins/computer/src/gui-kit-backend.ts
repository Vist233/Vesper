import { OgbError, type RunOptions, type RunResult } from "@vesper/contracts";
import type { DesktopBackend, DesktopElement } from "./backend.ts";

/** Where the image puts the vendored copy of the owner's desktop kit (image/Dockerfile copies the repository to /opt/ogb). */
const DEFAULT_KIT_DIRECTORY = "/opt/ogb/image/vendor/sandbox-tools/desktop";

export interface GuiKitOptions {
  /** `WorkspaceHandle.run`. The workspace's `DISPLAY` is already in its environment. */
  run(command: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Where the owner's kit is in the workspace image (default: the copy vendored into the image, `/opt/ogb/image/vendor/sandbox-tools/desktop`). */
  kitDirectory?: string;
  python?: string;
  /** Limits the tree to one application (the kit's `--app`). Default: all. */
  app?: string;
  /** How many tree rows to ask for (default 120; the kit reports `truncated` beyond it). */
  limit?: number;
  /** Extra environment for the kit, for example `XDG_RUNTIME_DIR` and `RTS_DBUS_FILE` of the private desktop. */
  env?: Record<string, string>;
  /** Where screenshots are written (default `/tmp/ogb-screens`). */
  screenshotDirectory?: string;
}

interface Envelope {
  ok: boolean;
  data: unknown;
  error: { code?: string; message?: string } | null;
}

/**
 * THE OWNER'S GUI KIT AS THE DESKTOP BACKEND (docs/decisions.md D-T5-12).
 *
 * Read from the kit's source: `observe.py` lists interactive elements with refs and a snapshot id; `act.py click|set|...`
 * acts on `--snapshot SID --ref REF` (semantic first, the pointer only as a fallback, with its own lease); every tool prints one
 * JSON envelope `{ ok, data, error: { code, message }, ms }`; `act.py type` and `key` need a ref or coordinates, so this adapter
 * types, presses keys and scrolls with `xdotool` on the focused window, and takes screenshots with ImageMagick's `import`
 * (both are in the kit's own requirements). NOT VERIFIED: none of it ran (it needs a Linux desktop with an accessibility bus);
 * the commands and the envelope are from the source, the `xdotool` and `import` uses are standard but untried here.
 */
export function createGuiKitBackend(options: GuiKitOptions): DesktopBackend {
  const kit = `${options.kitDirectory ?? DEFAULT_KIT_DIRECTORY}/refagent-tools/tools`;
  const python = options.python ?? "python3";
  const screens = options.screenshotDirectory ?? "/tmp/ogb-screens";
  const env = options.env;
  const runOptions = (extra: RunOptions = {}): RunOptions => ({ ...(env ? { env } : {}), timeoutMs: 60_000, ...extra });
  let snapshot: string | undefined;
  let shots = 0;

  async function tool(script: "observe" | "act", args: string[]): Promise<unknown> {
    const result = await options.run([python, `${kit}/${script}.py`, ...args], runOptions());
    if (result.timedOut) throw new OgbError("unavailable", `the desktop tool '${script}' timed out`);
    let envelope: Envelope;
    try {
      envelope = JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as Envelope;
    } catch {
      throw new OgbError("unavailable", `the desktop tool '${script}' did not answer with JSON (exit ${result.exitCode})`);
    }
    if (!envelope.ok) throw new Error(`${envelope.error?.code ?? "ERROR"}: ${envelope.error?.message ?? "the desktop tool failed"}`);
    return envelope.data;
  }

  async function xdotool(args: string[]): Promise<void> {
    const result = await options.run(["xdotool", ...args], runOptions({ timeoutMs: 15_000 }));
    if (result.exitCode !== 0) throw new Error(`xdotool failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
  }

  function requireSnapshot(): string {
    if (!snapshot) throw new Error("read the tree first (action 'tree'): refs belong to a snapshot");
    return snapshot;
  }

  return {
    async tree() {
      const data = (await tool("observe", [...(options.app ? ["--app", options.app] : []), "--limit", String(options.limit ?? 120)])) as {
        snapshot?: string;
        app?: string;
        count?: number;
        returned?: number;
        truncated?: boolean;
        items?: { ref: string; role?: string; name?: string }[];
      };
      if (typeof data.snapshot !== "string") throw new Error("the desktop tool returned no snapshot id");
      snapshot = data.snapshot;
      const elements: DesktopElement[] = (data.items ?? []).map((item) => ({ ref: item.ref, role: item.role ?? "", name: item.name ?? "" }));
      const header = `${data.app ?? "desktop"}: ${data.returned ?? elements.length} of ${data.count ?? elements.length} elements${data.truncated ? " (more not shown: narrow with an application)" : ""}`;
      return { text: [header, ...elements.map((e) => `${e.ref} ${e.role} "${e.name}"`)].join("\n"), elements };
    },
    async click(target) {
      if ("ref" in target) await tool("act", ["click", "--snapshot", requireSnapshot(), "--ref", target.ref]);
      else await tool("act", ["click", "--xy", `${Math.round(target.x)},${Math.round(target.y)}`]);
    },
    async set(ref, text) {
      await tool("act", ["set", "--snapshot", requireSnapshot(), "--ref", ref, "--text", text]);
    },
    async drag(x, y, toX, toY) {
      const data = (await tool("act", [
        "drag",
        "--xy",
        `${Math.round(x)},${Math.round(y)}`,
        "--to-xy",
        `${Math.round(toX)},${Math.round(toY)}`,
        "--no-human",
      ])) as { ok?: boolean } | null;
      if (!data?.ok) throw new Error("The desktop could not complete the drag.");
    },
    async type(text) {
      await xdotool(["type", "--clearmodifiers", "--delay", "20", "--", text]);
    },
    async key(key) {
      await xdotool(["key", "--clearmodifiers", "--", key]);
    },
    async scroll(dx, dy) {
      const steps = (amount: number, positive: string, negative: string) =>
        Array.from({ length: Math.min(20, Math.ceil(Math.abs(amount) / 100)) }, () => (amount > 0 ? positive : negative));
      for (const button of [...steps(dy, "5", "4"), ...steps(dx, "7", "6")]) await xdotool(["click", button]); // 4/5 vertical, 6/7 horizontal wheel buttons
    },
    async screenshot() {
      await options.run(["mkdir", "-p", screens], runOptions({ timeoutMs: 5_000 }));
      const path = `${screens}/screen-${Date.now()}-${++shots}.png`;
      const result = await options.run(["import", "-window", "root", path], runOptions({ timeoutMs: 20_000 }));
      if (result.exitCode !== 0) throw new Error(`the screenshot failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
      return { path, mediaType: "image/png" };
    },
  };
}
