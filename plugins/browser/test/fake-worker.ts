import type { RunOptions, RunResult } from "@vesper/contracts";
import type { FakePage } from "../src/fake-backend.ts";

interface Tab {
  id: string;
  url: string;
  title: string;
}

/**
 * Stands in for `sakura-browser-worker call <token>` over a fake site. It follows the worker's source (the request token, the
 * actions and their fields, the reply envelope, one current tab, screenshot data `{ path, bytes }`) and, where the source says
 * nothing, the assumptions of worker-backend.ts about `agent-browser` (shapes of `tabs` and `snapshot`). It therefore tests the
 * adapter's logic, not the real CLI.
 */
export function createFakeWorker(site: Record<string, FakePage>) {
  const tabs: Tab[] = [];
  const scrolled: string[] = [];
  const calls: { action: string; env: Record<string, string> | undefined }[] = [];
  let current: Tab | undefined;
  let counter = 0;
  const pageOf = (tab: Tab): FakePage => site[tab.url] ?? { title: "Not found", text: "", elements: [] };
  const go = (tab: Tab, url: string) => {
    tab.url = url;
    tab.title = pageOf(tab).title;
  };
  const elementOf = (tab: Tab, target: string) => {
    const ref = target.replace(/^@/, "");
    const found = pageOf(tab).elements?.find((e) => e.ref === ref);
    if (!found) throw new Error(`element ${target} not found`);
    return found;
  };
  let focused: { tab: Tab; field: string; submitGoto?: string } | undefined;

  function perform(action: Record<string, unknown>): unknown {
    switch (action.action) {
      case "tabs":
        return { tabs: tabs.map((t) => ({ ...t, active: t === current })) };
      case "new_tab": {
        const tab: Tab = { id: `t${++counter}`, url: String(action.url), title: "" };
        tab.title = pageOf(tab).title;
        tabs.push(tab);
        current = tab;
        return { tabId: tab.id };
      }
      case "switch_tab": {
        const tab = tabs.find((t) => t.id === action.tab);
        if (!tab) throw new Error("no such tab");
        current = tab;
        return { tabId: tab.id };
      }
    }
    if (!current) throw new Error("no current tab");
    switch (action.action) {
      case "open":
        go(current, String(action.url));
        return { url: current.url };
      case "snapshot": {
        const page = pageOf(current);
        const lines = (page.elements ?? []).map((e) => `- ${e.role} "${e.name}" [ref=${e.ref}]`);
        return { snapshot: [`- document "${page.title}"`, page.text, ...lines].join("\n") };
      }
      case "click": {
        const element = elementOf(current, String(action.target));
        if (element.goto) go(current, element.goto);
        return {};
      }
      case "fill": {
        const element = elementOf(current, String(action.target));
        if (!element.field) throw new Error("not a text field");
        focused = { tab: current, field: element.field, ...(element.submitGoto ? { submitGoto: element.submitGoto } : {}) };
        return {};
      }
      case "press":
        if (action.key === "Enter" && focused?.tab === current && focused.submitGoto) go(current, focused.submitGoto);
        return {};
      case "read_text":
        return elementOf(current, String(action.target)).name;
      case "scroll":
        scrolled.push(`${action.direction}:${action.pixels}`);
        return {};
      case "screenshot":
        return { path: `/work/agent-a/artifacts/${counter}.png`, bytes: 1234 };
      default:
        throw new Error("Unsupported browser command.");
    }
  }

  async function run(command: readonly string[], options?: RunOptions): Promise<RunResult> {
    const [program, verb, token] = command;
    if (program !== "sakura-browser-worker" || verb !== "call" || !token)
      return { exitCode: 2, stdout: "", stderr: "usage", timedOut: false, truncated: false };
    const { agentId, action } = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { agentId: string; action: Record<string, unknown> };
    calls.push({ action: String(action.action), env: options?.env });
    let reply: Record<string, unknown>;
    try {
      reply = { agentId, ok: true, data: perform(action) };
    } catch (error) {
      reply = { agentId, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { exitCode: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: "", timedOut: false, truncated: false };
  }
  return { run, tabs, scrolled, calls };
}
