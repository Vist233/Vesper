import { defineConfig } from "vitest/config";

// Container-level tests. They need Docker and the image `ogb-box:dev` (docker build -f image/Dockerfile -t ogb-box:dev .).
// One file at a time: each file starts its own containers and the machine's memory is the thing some of them measure.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
