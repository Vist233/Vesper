# Vendored tools: origin

`sandbox-tools/` is a **copy** of selected files from the owner's own toolkit `sandbox-tools` (a local directory of the owner, not a git repository and not published; copied on 2026-11-11, license: the owner's own work, MIT like this repository). Nothing was changed after copying. Only what the image needs was taken:

| Copied | Why |
|---|---|
| `desktop/refagent-tools/` (core: a11y, env, envelope, human, input, lease, refs, verify; tools: observe, act, check, envctl; ARCHITECTURE.md) | the desktop control tools (accessibility tree first, coordinates as a fallback) that the `computer` plugin will call |
| `desktop/bin/pointerd.py` | the resident human-like pointer service the `act` tool prefers |
| `desktop/README.md`, `desktop/docs/A11Y-FIRST-PRINCIPLES.md` | their documentation |
| `monitor/bin/deskview`, `monitor/bin/deskcommon.sh`, `monitor/README.md` | the MJPEG live view of a display (HTTP, no WebSocket); candidate for the desktop view of the gateway (T6) |

**Not copied, on purpose:** `monitor/bin/deskguard` (self-healing; the daemon supervises the processes itself, two supervisors would fight), `descrec`, `mediacheck.py`, `desktop/bin/dispatch.py`, `desktop/bin/video_check.py` (recording and video checks; not needed in version 1), `desktop/refagent-host/` (benchmark runs and a host-side driver), the whole `browser/` directory (site-specific uploaders and login helpers; the browser tool of this project is `agent-browser` over CDP), `skills/`, `docs/`.

**Needs in the image:** `python3`, `python3-pyatspi`, `at-spi2-core`, `python3-pil`, `xdotool`, `imagemagick`, `ffmpeg`, `x11vnc`. The README of the desktop tools warns not to inject `DBUS_SESSION_BUS_ADDRESS` into GTK applications; the image does not.

**Integrity:** `SHA256SUMS` lists the hash of every copied file as of the copy. Update the copy by running the same copy again from the owner's directory and replacing `SHA256SUMS`; do not edit files here.

## browser-tool

`browser-tool/sakura-browser-tool-0.2.0.tgz` is the owner's own package `sakura-browser-tool` 0.2.0 (the `sakura-browser-worker` command; owner decision 14), a local package of the owner that is not published to npm. Copied unchanged on 2026-11-12 (sha256 `d139e750220401b0f53251ddc51832fadf454163da724c693ed9a4f1350f1af8`, also in `SHA256SUMS`). It is installed in the image with `npm install -g` from this file (its shrinkwrap pins its own dependencies). Update by copying the new tarball from the owner's directory and replacing the hash line.

