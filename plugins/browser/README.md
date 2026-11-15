# browser (plugin)

One tool, `browser`, over a `BrowserBackend` port: `open`, `navigate`, `snapshot`, `read_text`, `click`, `type`, `press`, `scroll`, `screenshot`, `close`, `tabs`; `expectText` on actions that change the page. Inputs are checked with the rules of the owner's `sakura-browser-tool` (http/https only, no credentials in URLs, nothing that could pass as a command-line option, length limits).

- **Tab ownership:** a tab belongs to the agent that opened it. Agents are told apart by their conversation log, and a sub-agent has a log of its own, so a parent and its helpers share the workspace's browser (and its logins) but cannot use each other's tabs. Tested with a real sub-agent started by the framework's `delegate`.
- **Snapshots are bounded:** page text is cut at 6000 characters and at most 80 elements are listed, with the amount left out stated.
- **Effect:** `network`; never replayed after a crash. The review sees the action and its arguments through `tool_call`.
- **Backends:** `src/fake-backend.ts` is an in-memory browser (pages, links, a text field) used by the tests and as a demo: a workspace whose DevTools address starts with `fake:` gets it. **The real backend** (`src/worker-backend.ts`) drives the owner's `sakura-browser-worker` through `WorkspaceHandle.run` for a loopback DevTools address (`http://127.0.0.1:<port>`); its assumptions about `agent-browser`'s output are in two small parsing functions and it has not run against the real CLI (docs/decisions.md D-T7-8). Any other address gets a tool that says there is no backend for it.
- **Build:** `node scripts/build-plugins.mjs` makes `dist/tools.js` (generated, not committed).
