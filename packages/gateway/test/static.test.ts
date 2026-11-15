import { afterEach, describe, expect, it } from "vitest";
import { type GatewayRig, type RigOptions, startRig } from "./rig.ts";

const rigs: GatewayRig[] = [];
async function rig(options: RigOptions = {}) {
  const made = await startRig(options);
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

describe("static files", () => {
  it("serves the index at / and files with their types", async () => {
    const r = await rig();
    expect((await r.probe.call("GET", "/")).text).toContain("<title>page</title>");
    expect((await r.probe.call("GET", "/index.html")).headers["content-type"]).toContain("text/html");
    expect((await r.probe.call("GET", "/app.js")).headers["content-type"]).toContain("text/javascript");
    expect((await r.probe.call("GET", "/sub/a.css")).headers["content-type"]).toContain("text/css");
    const head = await r.probe.call("HEAD", "/app.js");
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
  });

  it.each([
    "/../outside.txt",
    "/%2e%2e/outside.txt",
    "/%2E%2E%2Foutside.txt",
    "/sub/../../outside.txt",
    "/..%2f..%2foutside.txt",
    "/sub/%2e%2e/%2e%2e/outside.txt",
    "/%00",
    "/app.js%00.png",
    "/..\\outside.txt",
    "/sub\\..\\..\\outside.txt",
    "/.secret.txt",
    "/sub/.hidden",
    "/link.txt", // a link that leaves the directory
    "/data.bin", // unknown extension
    "/nothing.html",
    "/sub", // a directory without an index
    "//etc/passwd",
    "/%zz",
  ])("does not serve %s", async (path) => {
    const r = await rig();
    // The probe sends the path exactly as written (no normalisation by a client library).
    const reply = await r.probe.call("GET", path);
    expect([400, 404]).toContain(reply.status);
    expect(reply.text).not.toContain("outside");
    expect(reply.text).not.toContain("hidden");
    expect(reply.text).not.toContain("root:");
  });

  it("serves only the API when no directory is given", async () => {
    const r = await rig({ staticDir: undefined });
    expect((await r.probe.call("GET", "/")).status).toBe(404);
    expect((await r.probe.call("GET", "/api/health")).status).toBe(200);
  });
});

describe("images", () => {
  it("serves png and jpeg with their types (the logo and the icon)", async () => {
    const r = await rig();
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(r.staticDir, "logo.jpeg"), "jpeg");
    writeFileSync(join(r.staticDir, "icon.png"), "png");
    expect((await r.probe.call("GET", "/logo.jpeg")).headers["content-type"]).toBe("image/jpeg");
    expect((await r.probe.call("GET", "/icon.png")).headers["content-type"]).toBe("image/png");
  });
});
