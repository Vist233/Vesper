import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Box } from "./box.ts";

let box: Box;
beforeAll(async () => {
  box = await Box.start({ label: "basics" });
});
afterAll(async () => {
  await box?.remove();
});

describe("the image", () => {
  it("runs Node 26 and s6-overlay as pid 1 with the two services up", async () => {
    expect((await box.exec(["node", "--version"])).trim()).toMatch(/^v26\./);
    expect((await box.sh("cat /proc/1/comm")).trim()).toMatch(/s6-svscan|s6-linux-init|init/);
    for (const service of ["runtime", "desk-daemon"]) {
      expect((await box.sh(`/command/s6-svstat -o up /run/service/${service}`)).trim(), service).toBe("true");
    }
  });

  it("has the programs the daemon starts, and the owner's tools", async () => {
    for (const program of ["Xvfb", "openbox", "x11vnc", "ogb-chromium", "sakura-browser-worker", "xdotool", "convert", "ffmpeg", "python3"]) {
      await box.sh(`command -v ${program}`);
    }
    // exactly one agent-browser: the version the owner's browser tool pins, inside that tool (D-APP-8)
    await box.sh("test -x /usr/local/lib/node_modules/sakura-browser-tool/node_modules/.bin/agent-browser");
    expect(await box.sh("ls /opt/ogb/image/vendor/sandbox-tools/desktop/refagent-tools/tools")).toContain("observe.py");
    expect(await box.sh("fc-list | grep -ci -E 'noto.*cjk|noto.*emoji|liberation'")).toBeTruthy();
  });

  it("answers the health check", async () => {
    await box.exec(["node", "/opt/ogb/image/healthcheck.mjs"]);
    const deadline = Date.now() + 90_000;
    let status = "";
    while (Date.now() < deadline) {
      status = execFileSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", box.name], { encoding: "utf8" }).trim();
      if (status === "healthy") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(status).toBe("healthy");
  });

  it("listens on loopback only once a workspace and its take-over are up, except the page's port", async () => {
    await box.ensure("net");
    await box.call("takeover.open", { workspaceId: "net" });
    const listeners = (await box.sh("ss -ltnH")).split("\n").filter(Boolean);
    expect(listeners.length).toBeGreaterThan(2);
    // the page listens on all addresses inside the container; compose publishes it on the host's loopback only (next test)
    for (const line of listeners) expect(line.split(/\s+/)[3], line).toMatch(/^(127\.0\.0\.1|\[::1\]):|^0\.0\.0\.0:8787$/);
  });

  it("uses the limits and the names the compose file promises", () => {
    const config = execFileSync("docker", ["compose", "-f", "image/compose.yaml", "config", "--format", "json"], { encoding: "utf8" });
    const parsed = JSON.parse(config);
    const service = parsed.services.box;
    expect(service.restart).toBe("unless-stopped");
    expect(Number(service.cpus)).toBe(4);
    expect(Number(service.mem_limit)).toBe(8 * 1024 ** 3); // D-USE-19
    expect(service.container_name).toBe("ogb-box");
    expect(service.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", target: 8787 })]);
    expect(parsed.volumes["ogb-data"].name).toBe("ogb-data");
    expect(parsed.networks["ogb-net"].name).toBe("ogb-net");
  });
});
