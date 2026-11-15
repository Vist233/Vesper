# image/: the box

One Ubuntu 24.04 container for version 1 (docs/06, docs/07 section 3).

```
docker build -f image/Dockerfile -t ogb-box:dev .       # context is the repository root; runs `npm run check` inside (decision D-N-1)
docker compose -f image/compose.yaml up -d              # container ogb-box, volume ogb-data, network ogb-net, 127.0.0.1 only
npm run test:e2e                                        # container tests (need the image); see test/e2e/README.md
```

| Part | What |
|---|---|
| `Dockerfile` | Ubuntu 24.04, Node 26 (official tarball, checksum verified), s6-overlay (checksum verified), Xvfb, openbox, x11vnc, fonts, dbus libraries, Playwright's Chromium (`/usr/local/bin/ogb-chromium`), the owner's browser tool (with the one `agent-browser` it pins, 0.41.1), the repository under `/opt/ogb`. Architecture neutral: `dpkg --print-architecture` picks the Node and s6 builds, so the same file builds amd64 (the target) and arm64 (the developer's Mac). |
| `rootfs/etc/s6-overlay/s6-rc.d/` | two longrun services: `desk-daemon` (the real daemon, SIGTERM then 20 s before SIGKILL) and `runtime` (`packages/app`: the composition root that serves the page and the API on port 8787; the key `COMMANDCODE_API_KEY` is removed from the desk-daemon's environment) |
| `healthcheck.mjs` | asks the daemon for the health of a workspace that does not exist; healthy when it answers `ok` |
| `compose.yaml` | 4 CPUs, 8 GB (swap off), 1 GB `/dev/shm`, named volume `ogb-data` at `/data`, ports on 127.0.0.1 only, `restart: unless-stopped`, `no-new-privileges` |
| `vendor/` | the owner's desktop and monitor tools, with their origin in `vendor/ORIGIN.md` and hashes in `vendor/SHA256SUMS` |

The container runs as root (Chromium needs `--no-sandbox` there; the container is the boundary). The image builds from `vendor/*.tgz` of the repository (git-ignored tarballs that the lock file points to), so those must exist locally to build.
