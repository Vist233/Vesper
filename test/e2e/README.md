# test/e2e: container-level tests

Need Docker and the image (`docker build -f image/Dockerfile -t ogb-box:dev .`). Run with `npm run test:e2e` (one file at a time).

Rules the tests keep: every container is named `ogb-e2e-*` and every volume `ogb-e2e-vol-*`; they are removed by exact name when a test file ends (`Box.remove`, which refuses any other name); nothing from the host is mounted; no privileged mode; no published ports (the tests talk to the box with `docker exec`).

| File                | Proves                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basics.e2e.ts`     | Node 26, s6 as init with both services up, the programs exist, the health check turns healthy, only loopback listeners, the compose file says what the docs say |
| `screenshot.e2e.ts` | a fixture page is captured through CDP, is drawn on the workspace's X display (headed), openbox runs                                                            |
| `isolation.e2e.ts`  | two workspaces: separate displays, profiles, DevTools ports, cookies, pages; ports not reachable from the host; destroy of one leaves the other                 |
| `kill.e2e.ts`       | SIGKILL of Chromium, openbox, Xvfb, the daemon, the daemon's s6 supervisor, and the whole container: it comes back, the login stored in the profile survives    |
| `memory.e2e.ts`     | memory with 0, 1, 2, 4, 6 workspaces; writes `results/memory-<arch>.json`                                                                                       |

`in-box/` holds the small scripts that are copied into the container and run there (a fixture website, a DevTools client, a protocol client).
