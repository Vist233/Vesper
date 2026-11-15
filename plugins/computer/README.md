# @vesper/plugin-computer

The workspace's desktop as one tool, `desktop`, for the agent itself and for its sub-agents (`delegate` passes every tool on).

- **Actions:** launch (start a program), tree (accessibility tree with refs), screenshot, click, drag, path (drawing by hand), set, type, key, scroll. They run one at a time.
- **Backends:** `src/fake-backend.ts` (in memory, a display named `fake:...`), `src/gui-kit-backend.ts` (the owner's desktop kit plus `xdotool` and ImageMagick on a real X display such as `:101`).
- **Prompt:** `prompt.md` (when to use the desktop, when to delegate, never `xdotool` from `bash`).
