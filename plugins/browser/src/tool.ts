import type { Tool, ToolContext, ToolResult } from "sakura-agent";
import type { BrowserBackend } from "./backend.ts";

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });
const MAX_TEXT = 6000;
const MAX_EXPRESSION = 4000;
/** The most of an `evaluate` value that is returned; the rest is cut and said to be. */
export const MAX_VALUE = 8192;

/** Input rules taken from the owner's `sakura-browser-tool` (protocol.mjs): the worker passes these values to a command line, so they are checked. */
const LIMITS = { url: 4096, target: 512, text: 8000, key: 64, tab: 80, expectText: 500, pixels: 8192 };

export function checkUrl(url: string): string | undefined {
  if (url.length > LIMITS.url || url.includes("\0")) return "The url is too long or invalid.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL.";
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "Use HTTP(S) without embedded credentials.";
  return undefined;
}

/** A value that could be read as an option by the command line behind a real backend is refused. */
function checkWord(name: string, value: string, max: number): string | undefined {
  if (value.length > max || value.includes("\0")) return `'${name}' is too long or invalid.`;
  if (value.trimStart().startsWith("-")) return `'${name}' must not start with '-'.`;
  return undefined;
}
const MAX_ELEMENTS = 80;

/** `fill` and `check` find the element in the page by CSS selector; a snapshot ref (`e12`) means nothing there. */
function selectorProblem(target: string | undefined): string | undefined {
  if (!target) return "'target' (a CSS selector) is required.";
  if (/^@?e\d+$/.test(target))
    return "'target' must be a CSS selector, not a snapshot ref. Find a selector with evaluate, for example document.querySelector('input[type=checkbox]').";
  return checkWord("target", target, LIMITS.target);
}
/** What the browser worker says when a tab no longer exists. */
const TAB_GONE = /no (such )?tab|tab .*(not found|gone|closed)|target (closed|not found)|no page|session (closed|not found)/i;

const DESCRIPTION =
  "Use this workspace's web browser. Actions: open (url) opens a new tab of yours; navigate (tab, url); snapshot (tab) reads the page text and lists elements with a ref each; read_text (tab, ref); click (tab, ref); type (tab, ref, text, submit); press (tab, key); scroll (tab, direction, pixels); screenshot (tab); close (tab); tabs lists your tabs. evaluate (tab, expression, awaitPromise) runs JavaScript in the page and returns its value as JSON, cut at 8 KB: use it to read the DOM and to check results. fill (tab, target, text) sets a form field the way typing does and reads it back; check (tab, target) ticks a checkbox or radio button and reads it back; for both, target is a CSS selector. After open, navigate, click, type or press you may pass expectText to check that the page now shows it. You can only use tabs you opened. Take a snapshot before you click or type.";

export interface BrowserToolOptions {
  backend: BrowserBackend;
  /** How long expectText waits for the text to appear (a navigation may take a moment). Default 5000 ms. */
  confirmWaitMs?: number;
}

/**
 * Tab ownership: every tab belongs to the agent that opened it. An agent is told apart by its conversation log, which a
 * sub-agent has of its own, so a parent and its helpers share the browser but never each other's tabs.
 */
