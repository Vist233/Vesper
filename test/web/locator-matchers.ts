import type { Locator } from "playwright-core";
import { expect } from "vitest";

// The few web-first assertions the page tests use (Playwright's names), for vitest's `expect`: each waits up to five
// seconds for the locator to reach the state, and `.not` waits for the opposite.

const TIMEOUT_MS = 5000;

async function settle(isNot: boolean, check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await check();
    } catch {
      ok = false;
    }
    if (ok !== isNot || Date.now() >= until) return ok;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const textMatches = (actual: string, expected: string | RegExp, whole: boolean) => {
  const clean = actual.replace(/\s+/g, " ").trim();
  if (expected instanceof RegExp) return expected.test(clean);
  return whole ? clean === expected.replace(/\s+/g, " ").trim() : clean.includes(expected);
};

function matcher(name: string, check: (locator: Locator, ...args: any[]) => Promise<boolean>, describe: (...args: any[]) => string) {
  return async function (this: { isNot?: boolean }, received: Locator, ...args: any[]) {
    const isNot = this.isNot === true; // vitest leaves it undefined for a plain expect
    const last = args.at(-1);
    const options = last !== null && typeof last === "object" && !(last instanceof RegExp) && !Array.isArray(last) ? (args.pop() as { timeout?: number }) : {};
    const timeoutMs = options.timeout ?? TIMEOUT_MS;
    const pass = await settle(isNot, () => check(received, ...args), timeoutMs);
    return { pass, message: () => `expected ${String(received)} ${isNot ? "not " : ""}${describe(...args)} (${name}, ${timeoutMs} ms)` };
  };
}

expect.extend({
  toBeVisible: matcher(
    "toBeVisible",
    (l) => l.first().isVisible(),
    () => "to be visible",
  ),
  toBeHidden: matcher(
    "toBeHidden",
    async (l) => (await l.count()) === 0 || (await l.first().isHidden()),
    () => "to be hidden",
  ),
  toHaveText: matcher(
    "toHaveText",
    async (l, text: string | RegExp | (string | RegExp)[]) => {
      if (!Array.isArray(text)) return textMatches(await l.first().innerText(), text, true);
      const all = await l.allInnerTexts(); // one expected text per element, in order
      return all.length === text.length && all.every((actual, i) => textMatches(actual, text[i] as string | RegExp, true));
    },
    (t) => `to have text ${String(t)}`,
  ),
  toContainText: matcher(
    "toContainText",
    async (l, text: string | RegExp) => textMatches(await l.first().innerText(), text, false),
    (t) => `to contain text ${String(t)}`,
  ),
  toHaveCount: matcher(
    "toHaveCount",
    async (l, n: number) => (await l.count()) === n,
    (n) => `to have count ${n}`,
  ),
  toHaveAttribute: matcher(
    "toHaveAttribute",
    async (l, name: string, value?: string | RegExp) => {
      const actual = await l.first().getAttribute(name);
      if (value === undefined) return actual !== null;
      return actual !== null && (value instanceof RegExp ? value.test(actual) : actual === value);
    },
    (name, value) => `to have attribute ${name}${value === undefined ? "" : `=${String(value)}`}`,
  ),
  toBeEmpty: matcher(
    "toBeEmpty",
    async (l) =>
      (await l
        .first()
        .inputValue()
        .catch(async () => l.first().innerText())) === "",
    () => "to be empty",
  ),
});

declare module "vitest" {
  interface Assertion<T> {
    toBeVisible(options?: { timeout?: number }): Promise<T>;
    toBeHidden(options?: { timeout?: number }): Promise<T>;
    toHaveText(text: string | RegExp | (string | RegExp)[], options?: { timeout?: number }): Promise<T>;
    toContainText(text: string | RegExp, options?: { timeout?: number }): Promise<T>;
    toHaveCount(count: number, options?: { timeout?: number }): Promise<T>;
    toHaveAttribute(name: string, value?: string | RegExp): Promise<T>;
    toBeEmpty(): Promise<T>;
  }
}
