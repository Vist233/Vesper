import { existsSync } from "node:fs";
import { join } from "node:path";
import { OgbError, type StartupLine, type WorkspaceHost } from "@vesper/contracts";
import { createGateway, type Gateway } from "@vesper/gateway";
import { createModelRegistry, type ModelRegistryOptions } from "@vesper/model-registry";
import { createPluginHost } from "@vesper/plugin-host";
import type { ProfileConfig } from "@vesper/profiles";
import { createEnvironmentProvider, createSecretRegistry } from "@vesper/secrets";
import { createHostWorkspaces, createSessionRuntime, type SessionRuntime } from "@vesper/session-runtime";
import { createFileSessionStore } from "@vesper/session-store";
import { createWorkspaceClient } from "@vesper/workspace-client";
import { checkBackends } from "./backends.ts";
import { checkReferences, FIRST_PARTY_PLUGINS, loadMcpConfig, loadModelConfig, loadProfileConfig, withoutUnusableProfiles } from "./config.ts";
import { type AppEnvironment, hasModelKey, MODEL_KEY_VARIABLE, parseEnvironment, secretValues, takeSecrets } from "./environment.ts";
import { createLogger } from "./logger.ts";
import { installFirstPartyPlugins } from "./plugins.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface AppDeps {
  /** The desk-daemon's host. Default: the socket client for `OGB_DESK_SOCKET`. */
  workspaceHost?: WorkspaceHost & { close(): void };
  /** Builds the model client from resolved options. Default: the framework's `createChatClient`. */
  createClient?: ModelRegistryOptions["createClient"];
  /** Where to look for `sakura-browser-worker` when reporting what is installed (colon-separated). Default: the PATH commands get in a workspace. */
  backendSearchPath?: string;
  now?: () => number;
}

export interface AppOptions {
  /** The process environment. The model key and the other secret variables are taken out of it at start (see `takeSecrets`). */
  env: Record<string, string | undefined>;
  /** One finished JSON log line, without the newline. */
  write(line: string): void;
  deps?: AppDeps;
}

export interface StartupReport {
  /** What is up and what is not, one fact per line (also logged). */
  lines: StartupLine[];
  listening: { host: string; port: number };
  keyPresent: boolean;
  plugins: { loaded: string[]; skipped: { name: string; reason: string }[] };
  profiles: string[];
  deskReachable: boolean;
  backends: { worker: boolean; kit: boolean };
  resumed: string[];
  failedToResume: { id: string; error: string }[];
}

export interface App {
  /** Builds everything and starts listening. Rejects when something that must be up is not (the environment, the stores, the port). */
  start(): Promise<StartupReport>;
  /** Stops accepting, closes every session, closes the workspace client. Harmless to call twice. */
  stop(): Promise<void>;
  readonly runtime: SessionRuntime | undefined;
  /**
   * The start-up report's lines, empty until `start()` has finished. The gateway gets this same function as its lazy
   * `startup` option and `/api/options` returns it (usable plan D10).
   */
  startup(): StartupLine[];
}

const DESK_PROBE_MS = 3000;
const STOP_LIMIT_MS = 15_000;

