import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Box, type WorkspaceInfoJson } from "./box.ts";
import { cdpScreenshot, cookieValue, expectAllRunning, FIXTURE, pixelOfPng, waitCookieOnDisk } from "./helpers.ts";

// One workspace, one box, every process killed with SIGKILL in turn. After each kill the workspace must come back by itself
// (or, for the daemon, on the next call), and the login stored in the Chromium profile must still be there.
let box: Box;
let info: WorkspaceInfoJson;
const cdpPort = () => new URL(info.cdpUrl).port;
const xvfbPids = () => box.pids(`Xvfb ${info.display}`);
const openboxPids = () => box.pids("openbox");
const chromiumPids = async () => (await box.pids(`--remote-debugging-port=${cdpPort()}`)).slice(0, 1);
const daemonPids = () => box.pids("packages/desk-daemon/src/main.ts");

async function killAndRecover(label: string, find: () => Promise<number[]>, signal = "KILL"): Promise<number[]> {
  const before = await find();
  expect(before, `${label} is running before the kill`).not.toHaveLength(0);
  await box.sh(`kill -${signal} ${before.join(" ")}`);
  return before;
}

async function expectWorkingBrowser(): Promise<void> {
  const png = await cdpScreenshot(box, info, `${FIXTURE}/color?c=ff0000`);
  expect(await pixelOfPng(box, png, 600, 400)).toMatch(/srgb\(255,0,0\)|red/);
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined as T);
    if (value !== undefined && accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  box = await Box.start({ label: "kill" });
  await box.startFixtureServer();
  info = await box.ensure("k1");
  await box.cdp(info, { navigate: `${FIXTURE}/login?name=carol` });
  await waitCookieOnDisk(box, info, "session");
});
afterAll(async () => {
  await box?.remove();
});

describe("kill tests in the container (SIGKILL)", () => {
  it("Chromium: the browser comes back with the same profile, the login is kept, no process is left over", async () => {
    const before = await killAndRecover("chromium", chromiumPids);
    const all = await box.pids(`--user-data-dir=${info.profileDir}`);
    await waitFor(chromiumPids, (now) => now.length === 1 && !before.includes(now[0] as number), "a new chromium");
    await expectAllRunning(box, "k1");
    // every old Chromium process (renderer, gpu, zygote) of the killed browser is gone
    const stillThere = (await box.pids(`--user-data-dir=${info.profileDir}`)).filter((pid) => all.includes(pid));
    expect(stillThere).toEqual([]);
    expect((await box.health("k1")).processes?.browser?.restarts).toBeGreaterThanOrEqual(1);
    expect(await cookieValue(box, info)).toBe("session=carol");
    await expectWorkingBrowser();
  });

  it("openbox: the window manager is restarted, the browser is not", async () => {
    const browserBefore = await chromiumPids();
    const before = await killAndRecover("openbox", openboxPids);
    await waitFor(openboxPids, (now) => now.length === 1 && !before.includes(now[0] as number), "a new openbox");
    await expectAllRunning(box, "k1");
    expect(await chromiumPids()).toEqual(browserBefore);
    expect((await box.health("k1")).processes?.windowManager?.restarts).toBeGreaterThanOrEqual(1);
  });

  it("Xvfb: openbox and Chromium are restarted on the new X server, the login is kept", async () => {
    const before = await killAndRecover("xvfb", xvfbPids);
    const browserBefore = await chromiumPids();
    await waitFor(xvfbPids, (now) => now.length === 1 && !before.includes(now[0] as number), "a new Xvfb");
    await waitFor(chromiumPids, (now) => now.length === 1 && !browserBefore.includes(now[0] as number), "a new chromium on the new display", 90_000);
    await expectAllRunning(box, "k1");
    expect(await cookieValue(box, info)).toBe("session=carol");
    await expectWorkingBrowser();
  });

  it("the daemon: s6 restarts it, it kills what it left behind, the workspace is stopped until the next call, and the login is kept", async () => {
    const [daemonBefore, xvfbBefore, chromiumBefore] = [await daemonPids(), await xvfbPids(), await chromiumPids()];
    await killAndRecover("daemon", daemonPids);
    await waitFor(daemonPids, (now) => now.length === 1 && !daemonBefore.includes(now[0] as number), "s6 to start a new daemon");
    await box.waitForDaemon();
    // the old display and browser were children of the dead daemon: the new daemon found them by their pid records and killed them
    await waitFor(
      async () => [...(await xvfbPids()), ...(await chromiumPids())],
      (now) => now.every((pid) => !xvfbBefore.includes(pid) && !chromiumBefore.includes(pid)),
      "orphans to be killed",
    );
    expect((await box.health("k1")).state).toBe("stopped");
    expect(await box.ensure("k1")).toEqual(info); // the next call wakes it, with the same numbers
    await expectAllRunning(box, "k1");
    expect(await cookieValue(box, info)).toBe("session=carol");
    await expectWorkingBrowser();
  });

  it("the supervisor of the daemon: s6 restarts the supervisor, the daemon and the workspace keep working, and a later daemon death is still repaired", async () => {
    const supervisor = () => box.pids("s6-supervise desk-daemon");
    const [supervisorBefore, daemonBefore] = [await supervisor(), await daemonPids()];
    await killAndRecover("s6-supervise", supervisor);
    await waitFor(supervisor, (now) => now.length === 1 && !supervisorBefore.includes(now[0] as number), "s6-svscan to start a new supervisor");
    expect(await daemonPids()).toEqual(daemonBefore); // the daemon was not touched
    await expectAllRunning(box, "k1");
    await box.sh(`kill -KILL ${daemonBefore.join(" ")}`);
    await waitFor(daemonPids, (now) => now.length === 1 && !daemonBefore.includes(now[0] as number), "the new supervisor to start a new daemon", 90_000);
    await box.waitForDaemon();
    await box.ensure("k1");
    await expectAllRunning(box, "k1");
    expect(await cookieValue(box, info)).toBe("session=carol");
  });

  it("the whole container is killed and started again: the login is on the volume", async () => {
    await box.killContainer();
    await box.startContainer();
    expect((await box.health("k1")).state).toBe("stopped");
    await box.startFixtureServer();
    expect(await box.ensure("k1")).toEqual(info);
    await expectAllRunning(box, "k1");
    expect(await cookieValue(box, info)).toBe("session=carol");
    await expectWorkingBrowser();
  });
});
