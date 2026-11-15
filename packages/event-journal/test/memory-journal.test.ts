import { createMemoryJournal, journalContract } from "../src/testing/index.ts";

journalContract("memory fake", async () => {
  const journal = createMemoryJournal();
  return { journal, failNextAppend: () => journal.failNextAppends(1), cleanup: async () => {} };
});
