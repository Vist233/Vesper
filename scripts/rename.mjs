#!/usr/bin/env node
// Changes the placeholder package scope in one step, in every place it appears.
//
// Usage: node scripts/rename.mjs <new-scope> [--root <dir>] [--dry-run]
//   new-scope: an npm scope such as `acme` or `@acme`. The current scope lives in scripts/scope.json (one place),
//   which this script rewrites together with every `<scope>/` in the text files.
// Run `npm install` afterwards so the workspace links and the lock file follow the new names.
import { readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIPPED = new Set(["node_modules", ".git", "coverage", "data", "runs", "vendor"]);
const TEXT_FILE = /\.(ts|mts|js|mjs|json|md|txt|yaml|yml|toml)$|(^|\/)(Dockerfile|LICENSE)$/;
const SCOPE_PATTERN = /^@[a-z0-9][a-z0-9-]*$/;

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/** The scope must be followed by "/" so that e.g. an email address or "@ogbx/..." is never touched. */
export function replaceScope(text, from, to) {
  return text.split(`${from}/`).join(`${to}/`);
}

function main() {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root = resolve(rootFlag === -1 ? process.cwd() : (args[rootFlag + 1] ?? "."));
  const dryRun = args.includes("--dry-run");
  const requested = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--root");
  if (!requested) {
    console.error("usage: node scripts/rename.mjs <new-scope> [--root <dir>] [--dry-run]");
    process.exit(2);
  }
  const target = requested.startsWith("@") ? requested : `@${requested}`;
  if (!SCOPE_PATTERN.test(target)) {
    console.error(`'${requested}' is not a valid npm scope (lowercase letters, digits and hyphens)`);
    process.exit(2);
  }
  const scopePath = resolve(root, "scripts", "scope.json");
  const from = JSON.parse(readFileSync(scopePath, "utf8")).scope;
  if (from === target) {
    console.log(`scope is already ${target}`);
    return;
  }
  let changed = 0;
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (!TEXT_FILE.test(rel)) continue;
    const before = readFileSync(file, "utf8");
    let after = replaceScope(before, from, target);
    if (file === scopePath) after = JSON.stringify({ scope: target }) + "\n";
    if (after === before) continue;
    changed += 1;
    console.log(`${dryRun ? "would change" : "changed"} ${rel}`);
    if (!dryRun) writeFileSync(file, after);
  }
  console.log(`${changed} file(s) ${dryRun ? "would change" : "changed"}: ${from} -> ${target}. Run 'npm install' to refresh workspace links.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
