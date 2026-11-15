import type { SignalDraft } from "./signals.ts";

/** Tools, plugins and models ask for secrets by reference; the value exists only at the moment of use. */
export interface SecretResolver {
  /** Rejects with `not_found`, `denied` or `unavailable`; the error text names the reference, never a value. */
  resolve(reference: string): Promise<string>;
}

/** Where a plugin's event sources put what they notice (a mail arrived). The router decides what happens next. */
export interface SignalSink {
  /** `sessionTarget` is a session id, or `self` for the session that owns this plugin instance. */
  emit(sessionTarget: string, draft: SignalDraft): void | Promise<void>;
}

export interface PluginLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RunOptions {
  /** The command is killed after this long (default 30000 ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Text written to the command's standard input. */
  stdin?: string;
  /**
   * Extra environment variables for this one command (for example a worker's `BROWSER_TOOL_CDP`). The environment is otherwise
   * exactly the workspace's own (see `WorkspaceHandle.run`); the protected names cannot be set.
   */
  env?: Record<string, string>;
  /** Output beyond this many bytes per stream is dropped and `truncated` is set (default 1 MiB). */
  maxOutputBytes?: number;
}

export interface RunResult {
  /** Null when the command was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * One workspace as a tool sees it. A tool is built with exactly one handle and has no way to name another workspace
 * (isolation by construction, docs/07 section 5). Later tasks (desk-daemon, workspace-client) add what a handle can
 * do; this is the part every plugin may rely on.
 */
export interface WorkspaceHandle {
  readonly workspaceId: string;
  /** Directory of the agent's files inside the box. */
  readonly filesDir: string;
  /** X11 display of this workspace (for example `:101`), when it has one. */
  readonly display?: string;
  /** DevTools endpoint of this workspace's browser, when it has one. */
  readonly cdpUrl?: string;
  /**
   * Runs a program (an argument list, no shell) for this workspace and waits for it. In version 1 the runtime and the
   * desk-daemon share one container, so this is a local child process in the files directory with the workspace's `DISPLAY`
   * and DevTools address and NO other inherited environment: the keys, tokens and paths of the runtime never reach it.
   * The interface is the same when a later multi-user version runs the command in a microVM through a tool channel.
   */
  run(command: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** What a helper agent is asked to do. The tools are the framework's `Tool` objects (typed loosely here because contracts imports nothing). */
export interface HelperSpec {
  /** The helper's instructions (its system prompt). */
  instructions: string;
  /** The one task, with everything the helper needs. */
  task: string;
  tools: readonly unknown[];
  /** The helper stops after this many model turns (default 30). */
  maxTurns?: number;
  signal?: AbortSignal;
}

/**
 * Runs a short-lived helper agent on the session's model, in the session's files directory, under the session's safety
 * floor (review and redaction). Its conversation stays inside the helper: only the final text comes back, so a
 * tool that produces a lot (screenshots) does not fill the main agent's context.
 */
export interface HelperRunner {
  run(spec: HelperSpec): Promise<{ reason: "done" | "cancelled" | "paused" | "error"; text: string }>;
}

/** The only thing a plugin receives from the runtime (docs/08 section 2, rule 1). */
export interface PluginContext {
  workspace: WorkspaceHandle;
  secrets: SecretResolver;
  signals: SignalSink;
  /** A directory the plugin may write; survives restarts, private to this plugin and this session. */
  dataDir: string;
  /** A directory the plugin may write that all sessions of the box share (a store for what agents hand to each other). Private to this plugin. */
  sharedDataDir: string;
  log: PluginLogger;
  helpers: HelperRunner;
}
