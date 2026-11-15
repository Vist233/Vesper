import { OgbError, type RunOptions, type RunResult } from "@vesper/contracts";
import type { BrowserBackend, PageInfo, Snapshot } from "./backend.ts";
import { type CdpEvaluator, createCdpEvaluator } from "./cdp.ts";
import { type CheckOutcome, checkScript, type FillOutcome, fillScript, scriptResult } from "./dom-scripts.ts";

export interface WorkerBackendOptions {
  /** `WorkspaceHandle.run`: runs a program for the workspace with its own environment. */
  run(command: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** The owner's worker requires 1 to 32 letters, digits, '-' or '_' (the workspace id fits). */
  agentId: string;
  /** The workspace's Chrome DevTools address; the worker accepts only a loopback `http://127.0.0.1:<port>`. */
  cdpUrl: string;
  /** Default `sakura-browser-worker` (must be on the workspace's PATH). */
  workerCommand?: string;
  /** Reads and changes the page through DevTools (the worker cannot). Default: one for `cdpUrl`. */
  cdp?: CdpEvaluator;
}

/**
 * THE OWNER'S WORKER AS THE BROWSER BACKEND (docs/decisions.md D-T5-12).
 *
 * `sakura-browser-worker call <token>` takes `base64url({ agentId, action })` and prints one JSON line
 * `{ agentId, ok, data | error }`. What this file knows FROM THE WORKER'S SOURCE: the actions and their fields, the reply
 * envelope, and that a screenshot's data is `{ path, bytes }`. What it ASSUMES about the `agent-browser` CLI behind it,
 * not verified because the CLI could not be run here: the shape of `tabs` (a list of objects with a tab id, a url and a
 * title) and of `snapshot` (text with `@e` refs, or a `refs` map). The parsing is in the small functions at the bottom so
 * a wrong assumption is fixed in one place. The worker has no action to close a tab: `close` only forgets it here.
 */
export function createWorkerBackend(options: WorkerBackendOptions): BrowserBackend {
  const command = options.workerCommand ?? "sakura-browser-worker";
  const env = { BROWSER_TOOL_AGENT_ID: options.agentId, BROWSER_TOOL_CDP: options.cdpUrl };
  let current: string | undefined;
  const cdp = options.cdp ?? createCdpEvaluator({ cdpUrl: options.cdpUrl });

  async function call(action: Record<string, unknown>): Promise<unknown> {
    const token = Buffer.from(JSON.stringify({ agentId: options.agentId, action })).toString("base64url");
    const result = await options.run([command, "call", token], { env, timeoutMs: 40_000 });
    if (result.timedOut) throw new OgbError("unavailable", "the browser worker timed out; look at the page before trying again");
    let reply: { ok?: unknown; data?: unknown; error?: unknown; agentId?: unknown };
    try {
      reply = JSON.parse(result.stdout.trim().split("\n").pop() ?? "");
    } catch {
      throw new OgbError("unavailable", `the browser worker did not answer with JSON (exit ${result.exitCode})`);
    }
    if (reply.agentId !== options.agentId) throw new OgbError("internal", "the browser worker answered for another agent");
    if (reply.ok !== true) throw new Error(typeof reply.error === "string" ? reply.error : "the browser worker reported a failure");
    return reply.data;
  }

  /** The worker has one current tab; switch to ours before acting on it. */
  async function focus(tab: string): Promise<void> {
    if (current === tab) return;
    await call({ action: "switch_tab", tab });
    current = tab;
  }

  async function infoOf(tab: string): Promise<PageInfo> {
    const found = parseTabs(await call({ action: "tabs" })).find((t) => t.id === tab);
    if (!found) throw new Error(`no tab '${tab}' in the browser (it may have been closed)`);
    return { tab, url: found.url, title: found.title };
  }

  return {
    async open(url) {
      const before = new Set(parseTabs(await call({ action: "tabs" })).map((t) => t.id));
      await call({ action: "new_tab", url });
      const fresh = parseTabs(await call({ action: "tabs" })).filter((t) => !before.has(t.id));
      const tab = fresh[0]?.id;
      if (!tab) throw new Error("the browser did not report the new tab (assumption about the shape of `tabs` failed)");
      current = tab;
      return infoOf(tab);
    },
    async navigate(tab, url) {
      await focus(tab);
      await call({ action: "open", url });
      return infoOf(tab);
    },
    async snapshot(tab): Promise<Snapshot> {
      await focus(tab);
      const { text, elements } = parseSnapshot(await call({ action: "snapshot" }));
      return { ...(await infoOf(tab)), text, elements };
    },
    async click(tab, ref) {
      await focus(tab);
      await call({ action: "click", target: asTarget(ref) });
      return infoOf(tab);
    },
    async type(tab, ref, text, submit) {
      await focus(tab);
      await call({ action: "fill", target: asTarget(ref), text });
      if (submit) await call({ action: "press", key: "Enter" });
      return infoOf(tab);
    },
    async press(tab, key) {
      await focus(tab);
      await call({ action: "press", key });
      return infoOf(tab);
    },
    async readText(tab, target) {
      await focus(tab);
      const data = await call({ action: "read_text", target: asTarget(target) });
      return typeof data === "string" ? data : JSON.stringify(data);
    },
    async scroll(tab, direction, pixels) {
      await focus(tab);
      await call({ action: "scroll", direction, pixels });
      return infoOf(tab);
    },
    async screenshot(tab) {
      await focus(tab);
      const data = (await call({ action: "screenshot" })) as { path?: unknown };
      if (typeof data?.path !== "string") throw new Error("the browser worker did not return a screenshot path");
      return { path: data.path };
    },
    async evaluate(tab, expression, awaitPromise) {
      await focus(tab);
      const page = await infoOf(tab);
      return cdp.evaluate({ ...(/^[a-f0-9]{32}$/i.test(tab) ? { id: tab } : {}), url: page.url, title: page.title }, { expression, awaitPromise });
    },
    async fill(tab, target, text) {
      return scriptResult<FillOutcome>(await this.evaluate(tab, fillScript(target, text), false));
    },
    async check(tab, target) {
      return scriptResult<CheckOutcome>(await this.evaluate(tab, checkScript(target), false));
    },
    async close(tab) {
      if (current === tab) current = undefined; // the worker cannot close a tab: the agent lets go of it and the tab stays in the browser
    },
  };
}

/** Our refs are `e1`; the worker's targets are `@e1` (or a CSS selector, which is passed through). */
function asTarget(ref: string): string {
  return /^e\d+$/.test(ref) ? `@${ref}` : ref;
}

export interface ParsedTab {
  id: string;
  url: string;
  title: string;
}

/** ASSUMPTION (unverified): `tabs` gives a list, or an object holding one, of objects with a tab id, a url and a title. */
export function parseTabs(data: unknown): ParsedTab[] {
  const list = Array.isArray(data)
    ? data
    : ((data as { tabs?: unknown; targets?: unknown; pages?: unknown } | null)?.tabs ??
      (data as { targets?: unknown } | null)?.targets ??
      (data as { pages?: unknown } | null)?.pages);
  if (!Array.isArray(list)) return [];
  const tabs: ParsedTab[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const id = entry.tabId ?? entry.id ?? entry.targetId;
    if (typeof id === "string" || typeof id === "number")
      tabs.push({ id: String(id), url: typeof entry.url === "string" ? entry.url : "", title: typeof entry.title === "string" ? entry.title : "" });
  }
  return tabs;
}

/** ASSUMPTION (unverified): `snapshot -i -c` gives text whose lines name elements with `@eN` or `[ref=eN]`, or an object with a `refs` map. */
export function parseSnapshot(data: unknown): { text: string; elements: { ref: string; role: string; name: string }[] } {
  const object = (typeof data === "object" && data !== null ? data : {}) as { snapshot?: unknown; text?: unknown; refs?: unknown };
  const text =
    typeof data === "string"
      ? data
      : typeof object.snapshot === "string"
        ? object.snapshot
        : typeof object.text === "string"
          ? object.text
          : JSON.stringify(data ?? null);
  const elements: { ref: string; role: string; name: string }[] = [];
  if (typeof object.refs === "object" && object.refs !== null) {
    for (const [ref, value] of Object.entries(object.refs as Record<string, { role?: unknown; name?: unknown }>)) {
      elements.push({
        ref: ref.replace(/^@/, ""),
        role: typeof value?.role === "string" ? value.role : "",
        name: typeof value?.name === "string" ? value.name : "",
      });
    }
    return { text, elements };
  }
  for (const line of text.split("\n")) {
    const match = /^\s*-?\s*([\w-]+)(?:\s+"([^"]*)")?.*?(?:\[ref=|@)(e\d+)\]?/.exec(line);
    if (match) elements.push({ ref: match[3] as string, role: match[1] as string, name: match[2] ?? "" });
  }
  return { text, elements };
}