export function createApp(options: AppOptions): App {
  let config: AppEnvironment | undefined;
  let runtime: SessionRuntime | undefined;
  let gateway: Gateway | undefined;
  let host: (WorkspaceHost & { close(): void }) | undefined;
  let stopping: Promise<void> | undefined;
  let ready = false;
  let startupLines: StartupLine[] = [];
  /** The secret variables, taken out of the environment at start; the only copy in this process. */
  let held: Record<string, string | undefined> = {};

  // Secrets are known only after the environment is read; until then no line is logged that could hold one.
  const log = createLogger({ write: options.write, secrets: () => (config ? secretValues(held, config) : []) });

  async function start(): Promise<StartupReport> {
    const env = parseEnvironment(options.env);
    config = env;
    held = takeSecrets(options.env, [MODEL_KEY_VARIABLE, ...env.extraSecretVariables, "OGB_API_TOKEN"]);
    const keyPresent = hasModelKey(held);

    const models = loadModelConfig(env);
    let profiles: ProfileConfig = loadProfileConfig(env);
    const mcp = loadMcpConfig(env);
    const profilesFromFile = existsSync(join(env.dataDir, "config", "profiles.json"));

    const install = installFirstPartyPlugins({ appRoot: env.appRoot, cacheDir: join(env.dataDir, "plugin-cache") });
    const installedNames = install.installed.map((plugin) => plugin.manifest.name);
    // The built-in profiles lose a plugin that failed to install (reported below); a profile file the owner wrote must be right.
    if (!profilesFromFile) profiles = withoutUnusableProfiles(profiles, installedNames);
    const problems = checkReferences(models, profiles, installedNames);
    if (problems.length > 0) throw new OgbError("invalid_input", `the configuration does not fit together:\n- ${problems.join("\n- ")}`);
    if (Object.keys(profiles.profiles).length === 0) throw new OgbError("unavailable", "no profile can be used: none of its plugins is installed");

    const secrets = createSecretRegistry({
      env: createEnvironmentProvider({ env: held, allowed: [MODEL_KEY_VARIABLE, ...env.extraSecretVariables] }),
    });
    host = options.deps?.workspaceHost ?? createWorkspaceClient({ socketPath: env.deskSocket });
    const workspaceHost = host;

    runtime = createSessionRuntime({
      store: createFileSessionStore({ root: join(env.dataDir, "state") }),
      models: createModelRegistry({ config: models, secrets, ...(options.deps?.createClient ? { createClient: options.deps.createClient } : {}) }),
      profiles,
      waits: env.waits,
      limits: env.limits,
      summaries: true,
      ...(mcp ? { mcp } : {}),
      pluginHost: createPluginHost(install.installed),
      workspaces: createHostWorkspaces(workspaceHost),
      secrets,
      log,
      ...(options.deps?.now ? { now: options.deps.now } : {}),
    });

    const deskReachable = await probe(workspaceHost);
    gateway = createGateway({
      runtime,
      workspaces: workspaceHost,
      catalog: () => ({ profiles: Object.keys(profiles.profiles), defaultProfile: profiles.default, models: Object.keys(models.models) }),
      staticDir: env.webDir,
      ready: () => ready,
      startup: () => startupLines,
      openListen: env.openListen,
      ...(env.token ? { token: env.token } : {}),
      log,
    });
    const listening = await gateway.listen({ host: env.host, port: env.port });

    const resumed = await runtime.resumeAll();
    ready = true;

    const backends = checkBackends(env.appRoot, options.deps?.backendSearchPath !== undefined ? { searchPath: options.deps.backendSearchPath } : {});
    const report: StartupReport = {
      lines: [],
      listening,
      keyPresent,
      plugins: { loaded: installedNames, skipped: install.skipped },
      profiles: Object.keys(profiles.profiles),
      deskReachable,
      backends: { worker: backends.worker, kit: backends.kit },
      resumed: resumed.opened,
      failedToResume: resumed.failed,
    };
    report.lines = describe(report, env, FIRST_PARTY_PLUGINS.length, backends.lines);
    startupLines = report.lines;
    for (const line of report.lines) log({ level: line.level, message: line.text });
    log({ level: "info", message: "startup complete", up: true, port: listening.port });
    return report;
  }

  async function probe(workspaceHost: WorkspaceHost): Promise<boolean> {
    try {
      await Promise.race([
        workspaceHost.health("ogb-startup-probe"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), DESK_PROBE_MS).unref()),
      ]);
      return true;
    } catch (error) {
      log({ level: "warn", message: "the desk-daemon does not answer yet; sessions will retry when they start", error: String(error) });
      return false;
    }
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      log({ level: "info", message: "stopping: no new requests" });
      ready = false;
      const steps: [string, () => Promise<void> | void][] = [
        ["page and API closed", () => gateway?.close()],
        ["sessions closed", () => runtime?.close()],
        ["workspace client closed", () => host?.close()],
      ];
      for (const [done, step] of steps) {
        try {
          await Promise.race([Promise.resolve(step()), new Promise<void>((resolve) => setTimeout(resolve, STOP_LIMIT_MS).unref())]);
          log({ level: "info", message: done });
        } catch (error) {
          log({ level: "error", message: `failed while closing (${done})`, error: String(error) });
        }
      }
      log({ level: "info", message: "stopped" });
    })();
    return stopping;
  }

  return {
    start,
    stop,
    startup: () => startupLines,
    get runtime() {
      return runtime;
    },
  };
}

function describe(report: StartupReport, env: AppEnvironment, expectedPlugins: number, backendLines: StartupLine[]): StartupLine[] {
  const info = (text: string): StartupLine => ({ level: "info", text });
  const warn = (text: string): StartupLine => ({ level: "warn", text });
  const lines = [info(`page and API listening on ${report.listening.host}:${report.listening.port}${env.token ? " (bearer token required)" : ""}`)];
  lines.push(
    report.keyPresent ? info(`model: ${env.model.name} at ${env.model.baseUrl} (key present)`) : warn(`no ${MODEL_KEY_VARIABLE}: sessions cannot call a model`),
  );
  lines.push(info(`plugins loaded: ${report.plugins.loaded.join(", ") || "none"} (${report.plugins.loaded.length} of ${expectedPlugins})`));
  for (const skipped of report.plugins.skipped) lines.push(warn(`plugin ${skipped.name} not loaded: ${skipped.reason.split("\n")[0]}`));
  lines.push(info(`profiles: ${report.profiles.join(", ")}`));
  lines.push(report.deskReachable ? info("desk-daemon: reachable") : warn("desk-daemon: not reachable yet (sessions cannot get a desktop until it answers)"));
  lines.push(...backendLines);
  lines.push(info("live view and take-over: through the desk-daemon (the desktop over VNC)"));
  lines.push(
    report.failedToResume.length > 0
      ? warn(`sessions resumed: ${report.resumed.length}, failed to resume: ${report.failedToResume.map((f) => f.id).join(", ")}`)
      : info(`sessions resumed: ${report.resumed.length}`),
  );
  return lines;
}
