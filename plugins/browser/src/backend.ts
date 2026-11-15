import type { JsonValue } from "@vesper/contracts";
import type { CheckOutcome, FillOutcome } from "./dom-scripts.ts";

export interface PageInfo {
  tab: string;
  url: string;
  title: string;
}

export interface Snapshot extends PageInfo {
  text: string;
  elements: { ref: string; role: string; name: string }[];
}

/**
 * What the tool needs from a browser. The real backend drives the workspace's Chromium through its DevTools endpoint
 * (`agent-browser`); it is not built yet (the desk-daemon is not ready), so the tool is written against this port and a fake.
 */
export interface BrowserBackend {
  open(url: string): Promise<PageInfo>;
  navigate(tab: string, url: string): Promise<PageInfo>;
  snapshot(tab: string): Promise<Snapshot>;
  click(tab: string, ref: string): Promise<PageInfo>;
  type(tab: string, ref: string, text: string, submit: boolean): Promise<PageInfo>;
  press(tab: string, key: string): Promise<PageInfo>;
  /** The text of one element, by ref or CSS selector. */
  readText(tab: string, target: string): Promise<string>;
  scroll(tab: string, direction: "up" | "down" | "left" | "right", pixels: number): Promise<PageInfo>;
  screenshot(tab: string): Promise<{ path: string }>;
  /** Runs an expression in the page of the tab and returns its value (JSON). Throws with the page's message when the expression throws. */
  evaluate(tab: string, expression: string, awaitPromise: boolean): Promise<JsonValue>;
  /** Sets a form field the way a person's typing does (native setter, input and change events) and reads it back. `target` is a CSS selector. */
  fill(tab: string, target: string, text: string): Promise<FillOutcome>;
  /** Ticks a checkbox or radio button by clicking its outer label when it has one, and reads `checked` back. `target` is a CSS selector. */
  check(tab: string, target: string): Promise<CheckOutcome>;
  close(tab: string): Promise<void>;
}