export function createBrowserTool(options: BrowserToolOptions): Tool {
  const owners = new Map<string, number>();
  const agentIds = new WeakMap<object, number>();
  let nextAgent = 1;
  const lastTab = new Map<number, string>();

  const agentOf = (context: ToolContext): number => {
    const key = context.log as unknown as object;
    let id = agentIds.get(key);
    if (id === undefined) {
      id = nextAgent++;
      agentIds.set(key, id);
    }
    return id;
  };

  const waitMs = options.confirmWaitMs ?? 5000;
  /**
   * With expectText, watches the page after the action for up to `confirmWaitMs`. The text may have been there before, so
   * this does not prove the action caused it. Not seeing it is not an error: the action was sent, and repeating it blindly
   * could do it twice (a second click on Submit), so the agent is told to look first.
   */
  const confirmed = async (tab: string, page: unknown, expectText: unknown): Promise<ToolResult> => {
    if (typeof expectText !== "string" || expectText === "") return text(JSON.stringify(page));
    const until = Date.now() + waitMs;
    for (;;) {
      if ((await options.backend.snapshot(tab)).text.includes(expectText)) return text(JSON.stringify({ ...(page as object), verified: true }));
      if (Date.now() >= until) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, until - Date.now())));
    }
    return text(
      JSON.stringify({
        ok: true,
        actionDispatched: true,
        verified: false,
        note: `The action was sent but "${expectText}" did not appear within ${Math.round(waitMs / 1000)} s. Inspect the page (evaluate or snapshot) before doing anything again; do not repeat the action blindly.`,
      }),
    );
  };
  const checkExpect = (input: Record<string, unknown>): string | undefined =>
    typeof input.expectText === "string" ? checkWord("expectText", input.expectText, LIMITS.expectText) : undefined;

  return {
    name: "browser",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open", "navigate", "snapshot", "read_text", "click", "type", "press", "scroll", "screenshot", "close", "tabs", "evaluate", "fill", "check"],
        },
        url: { type: "string" },
        tab: { type: "string", description: "A tab you opened; defaults to your latest" },
        ref: { type: "string", description: "Element ref from a snapshot" },
        text: { type: "string" },
        expression: { type: "string", description: "evaluate: JavaScript to run in the page (an expression, at most 4000 characters)" },
        awaitPromise: { type: "boolean", description: "evaluate: wait for a promise the expression returns" },
        target: { type: "string", description: "fill and check: a CSS selector for the element" },
        submit: { type: "boolean", description: "type: press Enter afterwards" },
        key: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pixels: { type: "integer", minimum: 0, maximum: 8192 },
        expectText: {
          type: "string",
          description: "Text the page should show after the action; the call fails if it does not (the action may still have happened)",
        },
      },
      required: ["action"],
    },
    effect: "network",
    replay: "never",
    async execute(args, context) {
      const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const agent = agentOf(context);
      let usedTab: string | undefined;
      const str = (key: string) => (typeof input[key] === "string" && input[key] !== "" ? (input[key] as string) : undefined);
      try {
        if (input.action === "tabs") {
          const mine = [...owners].filter(([, owner]) => owner === agent).map(([tab]) => tab);
          return text(JSON.stringify({ tabs: mine }));
        }
        if (input.action === "open") {
          const url = str("url");
          if (!url) return text("'url' is required for open.", true);
          const bad = checkUrl(url) ?? checkExpect(input);
          if (bad) return text(bad, true);
          const page = await options.backend.open(url);
          owners.set(page.tab, agent);
          lastTab.set(agent, page.tab);
          return await confirmed(page.tab, page, input.expectText);
        }
        const tab = str("tab") ?? lastTab.get(agent);
        if (!tab) return text("You have no tab yet. Use action 'open' with a url.", true);
        usedTab = tab;
        const owner = owners.get(tab);
        if (owner === undefined) return text(`There is no tab '${tab}' among yours. Use action 'open'.`, true);
        if (owner !== agent) return text(`Tab '${tab}' belongs to another agent. Open your own tab with action 'open'.`, true);
        switch (input.action) {
          case "navigate": {
            const url = str("url");
            if (!url) return text("'url' is required for navigate.", true);
            const bad = checkUrl(url) ?? checkExpect(input);
            return bad ? text(bad, true) : await confirmed(tab, await options.backend.navigate(tab, url), input.expectText);
          }
          case "read_text": {
            const ref = str("ref");
            const bad = ref ? checkWord("ref", ref, LIMITS.target) : "'ref' is required for read_text.";
            return bad ? text(bad, true) : text(JSON.stringify({ text: (await options.backend.readText(tab, ref as string)).slice(0, MAX_TEXT) }));
          }
          case "scroll": {
            const direction = input.direction;
            const pixels = input.pixels;
            if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right")
              return text("'direction' must be up, down, left or right.", true);
            if (!Number.isInteger(pixels) || (pixels as number) < 0 || (pixels as number) > LIMITS.pixels)
              return text(`'pixels' must be a whole number from 0 to ${LIMITS.pixels}.`, true);
            return text(JSON.stringify(await options.backend.scroll(tab, direction, pixels as number)));
          }
          case "snapshot": {
            const snapshot = await options.backend.snapshot(tab);
            const shown =
              snapshot.text.length > MAX_TEXT ? `${snapshot.text.slice(0, MAX_TEXT)}… [${snapshot.text.length - MAX_TEXT} more characters]` : snapshot.text;
            return text(
              JSON.stringify({
                tab: snapshot.tab,
                url: snapshot.url,
                title: snapshot.title,
                text: shown,
                elements: snapshot.elements.slice(0, MAX_ELEMENTS),
                moreElements: Math.max(0, snapshot.elements.length - MAX_ELEMENTS),
              }),
            );
          }
          case "click": {
            const ref = str("ref");
            if (!ref) return text("'ref' is required for click (take a snapshot to get one).", true);
            const bad = checkWord("ref", ref, LIMITS.target) ?? checkExpect(input);
            return bad ? text(bad, true) : await confirmed(tab, await options.backend.click(tab, ref), input.expectText);
          }
          case "type": {
            const ref = str("ref");
            if (!ref || typeof input.text !== "string") return text("'ref' and 'text' are required for type.", true);
            const bad = checkWord("ref", ref, LIMITS.target) ?? (input.text.length > LIMITS.text ? "'text' is too long." : undefined) ?? checkExpect(input);
            if (bad) return text(bad, true);
            return await confirmed(tab, await options.backend.type(tab, ref, input.text, input.submit === true), input.expectText);
          }
          case "press": {
            const key = str("key");
            if (!key) return text("'key' is required for press.", true);
            const bad = checkWord("key", key, LIMITS.key) ?? checkExpect(input);
            return bad ? text(bad, true) : await confirmed(tab, await options.backend.press(tab, key), input.expectText);
          }
          case "screenshot":
            return text(JSON.stringify(await options.backend.screenshot(tab)));
          case "evaluate": {
            const expression = str("expression");
            if (!expression) return text("'expression' is required for evaluate.", true);
            if (expression.length > MAX_EXPRESSION || expression.includes("\0"))
              return text(`'expression' must be at most ${MAX_EXPRESSION} characters.`, true);
            const value = await options.backend.evaluate(tab, expression, input.awaitPromise === true);
            const json = JSON.stringify(value ?? null) ?? "null";
            return json.length <= MAX_VALUE
              ? text(JSON.stringify({ ok: true, value: value ?? null }))
              : text(JSON.stringify({ ok: true, truncated: true, bytes: json.length, value: json.slice(0, MAX_VALUE) }));
          }
          case "fill": {
            const target = str("target");
            const bad = selectorProblem(target);
            if (bad) return text(bad, true);
            if (typeof input.text !== "string") return text("'text' is required for fill.", true);
            if (input.text.length > LIMITS.text) return text("'text' is too long.", true);
            const done = await options.backend.fill(tab, target as string, input.text);
            if (!done.equal)
              return text(
                `fill failed: the field did not keep the value (sent ${input.text.length} characters, the field holds ${done.length}). The page may control the field itself: click it, press the keys with 'type', then read it back with evaluate.`,
                true,
              );
            return text(JSON.stringify({ ok: true, matched: done.matched, length: done.length, submitEnabled: done.submitEnabled }));
          }
          case "check": {
            const target = str("target");
            const bad = selectorProblem(target);
            if (bad) return text(bad, true);
            const done = await options.backend.check(tab, target as string);
            if (!done.checked)
              return text(
                "check failed: the box is still not checked after the click. Look at the DOM with evaluate (an overlay, a disabled input, or another label); do not click it again blindly.",
                true,
              );
            return text(JSON.stringify({ ok: true, checked: true, clicked: done.clicked }));
          }
          case "close":
            await options.backend.close(tab);
            owners.delete(tab);
            if (lastTab.get(agent) === tab) lastTab.delete(agent);
            return text("Closed.");
          default:
            return text(
              "'action' must be one of open, navigate, snapshot, read_text, click, type, press, scroll, screenshot, evaluate, fill, check, close, tabs.",
              true,
            );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (usedTab !== undefined && TAB_GONE.test(message)) {
          // The browser no longer has this tab (it was restarted, or the person closed it): forget it so it is not tried again.
          owners.delete(usedTab);
          if (lastTab.get(agent) === usedTab) lastTab.delete(agent);
          return text(
            `The tab '${usedTab}' is gone (the browser was restarted or the tab was closed) and has been dropped. Use action 'open' to open the page again, then take a new snapshot.`,
            true,
          );
        }
        return text(message, true);
      }
    },
  };
}
