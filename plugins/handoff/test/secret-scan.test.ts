import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanDirectory, secretReview } from "../src/secret-scan.ts";

const dirs: string[] = [];
function packageWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ogb-scan-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Built at run time, so that no secret-looking text sits in this file.
const apiKey = ["sk", "A".repeat(24)].join("-");
const bearer = ["Bearer", "b".repeat(30)].join(" ");
const assigned = `password = "${"c".repeat(22)}"`;
const pem = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const personal = ["/Users", "someone", "notes.txt"].join("/");

describe("the secret review of a handoff package", () => {
  it("finds each kind of secret and a personal path, naming the file and the rule and never the text", async () => {
    const root = packageWith({ "a/key.txt": apiKey, "b.md": bearer, "c.json": assigned, "d.pem": pem, "e.txt": `see ${personal}` });
    const found = await scanDirectory(root);
    expect(Object.fromEntries(found.map((f) => [f.file, f.rule]))).toEqual({
      [join("a", "key.txt")]: "API key",
      "b.md": "bearer token",
      "c.json": "assigned secret",
      "d.pem": "private key",
      "e.txt": "personal path",
    });
    expect(JSON.stringify(found)).not.toContain("AAAA");
  });

  it("passes a clean package, and a neutral home path is not personal", async () => {
    const root = packageWith({ "result.md": "Total: 42. Saved to /home/user/out.csv and /Users/me/x.", "data/rows.csv": "a,b\n1,2\n" });
    expect(await scanDirectory(root)).toEqual([]);
    expect(await secretReview({ packageDir: root })).toEqual({ approved: true, reason: "no secrets or personal paths found" });
  });

  it("refuses with the list of files, still without the text", async () => {
    const root = packageWith({ "notes.txt": apiKey });
    const verdict = await secretReview({ packageDir: root });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toContain("notes.txt (API key)");
    expect(verdict.reason).not.toContain(apiKey);
  });
});
