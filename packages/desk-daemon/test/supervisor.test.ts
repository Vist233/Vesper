import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killGroup, SupervisedProcess } from "../src/supervisor.ts";
import { alive, eventually, silentLog, tempRoot } from "./helpers.ts";

const root = tempRoot();
const started: SupervisedProcess[] = [];
afterEach(async () => {
  while (started.length) await started.pop()?.stop();
});

function supervise(script: string, extra: Partial<ConstructorParameters<typeof SupervisedProcess>[0]> = {}): SupervisedProcess {
  const process_ = new SupervisedProcess({
    spec: { name: "t", command: "sh", args: ["-c", script] },
    log: silentLog,
    backoff: { initialMs: 20, maxMs: 80, stableMs: 10_000 },
    ...extra,
  });
  started.push(process_);
  return process_;
}

const pidFile = (name: string) => join(root.dir, name);

describe("what a supervised program inherits", () => {
  it("drops variables that look like secrets and keeps the rest; the spec's own variables pass as given", async () => {
    const out = join(root.dir, "env.txt");
    const saved = { ...process.env };
    process.env.COMMANDCODE_API_KEY = "k-123";
    process.env.OGB_API_TOKEN = "t-123";
    process.env.SOME_SERVICE_PASSWORD = "p-123";
    process.env.OGB_VISIBLE = "yes";
    try {
      const p = supervise(`env > '${out}'; sleep 30`, {
        spec: { name: "t", command: "sh", args: ["-c", `env > '${out}'; sleep 30`], env: { OGB_EXPLICIT_TOKEN: "given" } },
      });
      p.start();
      await p.waitReady(2000);
      await eventually(() => existsSync(out) && readFileSync(out, "utf8").includes("OGB_VISIBLE"), Boolean);
      const seen = readFileSync(out, "utf8");
      expect(seen).toContain("OGB_VISIBLE=yes");
      expect(seen).toContain("OGB_EXPLICIT_TOKEN=given");
      for (const name of ["COMMANDCODE_API_KEY", "OGB_API_TOKEN", "SOME_SERVICE_PASSWORD"]) expect(seen).not.toContain(name);
    } finally {
      for (const name of ["COMMANDCODE_API_KEY", "OGB_API_TOKEN", "SOME_SERVICE_PASSWORD", "OGB_VISIBLE"]) delete process.env[name];
      Object.assign(process.env, { ...saved });
    }
  });
});

