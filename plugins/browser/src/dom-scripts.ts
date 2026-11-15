import type { JsonValue } from "@vesper/contracts";

/*
 * Page scripts for `fill` and `check`, run through the backend's `evaluate`. They are strings, not functions: what runs in
 * the page must not depend on how this file is compiled. Each returns a small JSON object and never echoes the typed value
 * (it may be a password).
 */

export interface FillOutcome {
  matched: number;
  length: number;
  equal: boolean;
  /** Whether the form's submit button is enabled after the input; null when there is no form or no such button. */
  submitEnabled: boolean | null;
}
export interface CheckOutcome {
  checked: boolean;
  clicked: boolean;
}

export function fillScript(selector: string, text: string): string {
  return `((selector, text) => {
  const nodes = document.querySelectorAll(selector);
  if (nodes.length === 0) return { ok: false, error: "no element matches " + selector };
  const el = nodes[0];
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
  if (!setter) return { ok: false, error: "the element is not an input, a textarea or a select" };
  el.focus();
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const form = el.form;
  const submit = form && form.querySelector('[type="submit"], button:not([type])');
  return { ok: true, matched: nodes.length, length: el.value.length, equal: el.value === text, submitEnabled: submit ? !submit.disabled : null };
})(${JSON.stringify(selector)}, ${JSON.stringify(text)})`;
}

export function checkScript(selector: string): string {
  return `((selector) => {
  const node = document.querySelector(selector);
  if (!node) return { ok: false, error: "no element matches " + selector };
  const label = node instanceof HTMLLabelElement ? node : null;
  const el = label ? label.control : node;
  if (!(el instanceof HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio")) return { ok: false, error: "the element is not a checkbox or a radio button" };
  if (el.checked) return { ok: true, checked: true, clicked: false };
  const outer = label || el.closest("label") || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
  (outer || el).click();
  return { ok: true, checked: el.checked, clicked: true };
})(${JSON.stringify(selector)})`;
}

/** Reads what a script returned; a failure the page reported becomes an Error with its text. */
export function scriptResult<T>(value: JsonValue): T {
  const reply = value as { ok?: boolean; error?: string } | null;
  if (!reply || typeof reply !== "object") throw new Error("the page did not answer the script");
  if (reply.ok !== true) throw new Error(typeof reply.error === "string" ? reply.error : "the script failed");
  return reply as unknown as T;
}

/**
 * Reads a Google results page: title, address and snippet of each organic result, and whether Google asked for a check
 * (its "unusual traffic" page), which the person has to pass, never the agent.
 */
export const GOOGLE_RESULTS = `(() => {
  if (location.pathname.startsWith("/sorry") || document.querySelector("form#captcha-form, iframe[src*='recaptcha']")) return { blocked: true, results: [] };
  const seen = new Set();
  const results = [];
  for (const heading of document.querySelectorAll("a h3")) {
    const link = heading.closest("a");
    const url = link && link.href;
    if (!url || !/^https?:/.test(url) || seen.has(url) || /^https?:\\/\\/(www\\.)?google\\./.test(url)) continue;
    seen.add(url);
    const box = link.closest("div[data-hveid], div.g, div[data-sokoban-container]") || link.parentElement;
    const title = heading.innerText.trim();
    const snippet = ((box && box.innerText) || "").replace(title, "").replace(/\\s+/g, " ").trim().slice(0, 300);
    results.push({ title, url, snippet });
    if (results.length >= 10) break;
  }
  return { blocked: false, results };
})()`;
