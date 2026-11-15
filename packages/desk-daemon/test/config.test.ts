import { describe, expect, it } from "vitest";
import { defaultConfig, parseViewFilter } from "../src/config.ts";

describe("view filter setting", () => {
  it("is on by default and by an empty value", () => {
    expect(defaultConfig({ dataDir: "/d", socketPath: "/s" }).viewFilter).toBe("on");
    expect(parseViewFilter(undefined)).toBe("on");
    expect(parseViewFilter("")).toBe("on");
  });

  it("accepts on and off, and refuses anything else instead of switching the filter off by accident", () => {
    expect(parseViewFilter("on")).toBe("on");
    expect(parseViewFilter("off")).toBe("off");
    expect(() => parseViewFilter("false")).toThrow(/on' or 'off/);
  });
});
