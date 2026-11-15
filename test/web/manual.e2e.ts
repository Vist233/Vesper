import { it } from "vitest";
import { serveDemo } from "./serve.ts";

// Keeps the demo page up for looking at it by hand. Skipped unless OGB_MANUAL=1.
it.skipIf(!process.env.OGB_MANUAL)(
  "serves the demo page until stopped",
  async () => {
    await serveDemo(Number(process.env.PORT ?? 0));
    await new Promise(() => {});
  },
  2 ** 31 - 1,
);
