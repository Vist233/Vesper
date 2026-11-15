import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Box, type WorkspaceInfoJson } from "./box.ts";
import { cookieValue, FIXTURE, pixelOnDisplay } from "./helpers.ts";

let box: Box;
let a: WorkspaceInfoJson;
let b: WorkspaceInfoJson;
beforeAll(async () => {
  box = await Box.start({ label: "iso" });
  await box.startFixtureServer();
  [a, b] = await Promise.all([box.ensure("alpha"), box.ensure("beta")]);
});
afterAll(async () => {
  await box?.remove();
});

describe("two workspaces in one box", () => {
  it("have different displays, profile directories, files directories and DevTools ports", () => {
    expect(a.display).not.toBe(b.display);
    expect(a.cdpUrl).not.toBe(b.cdpUrl);
    expect(a.profileDir).not.toBe(b.profileDir);
    expect(a.filesDir).not.toBe(b.filesDir);
    expect(b.profileDir.startsWith(a.profileDir)).toBe(false);
    expect(a.profileDir.startsWith(b.profileDir)).toBe(false);
  });

  it("keep cookies apart: a login in one is not seen in the other", async () => {
    await box.cdp(a, { navigate: `${FIXTURE}/login?name=alice` });
    expect(await cookieValue(box, a)).toBe("session=alice");
    expect(await cookieValue(box, b)).toBe("");
    await box.cdp(b, { navigate: `${FIXTURE}/login?name=bob` });
    expect(await cookieValue(box, b)).toBe("session=bob");
    expect(await cookieValue(box, a)).toBe("session=alice");
  });

  it("draw on their own displays", async () => {
    await box.cdp(a, { navigate: `${FIXTURE}/color?c=ff0000` });
    await box.cdp(b, { navigate: `${FIXTURE}/color?c=0000ff` });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await pixelOnDisplay(box, a, 900, 600)).toMatch(/srgb\(255,0,0\)|red/);
    expect(await pixelOnDisplay(box, b, 900, 600)).toMatch(/srgb\(0,0,255\)|blue/);
  });

  it("each DevTools port lists only its own browser's pages", async () => {
    await box.cdp(a, { navigate: `${FIXTURE}/color?c=111111` });
    await box.cdp(b, { navigate: `${FIXTURE}/color?c=222222` });
    const listA = await box.sh(`node -e "fetch('${a.cdpUrl}/json/list').then(r=>r.json()).then(l=>console.log(l.map(t=>t.url).join(' ')))"`);
    const listB = await box.sh(`node -e "fetch('${b.cdpUrl}/json/list').then(r=>r.json()).then(l=>console.log(l.map(t=>t.url).join(' ')))"`);
    expect(listA).toContain("c=111111");
    expect(listA).not.toContain("c=222222");
    expect(listB).toContain("c=222222");
    expect(listB).not.toContain("c=111111");
  });

  it("run as separate browser processes with their own profile and display", async () => {
    const mains = (await box.sh("ps -eo args= | grep -F -- '--remote-debugging-port=' | grep -v -F -- '--type=' | grep -v grep")).split("\n").filter(Boolean);
    expect(mains).toHaveLength(2);
    for (const info of [a, b]) {
      const line = mains.find((l) => l.includes(`--user-data-dir=${info.profileDir}`));
      expect(line, info.profileDir).toBeDefined();
      expect(line).toContain(`--remote-debugging-port=${new URL(info.cdpUrl).port}`);
      expect(line).toContain("--remote-debugging-address=127.0.0.1");
    }
    expect((await box.sh("ls /tmp/.X11-unix")).split("\n").filter((n) => /^X\d+$/.test(n))).toEqual(
      expect.arrayContaining([a.display.replace(":", "X"), b.display.replace(":", "X")]),
    );
  });

  it("have ports that are not published to the host", async () => {
    const port = new URL(a.cdpUrl).port;
    const fromHost = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }).then(
      () => "reachable",
      () => "unreachable",
    );
    expect(fromHost).toBe("unreachable");
  });

  it("destroying one leaves the other running with its login", async () => {
    await box.call("destroy", { workspaceId: "alpha" });
    expect((await box.health("alpha")).state).toBe("absent");
    expect((await box.health("beta")).state).toBe("running");
    expect(await cookieValue(box, b)).toBe("session=bob");
    expect(await box.pids(`--remote-debugging-port=${new URL(a.cdpUrl).port}`)).toEqual([]);
  });
});
