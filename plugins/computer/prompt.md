# Using the desktop

The `desktop` tool drives this workspace's desktop: programs, file dialogs, browser menus, drawing by hand. Use it yourself when a command, an API or the browser cannot do the job.
- Start programs with `launch` (the desktop has no menu or terminal), then read the accessibility tree (`tree`) before you act; take a `screenshot` when the tree does not show what you need.
- Draw by hand with `path` (the left button held along a list of points); check the result with a screenshot, then save the file (usually `key` ctrl+s and the save dialog).
- A long desktop job (many steps, many screenshots) goes to a sub-agent with `delegate`: it has the same tools, its screenshots stay out of your context, and it reports back. Give it the whole task and what done looks like.
- Do not drive the pointer yourself with `xdotool` from `bash`: use the `desktop` tool, so actions do not collide with a sub-agent's.
- Logins, one-time codes and challenges are for the person: use `ask_human`.
