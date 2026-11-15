import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "..", "..");

/** A throwaway repository root that holds the real scripts and table, so a script is tested as it is shipped. */
export function makeSandboxRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ogb-scripts-"));
  cpSync(join(repoRoot, "scripts"), join(root, "scripts"), { recursive: true });
  return root;
}

export function writeIn(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function runScript(root: string, script: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script), "--root", root, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
