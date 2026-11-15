import type { BrowserBackend, PageInfo, Snapshot } from "./backend.ts";
import type { JsonValue } from "@vesper/contracts";

export interface FakeElement {
  ref: string;
  role: string;
  name: string;
  /** Clicking goes to this page. */
  goto?: string;
  /** Typing into it stores the text under this field name; submitting goes to `submitGoto`. */
  field?: string;
  submitGoto?: string;
  /** The CSS selector `fill` and `check` find this element by. */
  selector?: string;
  /** A framework-controlled input: setting its value the plain way is ignored (the fake's `fill` then reads back the old value). */
  ignoresValue?: boolean;
  /** A checkbox. `stuck`: nothing toggles it. */
  checkbox?: { checked: boolean; stuck?: boolean };
  /** Filling any field makes this submit button enabled (the fake's `submitEnabled`). */
  submitSelector?: string;
}

export interface FakePage {
  title: string;
  text: string;
  elements?: FakeElement[];
}

/** A browser made of a few pages in memory: also the demo backend, selected by a workspace whose DevTools address starts with `fake:`. */
export function createFakeBrowser(
  pages: Record<string, FakePage>,
  options: { evaluate?: (expression: string, url: string) => JsonValue | Promise<JsonValue> } = {},
): BrowserBackend & { typed: Record<string, string>; opened: string[]; closed: string[]; evaluated: string[] } {
  const tabs = new Map<string, string>();
  const typed: Record<string, string> = {};
  const opened: string[] = [];
  const closed: string[] = [];
  const evaluated: string[] = [];
  let counter = 0;

  const page = (url: string): FakePage => pages[url] ?? { title: "Not found", text: `No page at ${url}`, elements: [] };
  const urlOf = (tab: string): string => {
    const url = tabs.get(tab);
    if (url === undefined) throw new Error(`no tab '${tab}'`);
    return url;
  };
  const info = (tab: string): PageInfo => ({ tab, url: urlOf(tab), title: page(urlOf(tab)).title });
  const element = (tab: string, ref: string): FakeElement => {
    const found = page(urlOf(tab)).elements?.find((e) => e.ref === ref);
    if (!found) throw new Error(`no element '${ref}' on this page (take a snapshot to see the refs)`);
    return found;
  };

  return {
    typed,
    opened,
    closed,
    evaluated,
    async evaluate(tab, expression) {
      const url = urlOf(tab);
      evaluated.push(expression);
      if (!options.evaluate) throw new Error("this demo browser cannot run scripts");
      return options.evaluate(expression, url);
    },
    async fill(tab, target, text) {
      const found = page(urlOf(tab)).elements?.filter((e) => e.selector === target) ?? [];
      const el = found[0];
      if (!el) throw new Error(`no element matches ${target}`);
      if (el.field === undefined) throw new Error("the element is not an input, a textarea or a select");
      if (!el.ignoresValue) typed[el.field] = text;
      const submit = page(urlOf(tab)).elements?.find((e) => e.submitSelector !== undefined);
      return { matched: found.length, length: el.ignoresValue ? 0 : text.length, equal: !el.ignoresValue, submitEnabled: submit ? !el.ignoresValue : null };
    },
    async check(tab, target) {
      const el = page(urlOf(tab)).elements?.find((e) => e.selector === target);
      if (!el) throw new Error(`no element matches ${target}`);
      if (!el.checkbox) throw new Error("the element is not a checkbox or a radio button");
      if (el.checkbox.checked) return { checked: true, clicked: false };
      if (!el.checkbox.stuck) el.checkbox.checked = true;
      return { checked: el.checkbox.checked, clicked: true };
    },
    async open(url) {
      const tab = `t${++counter}`;
      tabs.set(tab, url);
      opened.push(tab);
      return info(tab);
    },
    async navigate(tab, url) {
      urlOf(tab);
      tabs.set(tab, url);
      return info(tab);
    },
    async snapshot(tab): Promise<Snapshot> {
      const current = page(urlOf(tab));
      return { ...info(tab), text: current.text, elements: (current.elements ?? []).map(({ ref, role, name }) => ({ ref, role, name })) };
    },
    async click(tab, ref) {
      const target = element(tab, ref);
      if (target.goto !== undefined) tabs.set(tab, target.goto);
      return info(tab);
    },
    async type(tab, ref, text, submit) {
      const target = element(tab, ref);
      if (target.field === undefined) throw new Error(`element '${ref}' cannot take text`);
      typed[target.field] = text;
      if (submit && target.submitGoto !== undefined) tabs.set(tab, target.submitGoto);
      return info(tab);
    },
    async readText(tab, target) {
      const found = page(urlOf(tab)).elements?.find((e) => e.ref === target);
      if (!found) throw new Error(`no element '${target}' on this page (take a snapshot to see the refs)`);
      return found.name;
    },
    async scroll(tab) {
      return info(tab);
    },
    async press(tab) {
      return info(tab);
    },
    async screenshot(tab) {
      urlOf(tab);
      return { path: `/fake/screenshots/${tab}.png` };
    },
    async close(tab) {
      urlOf(tab);
      tabs.delete(tab);
      closed.push(tab);
    },
  };
}
