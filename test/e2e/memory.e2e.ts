import { mkdirSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Box, type WorkspaceInfoJson } from "./box.ts";
import { FIXTURE } from "./helpers.ts";

// Memory of the box with 0, 1, 2, 4 and 6 workspaces, each showing the same ordinary-sized page (/heavy: ~4000 DOM nodes and a
// 2000x1000 canvas). Method (written to docs/test-report.md too): ensure the workspaces one after the other, load the page in each,
// wait 30 s for the browsers to settle, then take 3 samples 5 s apart and keep the median. Figures come from inside the container:
// the cgroup counters (memory.current, and memory.stat anon / file / shmem) and the proportional set size (PSS) of every process,
// summed by kind. docker's own view (docker stats) is recorded for comparison.
const STEPS = [1, 2, 4, 6];
const SETTLE_MS = 30_000;

interface Sample {
  workspaces: number;
  cgroupCurrentMiB: number;
  anonMiB: number;
  fileMiB: number;
  shmemMiB: number;
  pssMiB: { chromium: number; xvfb: number; openbox: number; node: number; other: number; total: number };
  dockerStatsMiB: number;
  ensureSeconds: number | null;
}

let box: Box;
beforeAll(async () => {
  box = await Box.start({ label: "mem" });
  await box.startFixtureServer();
});
afterAll(async () => {
  await box?.remove();
});

const MEASURE = String.raw`
const fs = require("fs");
const mib = (n) => Math.round((n / 1048576) * 10) / 10;
const stat = Object.fromEntries(fs.readFileSync("/sys/fs/cgroup/memory.stat", "utf8").trim().split("\n").map((l) => l.split(" ")));
const pss = { chromium: 0, xvfb: 0, openbox: 0, node: 0, other: 0 };
for (const pid of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
  try {
    const cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ");
    const rollup = fs.readFileSync("/proc/" + pid + "/smaps_rollup", "utf8");
    const kb = Number((rollup.match(/^Pss:\s+(\d+) kB/m) || [0, 0])[1]);
    const kind = /chrome|chromium/.test(cmd) ? "chromium" : /Xvfb/.test(cmd) ? "xvfb" : /openbox/.test(cmd) ? "openbox" : /node/.test(cmd) ? "node" : "other";
    pss[kind] += kb * 1024;
  } catch {}
}
const total = Object.values(pss).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({
  cgroupCurrentMiB: mib(Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8"))),
  anonMiB: mib(Number(stat.anon)), fileMiB: mib(Number(stat.file)), shmemMiB: mib(Number(stat.shmem)),
  pssMiB: { ...Object.fromEntries(Object.entries(pss).map(([k, v]) => [k, mib(v)])), total: mib(total) },
}));
`;

async function sampleOnce(workspaces: number, ensureSeconds: number | null): Promise<Sample> {
  const inside = JSON.parse(await box.exec(["node", "-e", MEASURE]));
  const stats = await dockerStats();
  return { workspaces, ...inside, dockerStatsMiB: stats, ensureSeconds };
}

async function dockerStats(): Promise<number> {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", box.name], { encoding: "utf8" }).trim();
  const used = out.split("/")[0]?.trim() ?? "0MiB";
  const value = Number.parseFloat(used);
  return /GiB/.test(used) ? Math.round(value * 1024 * 10) / 10 : value;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

async function measure(workspaces: number, ensureSeconds: number | null): Promise<Sample> {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const samples: Sample[] = [];
  for (let i = 0; i < 3; i++) {
    samples.push(await sampleOnce(workspaces, ensureSeconds));
    await new Promise((r) => setTimeout(r, 5000));
  }
  const m = (pick: (s: Sample) => number) => Math.round(median(samples.map(pick)) * 10) / 10;
  return {
    workspaces,
    cgroupCurrentMiB: m((s) => s.cgroupCurrentMiB),
    anonMiB: m((s) => s.anonMiB),
    fileMiB: m((s) => s.fileMiB),
    shmemMiB: m((s) => s.shmemMiB),
    pssMiB: {
      chromium: m((s) => s.pssMiB.chromium),
      xvfb: m((s) => s.pssMiB.xvfb),
      openbox: m((s) => s.pssMiB.openbox),
      node: m((s) => s.pssMiB.node),
      other: m((s) => s.pssMiB.other),
      total: m((s) => s.pssMiB.total),
    },
    dockerStatsMiB: m((s) => s.dockerStatsMiB),
    ensureSeconds,
  };
}

describe("memory of the box", () => {
  it("is measured with 0, 1, 2, 4 and 6 workspaces", { timeout: 900_000 }, async () => {
    const results: Sample[] = [await measure(0, null)];
    const infos: WorkspaceInfoJson[] = [];
    for (const target of STEPS) {
      const started = Date.now();
      while (infos.length < target) {
        const info = await box.ensure(`mem${infos.length + 1}`);
        await box.cdp(info, { navigate: `${FIXTURE}/heavy` });
        infos.push(info);
      }
      const seconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
      results.push(await measure(target, seconds));
    }
    const dir = new URL("./results/", import.meta.url).pathname;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}memory-${arch()}.json`, `${JSON.stringify({ method: "see docs/test-report.md", limitMiB: 4096, arch: arch(), results }, null, 2)}\n`);
    console.table(
      results.map((r) => ({
        workspaces: r.workspaces,
        cgroup: r.cgroupCurrentMiB,
        anon: r.anonMiB,
        file: r.fileMiB,
        shmem: r.shmemMiB,
        pssTotal: r.pssMiB.total,
        chromiumPss: r.pssMiB.chromium,
        docker: r.dockerStatsMiB,
      })),
    );
    expect(results).toHaveLength(STEPS.length + 1);
    for (const result of results) expect(result.cgroupCurrentMiB).toBeLessThan(4096);
  });
});
