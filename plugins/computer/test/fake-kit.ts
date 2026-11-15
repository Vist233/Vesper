import type { RunOptions, RunResult } from "@vesper/contracts";
import { ELEMENTS } from "./contract.ts";

const ok = (stdout = "", exitCode = 0): RunResult => ({ exitCode, stdout, stderr: "", timedOut: false, truncated: false });
const envelope = (data: unknown) => ok(`${JSON.stringify({ ok: true, data, error: null, ms: 1 })}\n`);
const failure = (code: string, message: string) => ok(`${JSON.stringify({ ok: false, data: null, error: { code, message }, ms: 1 })}\n`);

/**
 * Stands in for the owner's gui kit and the X tools on a fake screen. It follows the kit's source (arguments of `observe.py`
 * and `act.py`, snapshot ids, the envelope, refs that belong to a snapshot) and the usual behaviour of `xdotool` and `import`.
 * It tests the adapter's logic, not the kit.
 */
export function createFakeKit() {
  const actions: string[] = [];
  const commands: { command: readonly string[]; env: Record<string, string> | undefined }[] = [];
  let snapshotCounter = 0;
  const snapshots = new Set<string>();

  async function run(command: readonly string[], options?: RunOptions): Promise<RunResult> {
    commands.push({ command, env: options?.env });
    const [program, script, ...args] = command as string[];
    const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    if (program === "python3" && script?.endsWith("/observe.py")) {
      const sid = `s${++snapshotCounter}`;
      snapshots.add(sid);
      const limit = Number(value("--limit") ?? 0);
      const items = ELEMENTS.map((e) => ({ ref: e.ref, role: e.role, name: e.name, actions: ["click"], bounds: { x: 0, y: 0, w: 10, h: 10 } }));
      return envelope({
        snapshot: sid,
        app: "Demo",
        count: items.length,
        returned: limit ? Math.min(limit, items.length) : items.length,
        truncated: false,
        items,
      });
    }
    if (program === "python3" && script?.endsWith("/act.py")) {
      const [action] = args;
      const xy = value("--xy");
      if (xy) {
        actions.push(`click ${xy}`);
        return envelope({ via: "pointer-human" });
      }
      const snapshot = value("--snapshot");
      const ref = value("--ref");
      if (!snapshot || !snapshots.has(snapshot)) return failure("SNAPSHOT_NOT_FOUND", `snapshot ${snapshot ?? ""} is not available`);
      if (!ELEMENTS.some((e) => e.ref === ref)) return failure("REF_NOT_FOUND", `${ref} is not in ${snapshot}`);
      actions.push(action === "set" ? `set ${ref}=${value("--text")}` : `${action} ${ref}`);
      return envelope({ via: "semantic" });
    }
    if (program === "xdotool") {
      const [verb, ...rest] = args.length ? [script, ...args] : [script];
      const words = rest.filter((w) => w !== "--clearmodifiers" && w !== "--" && w !== "--delay" && w !== "20");
      if (verb === "type") actions.push(`type ${words.join(" ")}`);
      else if (verb === "key") actions.push(`key ${words.join(" ")}`);
      else if (verb === "click") actions.push(`wheel ${words.join(" ")}`);
      return ok();
    }
    if (program === "mkdir") return ok();
    if (program === "import") {
      actions.push("screenshot");
      return ok();
    }
    return ok("", 127);
  }
  return { run, actions, commands };
}

/** Folds the wheel clicks of a scroll back into one `scroll dx,dy` entry, as the contract expects (100 px per wheel click, 4/5 vertical, 6/7 horizontal). */
export function foldScrolls(actions: string[]): string[] {
  const folded: string[] = [];
  let dx = 0;
  let dy = 0;
  const flush = () => {
    if (dx || dy) folded.push(`scroll ${dx},${dy}`);
    dx = 0;
    dy = 0;
  };
  for (const action of actions) {
    const match = /^wheel (\d)$/.exec(action);
    if (!match) {
      flush();
      folded.push(action);
    } else if (match[1] === "5") dy += 100;
    else if (match[1] === "4") dy -= 100;
    else if (match[1] === "7") dx += 100;
    else if (match[1] === "6") dx -= 100;
  }
  flush();
  return folded;
}
