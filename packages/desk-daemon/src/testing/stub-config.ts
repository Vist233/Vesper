import { fileURLToPath } from "node:url";
import { type DaemonConfig, defaultConfig } from "../config.ts";

const stub = (name: string) => ({ command: process.execPath, args: [fileURLToPath(new URL(`./stubs/${name}`, import.meta.url))] });

/** A daemon configuration whose four programs are the stub scripts, so the real daemon code runs on any machine. */
export function stubConfig(paths: { dataDir: string; socketPath: string; x11Dir: string }, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return defaultConfig({
    ...paths,
    xvfb: stub("fake-xvfb.mjs"),
    openbox: stub("fake-openbox.mjs"),
    chromium: stub("fake-chromium.mjs"),
    x11vnc: stub("fake-x11vnc.mjs"),
    noSandbox: true,
    backoff: { initialMs: 50, maxMs: 400, stableMs: 5000 },
    probeIntervalMs: 100,
    startTimeoutMs: 10_000,
    portShift: (process.pid % 300) * 100,
    loginSyncMs: 0, // the stub browser speaks no DevTools; the sharing has its own tests
    ...overrides,
  });
}
