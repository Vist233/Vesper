import type { WaitLimits } from "./waits.ts";
import type { SecretResolver, WorkspaceHandle } from "@vesper/contracts";
import type { EventJournal } from "@vesper/event-journal";
import type { ModelRegistry } from "@vesper/model-registry";
import type { PluginHost } from "@vesper/plugin-host";
import type { ProfileConfig, SafetyPlugin } from "@vesper/profiles";
import type { RouterOptions } from "@vesper/router";
import type { SessionStore } from "@vesper/session-store";
import type { Agent, AgentConfig, LlmClient, Plugin } from "sakura-agent";

export interface WorkspaceInfo extends WorkspaceHandle {
  readonly hasDisplay: boolean;
  readonly hasBrowser: boolean;
  /** X11 display name and the browser's DevTools endpoint, when the host has them (tools of the browser and computer plugins use them). */
  readonly display?: string;
  readonly cdpUrl?: string;
  /** The whole environment of a command run for this workspace (`workspaceEnvironment`): the agent's own shell gets exactly this. */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * What the runtime needs from the workspace layer: a handle for a session, made idempotently, and its removal.
 * `workspace-client` adapts the desk-daemon to this; tests use a fake. Asking again for a live workspace is harmless.
 */
export interface WorkspaceProvider {
  ensure(sessionId: string): Promise<WorkspaceInfo>;
  destroy(sessionId: string): Promise<void>;
}

/** One structured log line; the runtime adds `module` and `session`. */
export type LogSink = (entry: Record<string, unknown>) => void;

export interface SessionRuntimeDeps {
  store: SessionStore;
  models: ModelRegistry;
  profiles: ProfileConfig;
  pluginHost: PluginHost;
  workspaces: WorkspaceProvider;
  secrets: SecretResolver;
  /** One journal per session, made by the runtime from the store's paths unless a factory is given (tests). */
  journalFor?: (directory: string) => EventJournal;
  /** Builds the framework plugins for the safety floor of a session. Defaults to the framework's review and redaction plugins. */
  safetyPlugins?: (floor: readonly SafetyPlugin[], llm: LlmClient) => Plugin[];
  /** Defaults to the framework's `createAgent`; a test can wrap it to see what the runtime passed. */
  createAgent?: (config: AgentConfig) => Promise<Agent>;
  routerOptions?: RouterOptions;
  /** Sub-agent settings handed to the framework (default: on, with the framework's defaults). `false` turns them off. */
  subAgents?: AgentConfig["subAgents"] | false;
  /** Write a one-line summary of the person's task after each run (one small model call). The app turns it on; default off. */
  summaries?: boolean;
  /** How often the scheduler looks for due jobs (default 60 s; tests shorten it). */
  scheduleIntervalMs?: number;
  /** Limits of one run of the main agent. Defaults: 40 model replies and 900 seconds. */
  limits?: { turnsPerRun?: number; tokensPerRun?: number; runSeconds?: number };
  /** Optional limits on waiting for the person. Unset: wait for ever. */
  waits?: WaitLimits;
  /** Runs a function later; returns its canceller. Default: an unref'd timer. Tests inject one so the waits need no real time. */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  log?: LogSink;
}

export interface SessionInfo {
  id: string;
  /** The bot's name. */
  title: string;
  status: "active" | "archived";
  createdAt: number;
  /** The bot's avatar (a preset star id), when the person chose one. */
  star?: string;
  /** One line about the person's task, written after each run. */
  summary?: string;
  /** The `when` of the bot's next scheduled job, when it has one. */
  next?: string;
}

export interface SessionStatus {
  run: "idle" | "starting" | "active";
  /** After Stop, until the user writes again. */
  held: boolean;
  /** Signals waiting to be delivered. */
  queued: number;
  /** Things waiting for the person: questions without an answer and approvals without a decision. */
  pending: number;
  /** The `reason` of the last `run.finished` (`end`, `pause`, `error`, ...), or null before any run ended. */
  lastRunEnd: string | null;
}
