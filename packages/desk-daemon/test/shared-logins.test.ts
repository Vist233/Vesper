import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Cookie, type CookieBrowser, SharedLogins } from "../src/shared-logins.ts";
import { silentLog, tempRoot } from "./helpers.ts";

const roots: { remove(): void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
});

/** A browser that keeps its cookies in memory, like the real one through DevTools. */
function browser(id: string, cookies: Cookie[] = []) {
  const jar = new Map(cookies.map((c) => [`${c.name}|${c.domain}|${c.path}`, c]));
  const fake: CookieBrowser & { jar: Map<string, Cookie>; values(): Record<string, string> } = {
    id,
    jar,
    async read() {
      return [...jar.values()];
    },
    async write(set, remove) {
      for (const c of set) jar.set(`${c.name}|${c.domain}|${c.path}`, c);
      for (const c of remove) jar.delete(`${c.name}|${c.domain}|${c.path}`);
    },
    values: () => Object.fromEntries([...jar.values()].map((c) => [`${c.name}@${c.domain}`, c.value])),
  };
  return fake;
}
const cookie = (name: string, value: string, domain = "site.test"): Cookie => ({ name, value, domain, path: "/" });

function logins() {
  const root = tempRoot();
  roots.push(root);
  const file = join(root.dir, "shared", "cookies.json");
  return { file, make: () => new SharedLogins(file, silentLog) };
}

describe("one set of logins for every session", () => {
  it("a login made in one browser reaches the others, and a sign-out too", async () => {
    const { make } = logins();
    const shared = make();
    const a = browser("a");
    const b = browser("b");
    await shared.sync([a, b]);
    a.jar.set("sid|site.test|/", cookie("sid", "s1")); // the person signs in in session a
    await shared.sync([a, b]);
    expect(b.values()).toEqual({ "sid@site.test": "s1" });
    b.jar.set("sid|site.test|/", cookie("sid", "s2")); // the site refreshes the token in session b
    await shared.sync([a, b]);
    expect(a.values()).toEqual({ "sid@site.test": "s2" });
    a.jar.delete("sid|site.test|/"); // sign-out in a
    await shared.sync([a, b]);
    expect(b.values()).toEqual({});
  });

  it("a browser seen for the first time takes the jar and cannot undo a newer login with its old cookie", async () => {
    const { make } = logins();
    const shared = make();
    const a = browser("a", [cookie("sid", "new")]);
    await shared.sync([a]);
    const old = browser("b", [cookie("sid", "old"), cookie("pref", "dark", "other.test")]);
    await shared.sync([a, old]);
    expect(old.values()).toEqual({ "sid@site.test": "new", "pref@other.test": "dark" });
    expect(a.values()).toEqual({ "sid@site.test": "new", "pref@other.test": "dark" }); // what the jar lacked is shared
  });

  it("keeps the jar in a file only its owner can read, and a new daemon starts from it", async () => {
    const { file, make } = logins();
    await make().sync([browser("a", [cookie("sid", "s1")])]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("s1");
    const fresh = browser("c");
    await make().sync([fresh]);
    expect(fresh.values()).toEqual({ "sid@site.test": "s1" });
  });

  it("drops expired cookies, and a browser that cannot be read is skipped without stopping the others", async () => {
    const { make } = logins();
    const shared = make();
    const broken: CookieBrowser = {
      id: "x",
      read: async () => {
        throw new Error("down");
      },
      write: async () => {},
    };
    const a = browser("a", [{ ...cookie("old", "1"), expires: 1 }, cookie("sid", "s1")]);
    const b = browser("b");
    await shared.sync([broken, a, b]);
    expect(b.values()).toEqual({ "sid@site.test": "s1" });
    expect(shared.size).toBe(1);
  });
});
