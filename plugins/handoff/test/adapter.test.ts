import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHandoffPort } from "../src/adapter.ts";
import { secretReview } from "../src/secret-scan.ts";

const dirs: string[] = [];
function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ogb-handoff-${label}-`));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two agents of one box: one shared store, a files directory each. */
function twoAgents(hooks: Parameters<typeof createHandoffPort>[0]["hooks"] = { review: secretReview }) {
  const store = temp("store");
  const a = temp("agent-a");
  const b = temp("agent-b");
  return {
    store,
    a,
    b,
    agentA: createHandoffPort({ storeRoot: store, workDir: a, agentId: "agent-a", hooks }),
    agentB: createHandoffPort({ storeRoot: store, workDir: b, agentId: "agent-b", hooks }),
  };
}

function packageFiles(options: { id?: string; version?: string; check?: string; extra?: Record<string, string> } = {}): Record<string, string | object> {
  return {
    "handoff.json": {
      id: options.id ?? "dataset/prices",
      version: options.version ?? "1.0.0",
      description: "Daily prices, checked for gaps. Use when you need clean prices.",
      tags: ["finance"],
      verify: { cmd: ["node", "check.js"], cwd: "." },
    },
    "data.csv": "day,price\n1,10\n2,11\n",
    "check.js": options.check ?? "process.exit(0);",
    ...options.extra,
  };
}

describe("two agents sharing one store", () => {
  it("one publishes a checked package, the other finds it, looks at it, pulls it and re-runs its check", async () => {
    const { agentA, agentB, b } = twoAgents();
    const published = await agentA.publish(packageFiles());
    expect(published).toMatchObject({ status: "accepted", id: "dataset/prices", version: "1.0.0" });

    const found = await agentB.search("prices");
    expect(found.results.map((r) => r.id)).toEqual(["dataset/prices"]);
    const peek = await agentB.peek("dataset/prices", ".");
    expect(peek).toMatchObject({ id: "dataset/prices", tags: ["finance"] });
    expect(JSON.stringify(peek)).toContain("data.csv");
    const pulled = await agentB.pull("dataset/prices", true);
    expect(pulled).toMatchObject({ id: "dataset/prices", verified: true });
    expect(String(pulled.path)).toContain(join(b, ".exchange"));
    expect(statSync(join(String(pulled.path), "data.csv")).isFile()).toBe(true);
  });

  it("records who published it, and versions cannot be changed", async () => {
    const { agentA, agentB } = twoAgents();
    await agentA.publish(packageFiles());
    await expect(agentB.publish(packageFiles({ extra: { "data.csv": "day,price\n1,99\n" } }))).rejects.toThrow(/already exists; versions are immutable/);
    expect(await agentB.publish(packageFiles({ version: "1.0.1" }))).toMatchObject({ status: "accepted", version: "1.0.1" });
  });

  it("rejects a package whose own check fails, and nothing is stored", async () => {
    const { agentA, agentB } = twoAgents();
    const result = await agentA.publish(packageFiles({ check: "process.exit(3);" }));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.reason).toContain("Verification failed");
    expect((await agentB.search("prices")).total).toBe(0);
  });

  it("refuses a package with a secret in it (our review hook) and says where, without printing the secret", async () => {
    const { agentA, agentB } = twoAgents();
    const secret = `sk-${"a1B2c3D4e5F6g7H8i9J0k1L2m3"}`;
    const result = await agentA.publish(packageFiles({ extra: { "notes.txt": `use ${secret} to log in` } }));
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("notes.txt (API key)");
    expect(result.reason).not.toContain(secret);
    expect((await agentB.search("prices")).total).toBe(0);
    const pathResult = await agentA.publish(packageFiles({ id: "dataset/paths", extra: { "readme.md": `see ${"/Us"}ers/someone/project/x` } }));
    expect(pathResult.reason).toContain("personal path");
  });

  it("a package changed in the store after publishing fails its check on pull", async () => {
    const { agentA, agentB, store } = twoAgents();
    await agentA.publish(packageFiles());
    // the stored blob of check.js is altered on disk
    const blobs: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (readFileText(path).includes("process.exit")) blobs.push(path);
      }
    };
    walk(store);
    expect(blobs.length).toBeGreaterThan(0);
    for (const blob of blobs) appendFileSync(blob, "\nprocess.exit(9);\n");
    await expect(agentB.pull("dataset/prices", true).then((r) => (r.verified === true ? "passed" : "failed"))).rejects.toThrow(
      /hash|digest|tamper|mismatch|corrupt/i,
    );
  });

  it("refuses a package directory that contains a symbolic link", async () => {
    const { agentA, a } = twoAgents();
    const dir = join(a, "pkg");
    mkdirSync(dir);
    writeFileSync(join(dir, "handoff.json"), JSON.stringify({ id: "dataset/linked", version: "1.0.0", description: "d" }));
    writeFileSync(join(a, "outside.txt"), "outside");
    symlinkSync(join(a, "outside.txt"), join(dir, "link.txt"));
    await expect(agentA.publish(dir)).rejects.toThrow();
  });

  it("peek cannot read a path outside the package", async () => {
    const { agentA, agentB } = twoAgents();
    await agentA.publish(packageFiles());
    await expect(agentB.peek("dataset/prices", "../../../etc/passwd")).rejects.toThrow();
  });
});

function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
