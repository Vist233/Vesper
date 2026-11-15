import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const IMAGE = process.env.OGB_E2E_IMAGE ?? "ogb-box:dev";
const here = (name: string) => new URL(`./in-box/${name}`, import.meta.url).pathname;

/** Everything these tests create is named ogb-e2e-*; they never touch any other container, image or volume. */
function assertOurs(name: string): void {
  if (!/^ogb-e2e-[a-z0-9-]+$/.test(name)) throw new Error(`refusing to touch ${name}`);
}

async function docker(args: string[], input?: string): Promise<string> {
  if (input === undefined) return (await run("docker", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`docker ${args.slice(0, 3).join(" ")} failed (${code}): ${err.slice(-400)}`))));
    child.stdin.end(input);
  });
}

export interface WorkspaceInfoJson {
  spec: { workspaceId: string; screen: { width: number; height: number } };
  display: string;
  cdpUrl: string;
  filesDir: string;
  profileDir: string;
}

export interface WorkspaceHealthJson {
  state: string;
  processes?: Record<string, { state: string; restarts: number }>;
}

export class Box {
  readonly name: string;
  readonly volume: string;
  private readonly ownsVolume: boolean;

  private constructor(name: string, volume: string, ownsVolume: boolean) {
    assertOurs(name);
    assertOurs(volume);
    this.name = name;
    this.volume = volume;
    this.ownsVolume = ownsVolume;
  }

  /** Starts a container from the image with the limits of the compose file (4 CPU, 4 GB) unless overridden. */
  static async start(options: { label: string; memory?: string; cpus?: string; volume?: string } = { label: "t" }): Promise<Box> {
    const id = `${options.label}-${randomBytes(3).toString("hex")}`;
    const name = `ogb-e2e-${id}`;
    const volume = options.volume ?? `ogb-e2e-vol-${id}`;
    const memory = options.memory ?? "4g";
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--memory",
      memory,
      "--memory-swap",
      memory,
      "--cpus",
      options.cpus ?? "4",
      "--shm-size",
      "1g",
      "--pids-limit",
      "4096",
      "--security-opt",
      "no-new-privileges:true",
      "-v",
      `${volume}:/data`,
      IMAGE,
    ]);
    const box = new Box(name, volume, options.volume === undefined);
    await box.waitForDaemon();
    return box;
  }

  async exec(command: string[], input?: string): Promise<string> {
    return docker(["exec", ...(input === undefined ? [] : ["-i"]), this.name, ...command], input);
  }

  sh(script: string): Promise<string> {
    return this.exec(["sh", "-c", script]);
  }

  async waitForDaemon(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const response = await this.call("health", { workspaceId: "probe" });
        if (response.ok) return;
      } catch {
        // the container or the daemon is not up yet
      }
      if (Date.now() > deadline) throw new Error(`desk-daemon of ${this.name} did not answer in ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** One protocol call to the daemon, from inside the container. Returns the raw response. */
  async call(method: string, params: unknown): Promise<{ ok: boolean; result?: any; error?: { kind: string; message: string } }> {
    const request = JSON.stringify({ v: 1, id: randomBytes(4).toString("hex"), method, params });
    const out = await docker(["exec", "-i", this.name, "node", "/tmp/rpc.mjs"], request).catch(async (error: Error) => {
      if (!/No such file|exit code 1|MODULE_NOT_FOUND|Cannot find module/.test(String(error))) throw error;
      await this.install();
      return docker(["exec", "-i", this.name, "node", "/tmp/rpc.mjs"], request);
    });
    return JSON.parse(out);
  }

  private async install(): Promise<void> {
    for (const file of ["rpc.mjs", "cdp.mjs", "fixture-server.mjs"]) await docker(["cp", here(file), `${this.name}:/tmp/${file}`]);
  }

  async ensure(workspaceId: string): Promise<WorkspaceInfoJson> {
    const response = await this.call("ensure", { workspaceId });
    if (!response.ok) throw new Error(`ensure ${workspaceId}: ${response.error?.kind} ${response.error?.message}`);
    return response.result;
  }

  async health(workspaceId: string): Promise<WorkspaceHealthJson> {
    const response = await this.call("health", { workspaceId });
    if (!response.ok) throw new Error(`health: ${response.error?.message}`);
    return response.result as WorkspaceHealthJson;
  }

  async waitState(workspaceId: string, state: string, timeoutMs = 60_000): Promise<WorkspaceHealthJson> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const health = await this.health(workspaceId).catch((): WorkspaceHealthJson => ({ state: "unreachable" }));
      if (health.state === state) return health;
      if (Date.now() > deadline) throw new Error(`${workspaceId} is ${health.state}, wanted ${state} after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** Starts the fixture site inside the container (once). */
  async startFixtureServer(): Promise<void> {
    await this.install();
    await docker(["exec", "-d", this.name, "node", "/tmp/fixture-server.mjs"]);
    for (let i = 0; i < 50; i++) {
      if (
        (await this.sh("node -e \"fetch('http://127.0.0.1:9100/color').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\" && echo up || true")).includes(
          "up",
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("fixture server did not start");
  }

  /** Talks to the workspace's browser over the DevTools protocol, from inside the container. */
  async cdp(info: WorkspaceInfoJson, request: { navigate?: string; calls?: Array<{ method: string; params?: unknown }> }): Promise<any[]> {
    const port = Number(new URL(info.cdpUrl).port);
    return JSON.parse(await docker(["exec", "-i", this.name, "node", "/tmp/cdp.mjs"], JSON.stringify({ port, ...request })));
  }

  /** PIDs of processes whose command line contains `needle` (the shell running this search excluded). */
  async pids(needle: string): Promise<number[]> {
    const out = await this.sh(`ps -eo pid=,args= | grep -F -- '${needle}' | grep -v 'grep -F' | awk '{print $1}'`).catch(() => "");
    return out.split("\n").filter(Boolean).map(Number);
  }

  async stopContainer(): Promise<void> {
    await docker(["stop", "-t", "30", this.name]);
  }

  async killContainer(): Promise<void> {
    await docker(["kill", this.name]);
  }

  async startContainer(): Promise<void> {
    await docker(["start", this.name]);
    await this.waitForDaemon();
  }

  /** Removes this test's container and, if it made it, its volume, by exact name. */
  async remove(): Promise<void> {
    assertOurs(this.name);
    await docker(["rm", "-f", this.name]).catch(() => undefined);
    if (this.ownsVolume) await docker(["volume", "rm", this.volume]).catch(() => undefined);
  }
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
