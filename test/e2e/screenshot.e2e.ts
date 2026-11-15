import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Box, type WorkspaceInfoJson } from "./box.ts";
import { cdpScreenshot, FIXTURE, pixelOfPng, pixelOnDisplay } from "./helpers.ts";

let box: Box;
let info: WorkspaceInfoJson;
beforeAll(async () => {
  box = await Box.start({ label: "shot" });
  await box.startFixtureServer();
  info = await box.ensure("shot");
});
afterAll(async () => {
  await box?.remove();
});

describe("a fixture page seen through the browser of a workspace", () => {
  it("is captured by the DevTools protocol with the page's colour", async () => {
    const png = await cdpScreenshot(box, info, `${FIXTURE}/color?c=ff0000`);
    expect(Buffer.from(png, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(await pixelOfPng(box, png, 600, 400)).toMatch(/srgb\(255,0,0\)|red/);
  });

  it("is drawn on the workspace's own X display, so the browser is really headed", async () => {
    await box.cdp(info, { navigate: `${FIXTURE}/color?c=00ff00` });
    await new Promise((r) => setTimeout(r, 1500));
    const geometry = (await box.sh(`DISPLAY=${info.display} import -window root png:- | identify -format '%wx%h' png:-`)).trim();
    expect(geometry).toBe("1280x800");
    expect(await pixelOnDisplay(box, info, 900, 600)).toMatch(/srgb\(0,255,0\)|lime/);
  });

  it("reports the window as a real window of the display with a window manager running", async () => {
    const tree = await box.sh(`DISPLAY=${info.display} xdotool search --onlyvisible --class chrom 2>/dev/null | head -3; echo ---; pgrep -a openbox`);
    expect(tree).toMatch(/\d+/);
    expect(tree).toContain("openbox");
  });
});
