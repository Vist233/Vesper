import { describe, expect, it } from "vitest";
import { chromiumArgs } from "../src/browser-proc.ts";

const options = { name: "w", display: ":100", profileDir: "/p", homeDir: "/h", cdpPort: 9300, runDir: "/r", screen: { width: 1280, height: 800 } };

describe("Chromium launch flags", () => {
  it("keeps the profile, DevTools on loopback and the basic password store", () => {
    const args = chromiumArgs(options, true);
    expect(args).toContain("--user-data-dir=/p");
    expect(args).toContain("--remote-debugging-port=9300");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--password-store=basic");
  });

  it("hides the two infobars that would sit in the live picture: the testing notice, and the --no-sandbox warning", () => {
    const root = chromiumArgs(options, true);
    expect(root).toContain("--disable-infobars");
    expect(root).toContain("--no-sandbox");
    expect(root).toContain("--test-type");
  });

  it("does not turn the sandbox off, or pretend to be a test, when it is not needed", () => {
    const user = chromiumArgs(options, false);
    expect(user).not.toContain("--no-sandbox");
    expect(user).not.toContain("--test-type");
  });
});
