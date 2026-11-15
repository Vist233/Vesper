import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSessionStore, type SessionStore } from "../store.ts";

/** A store in a fresh temporary directory, with a counter for ids and a fixed clock; `cleanup` removes it. */
export function createTempSessionStore(): { store: SessionStore; root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "ogb-store-"));
  let counter = 0;
  let time = 1_000;
  const store = createFileSessionStore({ root, now: () => time++, newId: () => `s_test${++counter}` });
  return { store, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
