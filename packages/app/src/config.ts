import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OgbError } from "@vesper/contracts";
import { type ModelConfig, parseModelConfig } from "@vesper/model-registry";
import { type ProfileConfig, parseProfileConfig } from "@vesper/profiles";
import type { SessionRuntimeDeps } from "@vesper/session-runtime";
import { type AppEnvironment, MODEL_KEY_VARIABLE } from "./environment.ts";

/** The name the default model has in the registry and in the default profiles. */
export const DEFAULT_MODEL_NAME = "main";
/** Most tokens the default model may write in one reply. One constant, to be settled by the lead's check of the real model (D8). */
export const DEFAULT_MAX_TOKENS = 8192;
/** Declared to the model in every session of the built-in profiles: it must be able to ask, to speak and to use the browser without searching first (D5). */
export const ALWAYS_DECLARED_TOOLS = ["ask_human", "send_to_user", "browser", "desktop", "schedule", "remember_person"] as const;
/** First-party plugins, in the order the profiles list them. Installed from `<appRoot>/plugins/<name>`. */
export const FIRST_PARTY_PLUGINS = ["handoff", "browser", "computer", "mail-sim"] as const;

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new OgbError("invalid_input", `${path} is not valid JSON`, { cause });
  }
}

/**
 * `<dataDir>/config/models.json` if it exists, otherwise one model from the environment: the Command Code provider, key by
 * reference (`env:COMMANDCODE_API_KEY`), never the key itself.
 */
export function loadModelConfig(env: AppEnvironment): ModelConfig {
  const file = join(env.dataDir, "config", "models.json");
  const given = readJson(file);
  return parseModelConfig(
    given ?? {
      default: DEFAULT_MODEL_NAME,
      models: {
        [DEFAULT_MODEL_NAME]: {
          baseUrl: env.model.baseUrl,
          model: env.model.name,
          contextWindow: env.model.contextWindow,
          apiKey: `env:${MODEL_KEY_VARIABLE}`,
          // The default model is DeepSeek behind Command Code: its wire format. It reads images (checked 2026-11-15; the
          // earlier empty reply was a reply budget spent on reasoning), so desktop and browser screenshots reach it.
          compat: "deepseek",
          images: true,
          maxTokens: DEFAULT_MAX_TOKENS,
        },
      },
    },
  );
}

/**
 * `<dataDir>/config/profiles.json` if it exists, otherwise two profiles. The safety floor (review and redaction) is on in
 * both, and only this file can ever lower it: nothing the page sends is read for it (the profiles module).
 */
export function loadProfileConfig(env: AppEnvironment): ProfileConfig {
  const file = join(env.dataDir, "config", "profiles.json");
  return parseProfileConfig(
    readJson(file) ?? {
      default: "general",
      safetyFloor: { review: true, redaction: true },
      profiles: {
        general: {
          description: "Everyday work: files, the browser, the desktop, sharing results with other agents.",
          plugins: ["handoff", "browser", "computer"],
          model: DEFAULT_MODEL_NAME,
          alwaysDeclaredTools: [...ALWAYS_DECLARED_TOOLS],
        },
        "general-mail": {
          description: "The same, with the simulated mailbox and calendar (mail arrives as files; see plugins/mail-sim).",
          plugins: ["handoff", "browser", "computer", "mail-sim"],
          model: DEFAULT_MODEL_NAME,
          alwaysDeclaredTools: [...ALWAYS_DECLARED_TOOLS],
        },
      },
    },
  );
}

/** Every model a profile names must exist, and every plugin must be installable: a mistake is found at start, not when a session is created. */
export function checkReferences(models: ModelConfig, profiles: ProfileConfig, installed: readonly string[]): string[] {
  const problems: string[] = [];
  for (const [name, profile] of Object.entries(profiles.profiles)) {
    if (profile.model !== undefined && !(profile.model in models.models))
      problems.push(`profile '${name}' names the model '${profile.model}', which is not in the model config`);
    for (const plugin of [...profile.plugins, ...(profile.optionalPlugins ?? [])]) {
      if (!installed.includes(plugin)) problems.push(`profile '${name}' needs the plugin '${plugin}', which is not installed`);
    }
  }
  return problems;
}

/** Drops the profiles that need a plugin which is not installed; the default moves to the first profile left (or none). */
export function withoutUnusableProfiles(profiles: ProfileConfig, installed: readonly string[]): ProfileConfig {
  const usable = Object.fromEntries(Object.entries(profiles.profiles).filter(([, profile]) => profile.plugins.every((p) => installed.includes(p))));
  return { ...profiles, profiles: usable, default: usable[profiles.default] ? profiles.default : (Object.keys(usable)[0] ?? "") };
}

/**
 * `<dataDir>/config/mcp.json`: MCP servers every bot gets, `{ "servers": { "<name>": { "command": "...", "args": [...], "env": {...} } },
 * "expose": "direct" | "codemode" }`. No file, no servers. A server's tools are reviewed like every other tool.
 */
export function loadMcpConfig(env: AppEnvironment): SessionRuntimeDeps["mcp"] | undefined {
  const file = join(env.dataDir, "config", "mcp.json");
  const raw = readJson(file) as { servers?: unknown; expose?: unknown } | undefined;
  if (raw === undefined) return undefined;
  const servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  if (raw.servers === null || typeof raw.servers !== "object" || Array.isArray(raw.servers))
    throw new OgbError("invalid_input", `${file}: 'servers' must be an object`);
  for (const [name, value] of Object.entries(raw.servers as Record<string, unknown>)) {
    const server = value as { command?: unknown; args?: unknown; env?: unknown };
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name))
      throw new OgbError("invalid_input", `${file}: server name '${name}' must be short lower-case letters, digits, - or _`);
    if (typeof server?.command !== "string" || server.command === "") throw new OgbError("invalid_input", `${file}: server '${name}' needs a 'command'`);
    if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")))
      throw new OgbError("invalid_input", `${file}: server '${name}': 'args' must be a list of strings`);
    if (server.env !== undefined && (server.env === null || typeof server.env !== "object" || Object.values(server.env).some((v) => typeof v !== "string")))
      throw new OgbError("invalid_input", `${file}: server '${name}': 'env' must map names to strings`);
    servers[name] = {
      command: server.command,
      ...(server.args ? { args: server.args as string[] } : {}),
      ...(server.env ? { env: server.env as Record<string, string> } : {}),
    };
  }
  if (raw.expose !== undefined && raw.expose !== "direct" && raw.expose !== "codemode")
    throw new OgbError("invalid_input", `${file}: 'expose' must be "direct" or "codemode" ("search" would clash with the box's own tool search)`);
  return { servers, ...(raw.expose ? { expose: raw.expose as "direct" | "codemode" } : {}) };
}
