// The entry the image runs: `node /opt/ogb/packages/app/src/main.ts`. All logic is in app.ts; this file only connects it to the process.
import { createApp } from "./app.ts";

const write = (line: string) => process.stdout.write(`${line}\n`);
const app = createApp({ env: process.env, write });

async function main(): Promise<void> {
  try {
    await app.start();
  } catch (error) {
    write(
      JSON.stringify({
        at: new Date().toISOString(),
        level: "error",
        module: "app",
        message: "cannot start",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await app.stop().catch(() => {});
    process.exit(1);
  }
  let signalled = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (signalled) return;
      signalled = true;
      void app.stop().then(() => process.exit(0));
    });
  }
  process.on("unhandledRejection", (reason) =>
    write(JSON.stringify({ at: new Date().toISOString(), level: "error", module: "app", message: "unhandled rejection", error: String(reason) })),
  );
}

void main();