describe("SupervisedProcess", () => {
  it("starts, reports running, and stops without restarting", async () => {
    const p = supervise("sleep 30");
    p.start();
    await p.waitReady(2000);
    expect(p.health()).toEqual({ state: "running", restarts: 0 });
    const pid = p.pid as number;
    await p.stop();
    expect(alive(pid)).toBe(false);
    expect(p.health().state).toBe("stopped");
    await new Promise((r) => setTimeout(r, 150));
    expect(p.health()).toEqual({ state: "stopped", restarts: 0 });
  });

  it("start and stop are idempotent", async () => {
    const p = supervise("sleep 30");
    p.start();
    const pid = p.pid;
    p.start();
    expect(p.pid).toBe(pid);
    await p.stop();
    await p.stop();
    expect(p.health().state).toBe("stopped");
  });

  it("restarts a process that dies, counts the restart, and reports it as ready again", async () => {
    const p = supervise("sleep 30");
    p.start();
    await p.waitReady(2000);
    const first = p.pid as number;
    process.kill(first, "SIGKILL");
    const restarted = await eventually(
      () => p.pid,
      (pid) => pid !== undefined && pid !== first,
    );
    expect(alive(restarted as number)).toBe(true);
    expect(p.health()).toEqual({ state: "running", restarts: 1 });
  });

  it("leaves no orphan: killing the leader also kills its children", async () => {
    const file = pidFile("child.pid");
    const p = supervise(`sleep 300 & echo $! > ${file}; wait`);
    p.start();
    const childPid = Number(
      await eventually(
        () => readPid(file),
        (v) => v > 0,
      ),
    );
    process.kill(p.pid as number, "SIGKILL");
    await eventually(
      () => alive(childPid),
      (a) => !a,
    );
  });

  it("stop kills the whole group, also a child that ignores SIGTERM", async () => {
    const file = pidFile("stubborn.pid");
    const p = supervise(`(trap '' TERM; sleep 300) & echo $! > ${file}; wait`, { graceMs: 100 });
    p.start();
    const childPid = await eventually(
      () => readPid(file),
      (v) => v > 0,
    );
    await p.stop();
    await eventually(
      () => alive(childPid),
      (a) => !a,
    );
  });

  it("backs off between restarts, growing and capped", async () => {
    const times: number[] = [];
    const p = supervise("exit 1", {
      backoff: { initialMs: 60, maxMs: 240, stableMs: 10_000 },
      beforeStart: () => {
        times.push(Date.now());
      },
    });
    p.start();
    await eventually(
      () => times.length,
      (n) => n >= 5,
    );
    const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
    expect(gaps[2] as number).toBeGreaterThan((gaps[0] as number) + 50); // 60, 120, 240 ms plus start time
    expect(Math.max(...gaps)).toBeLessThan(700); // capped at 240 ms plus start time
    expect(p.health().restarts).toBeGreaterThanOrEqual(4);
  });

  it("reports failed when the program does not exist, and keeps trying", async () => {
    const p = supervise("", { spec: { name: "t", command: "/no/such/program", args: [] } });
    p.start();
    await eventually(
      () => p.health(),
      (h) => h.restarts >= 2,
    );
    expect(["failed", "restarting"]).toContain(p.health().state);
  });

  it("waitReady times out with the process output in the message", async () => {
    const p = supervise("echo boom >&2; sleep 30", { probe: async () => false, probeIntervalMs: 0 });
    p.start();
    await expect(p.waitReady(300)).rejects.toThrow(/boom/);
  });

  it("waits for the probe before it is ready, and restarts a process whose probe keeps failing", async () => {
    let healthy = false;
    let ready = 0;
    const p = supervise("sleep 30", {
      probe: async () => healthy,
      probeIntervalMs: 20,
      probeFailuresToRestart: 3,
      onReady: () => {
        ready += 1;
      },
    });
    p.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(ready).toBe(0);
    healthy = true;
    await p.waitReady(2000);
    const first = p.pid;
    healthy = false;
    await eventually(
      () => p.health().restarts,
      (n) => n >= 1,
    );
    healthy = true;
    await p.waitReady(2000);
    expect(p.pid).not.toBe(first);
    expect(ready).toBeGreaterThanOrEqual(2);
  });

  it("pause keeps it wanted but stopped, resume starts it again", async () => {
    const p = supervise("sleep 30");
    p.start();
    await p.waitReady(2000);
    const pid = p.pid as number;
    await p.pause();
    expect(alive(pid)).toBe(false);
    expect(p.health().state).toBe("restarting");
    await new Promise((r) => setTimeout(r, 150));
    expect(p.pid).toBeUndefined();
    p.resume();
    await p.waitReady(2000);
    expect(alive(p.pid as number)).toBe(true);
  });

  it("pause and resume do nothing for a process that was never started", async () => {
    const p = supervise("sleep 30");
    await p.pause();
    p.resume();
    expect(p.health().state).toBe("stopped");
  });

  it("tells the caller about an unexpected exit but not about a stop", async () => {
    const exits: unknown[] = [];
    const p = supervise("sleep 30", { onUnexpectedExit: (info) => exits.push(info) });
    p.start();
    await p.waitReady(2000);
    process.kill(p.pid as number, "SIGKILL");
    await eventually(
      () => exits.length,
      (n) => n === 1,
    );
    await p.waitReady(2000);
    await p.stop();
    expect(exits).toHaveLength(1);
  });

  it("keeps the tail of the process output", async () => {
    const p = supervise("echo hello-out; echo hello-err >&2; sleep 30");
    p.start();
    await eventually(
      () => p.lastOutput(),
      (o) => o.includes("hello-out") && o.includes("hello-err"),
    );
  });

  it("killGroup on a group that is gone is not an error", () => {
    writeFileSync(pidFile("x"), "");
    expect(() => killGroup(2 ** 22 - 3, "SIGKILL")).not.toThrow();
  });
});

function readPid(file: string): number {
  try {
    return Number(readFileSync(file, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}
