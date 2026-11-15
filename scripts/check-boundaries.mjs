#!/usr/bin/env node
// Enforces the allowed-dependency table of docs/07 section 2 (scripts/allowed-dependencies.json).
//
// Why a script and not a lint rule: the table is the architecture. A package may import another
// only through its public entry, only when the table lists the edge, and never by reaching into
// its `src/`. Anything else makes the build fail, so a wrong edge is found in minutes, not months.
//
// Usage: node scripts/check-boundaries.mjs [--root <dir>]   (exit 0 = clean, 1 = violations)
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "scope.json"), "utf8")).scope;
const SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'\s]+)["']/g;

/** Strips comments so a commented-out import is not reported (strings are left alone on purpose). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "fixtures" || name === "dist") continue; // dist holds generated bundles
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...listFiles(path));
    else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) found.push(path);
  }
  return found;
}

/** Package units found under root: packages/<name> use their own rules, plugins/<name> share one rule set. */
function discoverUnits(root, table) {
  const units = [];
  for (const [kind, rules] of [
    ["packages", null],
    ["plugins", table.plugins],
  ]) {
    const base = join(root, kind);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory()) continue;
      const extra = kind === "plugins" ? table.plugins.overrides?.[name] : undefined;
      const unitRules = kind === "packages" ? table.packages[name] : { ...rules, externals: [...rules.externals, ...(extra?.externals ?? [])] };
      units.push({ kind, name, dir, rules: unitRules });
    }
  }
  return units;
}

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function checkSpecifier({ specifier, file, unit, root }) {
  const where = relative(root, file);
  const inTests = file.includes(`${sep}test${sep}`) || file.includes(`${sep}testing${sep}`);
  const violation = (message) => ({ file: where, specifier, message });

  if (specifier.startsWith(".")) {
    const target = resolve(dirname(file), specifier);
    if (!target.startsWith(unit.dir + sep) && target !== unit.dir) {
      return violation(`relative import leaves the package '${unit.name}'; import another package by its public entry (${SCOPE}/<name>)`);
    }
    return null;
  }
  if (specifier.startsWith("node:")) {
    return unit.rules.builtins ? null : violation(`'${unit.name}' must not import node built-ins (it is pure)`);
  }
  if (specifier.startsWith(`${SCOPE}/`)) {
    const [, target, ...subpath] = specifier.split("/");
    const sub = subpath.join("/");
    if (target === unit.name) return violation("a package must import itself by relative path");
    const allowed = inTests ? [...unit.rules.dependencies, ...(unit.rules.testDependencies ?? [])] : unit.rules.dependencies;
    if (!allowed.includes(target)) {
      return violation(
        unit.rules.testDependencies?.includes(target)
          ? `edge '${unit.name}' -> '${target}' is allowed in tests only ('testDependencies'); src must not import it`
          : `edge '${unit.name}' -> '${target}' is not in the allowed-dependency table (docs/07 section 2)`,
      );
    }
    if (sub === "testing") return inTests ? null : violation(`'${specifier}' is a test double; only test files and src/testing may import it`);
    if (sub !== "")
      return violation(`import '${specifier}' reaches into the internals of '${target}'; use '${SCOPE}/${target}' or '${SCOPE}/${target}/testing'`);
    return null;
  }
  const external = packageNameOf(specifier);
  if (unit.rules.externals.includes(external)) return null;
  if (inTests && ["vitest", "fast-check"].includes(external)) return null;
  return violation(`external package '${external}' is not allowed in '${unit.name}' (see "externals" in scripts/allowed-dependencies.json)`);
}

export function findViolations(root) {
  const table = JSON.parse(readFileSync(join(root, "scripts", "allowed-dependencies.json"), "utf8"));
  const violations = [];
  for (const unit of discoverUnits(root, table)) {
    if (!unit.rules) {
      violations.push({ file: relative(root, unit.dir), specifier: "", message: `package '${unit.name}' is not in the allowed-dependency table` });
      continue;
    }
    for (const file of listFiles(unit.dir)) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const found = checkSpecifier({ specifier, file, unit, root });
        if (found) violations.push(found);
      }
    }
    violations.push(...checkManifest(unit, root));
  }
  return violations;
}

/** The package.json must declare the same workspace edges as the table, no more and no fewer. */
function checkManifest(unit, root) {
  const manifestPath = join(unit.dir, "package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith(`${SCOPE}/`))
    .map((name) => name.slice(SCOPE.length + 1));
  const allowed = [...unit.rules.dependencies, ...(unit.rules.testDependencies ?? [])];
  return declared
    .filter((name) => !allowed.includes(name))
    .map((name) => ({
      file: relative(root, manifestPath),
      specifier: `${SCOPE}/${name}`,
      message: `package.json declares '${name}', which the table does not allow`,
    }));
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = rootFlag === -1 ? resolve(here, "..") : resolve(process.argv[rootFlag + 1] ?? ".");
  const violations = findViolations(root);
  for (const v of violations) console.error(`boundary violation: ${v.file}${v.specifier ? ` imports '${v.specifier}'` : ""}: ${v.message}`);
  if (violations.length > 0) {
    console.error(`${violations.length} boundary violation(s)`);
    process.exit(1);
  }
  console.log("boundaries ok");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
