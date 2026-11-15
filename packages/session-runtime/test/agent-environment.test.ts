import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceShell } from "../src/agent-environment.ts";
import { workspaceEnvironment } from "../src/run-command.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OGB_TEST_PARENT_SECRET;
});

describe("the agent's own shell", () => {
  it("runs every command with the workspace's environment only: its display, not the runtime's variables", async () => {
    const filesDir = mkdtempSync(join(tmpdir(), "ogb-shell-"));
    dirs.push(filesDir);
    process.env.OGB_TEST_PARENT_SECRET = "parent-secret-value";
    const shell = workspaceShell(filesDir, workspaceEnvironment({ workspaceId: "w1", filesDir, display: ":111", appDataDir: "/shared" }));
    const result = await shell.exec(`echo "$DISPLAY|$HOME|$XDG_CONFIG_HOME|\${OGB_TEST_PARENT_SECRET:-none}|$(pwd)" && echo 'it''s quoted'`, {});
    expect(result.output).toContain(`:111|${filesDir}|/shared/config|none|`);
    expect(result.output).toContain("its quoted");
    expect(result.output).not.toContain("parent-secret-value");
    const started = shell.spawn("echo $OGB_WORKSPACE_ID", {});
    expect((await started.wait()).output.trim()).toBe("w1");
    await shell.dispose();
  });
});
