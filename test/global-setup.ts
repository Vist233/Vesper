import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** The tests that load first-party plugins through the plugin host need their bundles; building takes well under a second per plugin. */
export default function setup(): void {
  const root = resolve(import.meta.dirname, "..");
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-plugins.mjs")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`building plugins failed:\n${result.stdout}\n${result.stderr}`);
}
