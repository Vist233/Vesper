import { expect } from "vitest";
import type { Box, WorkspaceInfoJson } from "./box.ts";

export const FIXTURE = "http://127.0.0.1:9100";

/** Colour of one pixel of a PNG (base64), read with ImageMagick inside the container. */
export async function pixelOfPng(box: Box, pngBase64: string, x: number, y: number): Promise<string> {
  return (await box.exec(["sh", "-c", `base64 -d | convert png:- -format '%[pixel:p{${x},${y}}]' info:`], pngBase64)).trim();
}

/** A PNG of the whole X display of a workspace (what a person would see), as base64. */
export async function displayPng(box: Box, info: WorkspaceInfoJson): Promise<string> {
  return (await box.sh(`DISPLAY=${info.display} import -window root png:- | base64 -w0`)).trim();
}

export async function pixelOnDisplay(box: Box, info: WorkspaceInfoJson, x: number, y: number): Promise<string> {
  return (await box.sh(`DISPLAY=${info.display} import -window root png:- | convert png:- -format '%[pixel:p{${x},${y}}]' info:`)).trim();
}

/** The page's own screenshot taken through the DevTools protocol. */
export async function cdpScreenshot(box: Box, info: WorkspaceInfoJson, url: string): Promise<string> {
  const [, shot] = await box.cdp(info, {
    navigate: url,
    calls: [
      { method: "Runtime.evaluate", params: { expression: "document.title" } },
      { method: "Page.captureScreenshot", params: { format: "png" } },
    ],
  });
  return shot.data as string;
}

export async function cookieValue(box: Box, info: WorkspaceInfoJson): Promise<string> {
  const [result] = await box.cdp(info, {
    navigate: `${FIXTURE}/whoami`,
    calls: [{ method: "Runtime.evaluate", params: { expression: "document.body.innerText" } }],
  });
  return result.result.value as string;
}

/** Chromium writes cookies to disk on a timer; a hard kill before that loses them, so tests wait until the file has the cookie. */
export async function waitCookieOnDisk(box: Box, info: WorkspaceInfoJson, name: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await box.sh(`grep -a -c '${name}' '${info.profileDir}/Default/Cookies' 2>/dev/null || true`);
    if (Number(found.trim()) > 0) return;
    if (Date.now() > deadline) throw new Error(`cookie ${name} was not written to the profile in ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function expectAllRunning(box: Box, id: string): Promise<void> {
  const health = await box.waitState(id, "running", 90_000);
  for (const name of ["display", "windowManager", "browser"]) expect(health.processes?.[name]?.state, name).toBe("running");
}
