#!/usr/bin/env node
// Bundles each first-party plugin into plain JavaScript files that carry their own dependencies.
//
// Why: the plugin host copies a plugin into a read-only cache and loads it from there. The cache has no node_modules, so
// a plugin that imports a library would fail to load. A bundle (plugins/<name>/dist/tools.js, sources.js) is one file
// per entry, hashed with the plugin, and the library inside it is exactly the one that was reviewed.
// Convention: plugins/<name>/src/tools.ts and src/sources.ts are the entries; dist/ is generated and not committed.
//
// Usage: node scripts/build-plugins.mjs [--root <dir>]
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const ENTRIES = ["tools", "sources"];
const BANNER = "import { createRequire as __ogbCreateRequire } from 'node:module'; const require = __ogbCreateRequire(import.meta.url);";

export function buildPlugins(root) {
  const built = [];
  const base = join(root, "plugins");
  if (!existsSync(base)) return built;
  for (const name of readdirSync(base)) {
    for (const entry of ENTRIES) {
      const source = join(base, name, "src", `${entry}.ts`);
      if (!existsSync(source)) continue;
      const outfile = join(base, name, "dist", `${entry}.js`);
      buildSync({
        entryPoints: [source],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        external: ["sakura-agent"],
        banner: { js: BANNER },
        logLevel: "warning",
      });
      built.push(outfile);
    }
  }
  return built;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? resolve(dirname(fileURLToPath(import.meta.url)), "..") : resolve(process.argv[rootFlag + 1] ?? ".");
  for (const file of buildPlugins(root)) console.log(`built ${file.replace(`${root}/`, "")}`);
}
