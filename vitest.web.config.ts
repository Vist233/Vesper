import { defineConfig } from "vitest/config";

// Browser tests of the page (real Chrome through playwright-core) and the demo server for looking at it by hand.
// Not part of `npm run check`: they need a browser on the machine.
export default defineConfig({
  test: {
    include: ["test/web/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    expect: { poll: { timeout: 5000 } }, // the page settles over network round trips, like Playwright's own waits
  },
});
