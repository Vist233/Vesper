#!/usr/bin/env node
// Scans files for things that must never be committed or published: personal paths, keys, session ids.
//
// Usage: node scripts/scan-secrets.mjs [--root <dir>] [paths...]
//   no paths: every file tracked by git under the root (falls back to a directory walk when there is no git).
// Exit 0 = clean, 1 = findings. Findings print the file, line and rule, never the matched text of a key.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Each rule has a name, a pattern and whether the matched text is safe to show. */
const RULES = [
  { name: "personal-path", pattern: /\/(?:Users|home)\/(?!user\b|me\b|example\b|runner\b|node\b|\*)[A-Za-z0-9._-]+\//, show: true },
  { name: "windows-user-path", pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/, show: true },
  { name: "private-key-block", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, show: false },
  {
    name: "api-key",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,})\b/,
    show: false,
  },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/, show: false },
  { name: "assigned-secret", pattern: /\b(?:api[_-]?key|secret|password|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{20,}["']/i, show: false },
  {
    name: "session-id",
    pattern: /\b(?:local_|session[-_]?id["']?\s*[:=]\s*["']?)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    show: false,
  },
];

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "coverage", "data", "runs"]);
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|ico|woff2?|tgz|gz|zip|pdf)$/i;

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

function trackedFiles(root) {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output
      .split("\0")
      .filter(Boolean)
      .map((file) => join(root, file));
  } catch {
    return walk(root);
  }
}

/** Allowlist lines in scripts/scan-allowlist.txt: `<relative path>` skips a file, `<relative path>:<rule>` skips one rule in it. */
function loadAllowlist(root) {
  const path = join(root, "scripts", "scan-allowlist.txt");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function scanText(text) {
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match) findings.push({ line: index + 1, rule: rule.name, text: rule.show ? match[0] : undefined });
    }
  });
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root = resolve(rootFlag === -1 ? process.cwd() : (args[rootFlag + 1] ?? "."));
  const explicit = args.filter((arg, i) => arg !== "--root" && args[i - 1] !== "--root").map((arg) => resolve(arg));
  const files = explicit.length > 0 ? explicit : trackedFiles(root);
  const allowlist = loadAllowlist(root);
  let count = 0;
  for (const file of files) {
    const rel = relative(root, file);
    if (BINARY_EXTENSIONS.test(file) || !existsSync(file) || allowlist.includes(rel)) continue;
    for (const found of scanText(readFileSync(file, "utf8"))) {
      if (allowlist.includes(`${rel}:${found.rule}`)) continue;
      count += 1;
      console.error(`${rel}:${found.line}: ${found.rule}${found.text ? ` (${found.text})` : ""}`);
    }
  }
  if (count > 0) {
    console.error(`${count} finding(s)`);
    process.exit(1);
  }
  console.log(`scan ok (${files.length} files)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
