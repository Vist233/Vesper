import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBackends } from "../src/backends.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checkBackends", () => {
  it("finds the browser worker on the search path it is given, in any of its directories, and only a file counts", () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-be-"));
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(join(first, "sakura-browser-worker"), { recursive: true }); // a directory of that name is not the program
    mkdirSync(second);
    dirs.push(root);
    expect(checkBackends(root, { searchPath: first }).worker).toBe(false);
    writeFileSync(join(second, "sakura-browser-worker"), "");
    const report = checkBackends(root, { searchPath: `${first}::${second}` });
    expect(report.worker).toBe(true);
    expect(report.lines[0]).toEqual({ level: "info", text: "browser tool: sakura-browser-worker found" });
  });

  it("says when neither program is there", () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-be-"));
    dirs.push(root);
    const report = checkBackends(root, { searchPath: "" });
    expect(report).toMatchObject({ worker: false, kit: false });
    expect(report.lines.every((line) => line.level === "warn")).toBe(true);
    expect(report.lines).toHaveLength(2); // no accessibility-bus line: the kit is not used
    expect(report.lines[0]?.text).toContain("sakura-browser-worker is not installed");
    expect(report.lines[1]?.text).toContain("desktop kit is missing");
  });

  it("finds the desktop kit where the image keeps it", () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-be-"));
    dirs.push(root);
    const tools = join(root, "image", "vendor", "sandbox-tools", "desktop", "refagent-tools", "tools");
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, "observe.py"), "");
    chmodSync(join(tools, "observe.py"), 0o644);
    const report = checkBackends(root, { searchPath: "" });
    expect(report.kit).toBe(true);
    expect(report.lines[1]).toEqual({ level: "info", text: "desktop tool: the desktop kit is present" });
    expect(report.lines[2]).toMatchObject({ level: "info" });
    expect(report.lines[2]?.text).toContain("desktop accessibility bus: not started");
  });
});
