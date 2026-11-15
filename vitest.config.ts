import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    include: ["packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: { include: ["packages/*/src/**", "plugins/*/src/**"] },
  },
});
