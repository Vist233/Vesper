import { describe, expect, it } from "vitest";
import { makeSandboxRoot, repoRoot, runScript, writeIn } from "./helpers.ts";

const personalPath = `${"/Us"}ers/someone/project/file.txt`;
const fakeKey = `sk-${"a1B2c3D4e5F6g7H8i9J0k1L2"}`;
const fakeSession = `local_${"09b03304-bb38-4746-b857-93147bbe8d45"}`;

describe("scan-secrets", () => {
  it("passes on the real repository's tracked files", () => {
    const result = runScript(repoRoot, "scan-secrets.mjs");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("flags a personal path and shows it", () => {
    const root = makeSandboxRoot();
    writeIn(root, "notes.md", `see ${personalPath}\n`);
    const result = runScript(root, "scan-secrets.mjs", [`${root}/notes.md`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("personal-path");
  });

  it("flags a key and a session id, and never prints the secret text", () => {
    const root = makeSandboxRoot();
    writeIn(root, "a.ts", `const k = "${fakeKey}";\nconst s = "${fakeSession}";\n`);
    const result = runScript(root, "scan-secrets.mjs", [`${root}/a.ts`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("api-key");
    expect(result.stderr).toContain("session-id");
    expect(result.stderr).not.toContain(fakeKey);
    expect(result.stderr).not.toContain("09b03304");
  });

  it("flags a private key block and an assigned secret", () => {
    const root = makeSandboxRoot();
    writeIn(root, "k.txt", `-----BEGIN ${"RSA PRIVATE"} KEY-----\npassword = "abcdefghijklmnopqrstuvwxyz0123"\n`);
    const result = runScript(root, "scan-secrets.mjs", [`${root}/k.txt`]);
    expect(result.stderr).toContain("private-key-block");
    expect(result.stderr).toContain("assigned-secret");
  });

  it("accepts neutral example paths and honours the allowlist", () => {
    const root = makeSandboxRoot();
    writeIn(root, "ok.md", "see /home/user/app and /Users/me/x/y\n");
    writeIn(root, "bad.md", `${personalPath}\n`);
    writeIn(root, "scripts/scan-allowlist.txt", "# the design doc quotes a path on purpose\nbad.md:personal-path\n");
    const result = runScript(root, "scan-secrets.mjs", [`${root}/ok.md`, `${root}/bad.md`]);
    expect(result.status).toBe(0);
  });
});
