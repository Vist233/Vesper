import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";

function make(secrets: string[] = [], level?: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => void lines.push(line), secrets: () => secrets, now: () => Date.UTC(2026, 10, 12), ...(level ? { level } : {}) });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("structured logs", () => {
  it("writes one JSON object per line with at, level and module, and lets the caller's module win", () => {
    const { log, parsed } = make();
    log({ message: "hello" });
    log({ module: "session-runtime", level: "warn", message: "careful", seq: 7 });
    expect(parsed()).toEqual([
      { at: "2026-11-12T00:00:00.000Z", level: "info", module: "app", message: "hello" },
      { at: "2026-11-12T00:00:00.000Z", level: "warn", module: "session-runtime", message: "careful", seq: 7 },
    ]);
  });

  it("adds the workspace of a session, and leaves it out when the session id does not map to one", () => {
    const { log, parsed } = make();
    log({ module: "session-runtime", session: "s_ab12", message: "x" });
    log({ session: "S.weird id", message: "y" });
    expect(parsed()[0]).toMatchObject({ session: "s_ab12", workspace: "s-ab12" });
    expect(parsed()[1]?.workspace).toBeUndefined();
  });

  it("never writes a secret, whatever field holds it, including inside errors and nested values", () => {
    const secret = ["cc", "secret", "key", "0123456789"].join("-"); // built at run time: no key-looking text sits in this file
    const { log, lines } = make([secret, "short"]);
    log({ message: `key is ${secret}` });
    log({ error: new Error(`failed with ${secret}`), nested: { deep: [{ value: `Bearer ${secret}` }] } });
    log({ message: "short is below the length that is redacted" });
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines[0]).toContain("[redacted]");
    expect(lines[2]).toContain("short");
  });

  it("covers a secret that appears after the logger was made", () => {
    const secrets: string[] = [];
    const lines: string[] = [];
    const log = createLogger({ write: (l) => void lines.push(l), secrets: () => secrets });
    log({ message: "late-secret-value-123" });
    secrets.push("late-secret-value-123");
    log({ message: "late-secret-value-123" });
    expect(lines[0]).toContain("late-secret-value-123");
    expect(lines[1]).not.toContain("late-secret-value-123");
  });

  it("honours the level, and survives a value that cannot be written as JSON", () => {
    const { log, lines } = make([], "warn");
    log({ level: "info", message: "quiet" });
    log({ level: "debug", message: "quieter" });
    log({ level: "error", message: "loud" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log({ level: "warn", circular });
    log({ level: "bogus", message: "an unknown level counts as info, which is below warn" });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).message).toBe("loud");
    expect(JSON.parse(lines[1] as string).message).toBe("a log entry could not be written");
  });
});
