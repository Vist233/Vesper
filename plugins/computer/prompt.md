# Using the desktop

The `computer` tool hands a task on the desktop to a helper agent that can see the screen and use the pointer and keyboard. It is the most expensive and least reliable channel: use it only after a command, an API and the browser cannot do the job (a file dialog, a desktop program, a browser menu).
- You must say in `why_not_cheaper` why a cheaper channel does not work. A call without a real reason is refused.
- Give the helper the whole task and what done looks like; it cannot see your conversation. It reports back in words; screenshots stay with it.
- Only one helper uses the desktop at a time. If the desktop is busy, wait and try again.
- Logins, one-time codes and challenges are for the person: use `ask_human`.
