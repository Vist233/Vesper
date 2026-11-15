# T6 status (gateway and web), paused 2026-11-11

## Done and tested (committed)
- **gateway** (33af52d): API, SSE with Last-Event-ID, one-time-ticket WebSocket relay (browser view, take-over), static files, Host/Origin/bearer checks. 104 tests; 98.54 % lines, 93.62 % branches. Also run over the real session-runtime.
- **web** (7d9e102): page, pure model, SSE parser, client. Model, parser, client and source-grep tests run in `npm test` (35 tests). Looked at by hand in a browser.
- Docs: `packages/gateway/README.md`, `packages/web/README.md`, decisions D-T6-1..16, test report, open questions 10-16.

## `npm run check`
Green: 693 tests (checked after the last commit). `package-lock.json` has an uncommitted change that is not from T6 work (no install was run by me).

## Written but never run
- `test/web/page.e2e.ts.pending` (15 browser tests; rename to `page.e2e.ts` when playwright-core is installed, otherwise typecheck fails), because it needs `playwright-core` (not approved; the sandbox refused a scratch install). Lead approved in principle (pin exact version, record in decisions) and noVNC vendoring (pinned, licence, VENDORED.md with hash) for when work resumes; not now (owner paused). Step 2 is committed as a green WIP.
- `app.js` and `render.js` have only had a manual look.

## Remaining
1. Lead's decision on `playwright-core@1.65.0` (devDependency, uses installed Chrome), then run the e2e tests, fix findings, measure the 2000-event case.
2. Decision on vendoring noVNC (open question 15); without it take-over shows no desktop.
3. Open questions 10-14 and 16: journal `return()` blocks while idle (event-journal), agent-browser stream port per workspace, view-only desktop, container listen address and token, sub-agent nesting in the journal.

## Resume
```
cd vesper && npm run check
npm i -D playwright-core@1.65.0 --registry=https://registry.npmjs.org/ --min-release-age=0   # only after approval
npm run test:web                                    # browser tests (needs Chrome)
OGB_MANUAL=1 PORT=8099 npx vitest run --config vitest.web.config.ts test/web/manual.e2e.ts   # demo page at http://127.0.0.1:8099/#/s/s_demo
```
