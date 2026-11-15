#!/usr/bin/env node
// Lists exported functions, classes and constants whose name appears in no test file of the repository.
// A name that no test mentions is a function nobody tests. Report only (exit 0) unless --strict is given (then exit 1 when there are any).
// Usage: node scripts/untested-exports.mjs [--strict]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "vendor" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
};
const files = ["packages", "plugins", "test"].flatMap((root) => {
  try {
    return walk(root);
  } catch {
    return [];
  }
});
const isTest = (f) => /\/test\//.test(f) || /\.test\.(ts|js|mjs)$/.test(f) || f.includes("/testing/");
const testText = files
  .filter((f) => isTest(f) && /\.(ts|js|mjs)$/.test(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const exportPattern = /^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z0-9_]+)/gm;
const rows = new Map();
for (const f of files.filter((f) => /\/src\/.*\.(ts|js)$/.test(f) && !isTest(f))) {
  const pkg = f.split("/").slice(0, 2).join("/");
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(exportPattern)) {
    if (new RegExp(`\\b${m[1]}\\b`).test(testText)) continue;
    if (!rows.has(pkg)) rows.set(pkg, []);
    rows.get(pkg).push(`${f.split("/").slice(2).join("/")}:${m[1]}`);
  }
}
let total = 0;
for (const [pkg, list] of [...rows.entries()].sort()) {
  total += list.length;
  console.log(`${pkg}: ${list.length}\n  ${list.join("\n  ")}`);
}
console.log(total === 0 ? "every exported name is mentioned by a test" : `${total} exported names are mentioned by no test`);
if (process.argv.includes("--strict") && total > 0) process.exit(1);
