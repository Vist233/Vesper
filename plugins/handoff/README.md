# handoff (plugin)

Agents on one box hand each other **checked work packages** (skills, datasets, patches, proofs) through one shared store, instead of sharing context. Built on the owner's `step-by-step-handoff-mcp` (library entry `./core`, version 0.3.0).

- **Tool:** one tool, `handoff`, with `action`: `search` (query with `type:` / `tag:` filters), `peek` (id, path), `pull` (id, verify), `publish` (a directory inside the agent's files, or an object of file names to contents). Found with `tool_search`; its effect is `exec` because `pull` with `verify` and `publish` run the package's own check (a command from another agent, with this process's rights), so every call goes through the review.
- **One store for all sessions:** `PluginContext.sharedDataDir` (`<data>/shared/handoff`). The agent's files directory and workspace id are passed per handle (pulls land in `<files>/.exchange/`, the author recorded is the workspace id).
- **Review before publishing:** `src/secret-scan.ts` refuses a package that holds a key, a token, a private key or a personal path, and names the file and rule (never the text). The check is the library's default (the command in `handoff.json`).
- **Prompt:** `prompt.md` is the tuned prompt of docs/08 section 5, word for word; it becomes a section of each session's `AGENTS.md` (`promptSection`). A test compares it to the expected text.
- **One adapter file:** `src/adapter.ts` is the only file that imports the library; `src/port.ts` is the interface the tool uses.
- **Build:** `node scripts/build-plugins.mjs` bundles `src/tools.ts` to `dist/tools.js` with the library inside (the plugin cache has no `node_modules`). `dist/` is generated and not committed; the tests build it.
- **Dependency:** until version 0.3.0 is published to npm, the dependency is a tarball made with `npm pack` in the handoff repository and placed in `vendor/` (git-ignored): `vendor/step-by-step-handoff-mcp-0.3.0.tgz`. After publishing, change the dependency in `package.json` to `^0.3.0`.
