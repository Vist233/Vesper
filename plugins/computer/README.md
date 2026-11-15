# computer (plugin)

The desktop, through a helper agent.

- **The main agent sees one tool, `computer`** (found with `tool_search`), with two required fields: `task` and `why_not_cheaper` (a real sentence of at least 20 characters saying why a command, an API or the browser cannot do it; without it the call is refused and no helper starts).
- **The helper:** `computer` starts a short-lived helper agent (`PluginContext.helpers.run`, on the session's model and under the session's review and redaction) that alone has the `desktop` tool: `tree` (accessibility tree with refs, first), `screenshot` (only when the tree is not enough), `click`, `set` (a value into a field directly), `type`, `key`, `scroll`. The helper's conversation, with its trees and screenshots, stays inside it; the main agent receives the helper's written report. Every desktop action is reviewed under its own name. Tested with the framework's real agent loop: the main agent's requests never contain the tree or the screenshot path.
- **Display lease:** one helper at a time per display; a second call while one works is refused with "try again later"; the lease is released when the helper ends, fails or stops early.
- **Effect:** `exec`; never replayed after a crash.
- **Backends:** `src/fake-backend.ts` (in memory, records actions; a display named `fake:...`). The real backend (`src/gui-kit-backend.ts`) runs the owner's gui kit (`observe.py`, `act.py`) and `xdotool` / `import` through `WorkspaceHandle.run` for an X display name like `:101`; it has not run against a real desktop (docs/decisions.md D-T7-9).
