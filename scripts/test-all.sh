#!/bin/sh
# Every test layer, one after another, with one summary (docs/21). Run from the repository folder with the box image built
# and the box running (`docker compose -f image/compose.yaml up -d`). Results: .test-results/<layer>.log and summary.txt.
#   1 host     npm run check                     boundaries, types, lint, format, unit and module tests
#   2 page     the page in a real Chromium       in a throwaway container from the image (fakes behind the gateway)
#   3 box      npm run test:e2e                  the container itself: processes, isolation, kill, memory, screenshots
#   4 journey  npm run journey                   login, take-over, password, Chinese, hand-back in the running box
#   5 capable  npm run capabilities              the real model on the real internet in the running box
set -u
cd "$(dirname "$0")/.."
OUT=.test-results
mkdir -p "$OUT"
: > "$OUT/summary.txt"
layer() {
  name=$1; shift
  start=$(date +%s)
  if "$@" > "$OUT/$name.log" 2>&1; then result=pass; else result=FAIL; fi
  line="$(date '+%H:%M') $result $name ($(( $(date +%s) - start )) s): $(grep -E 'Tests |scenarios passed|journey passed|FAIL ' "$OUT/$name.log" | tail -1)"
  echo "$line" | tee -a "$OUT/summary.txt"
}
page() {
  printf 'set -e\ncd /opt/ogb\nln -sfn /usr/local/lib/node_modules/playwright/node_modules/playwright-core node_modules/playwright-core\ncp /src/vitest.web.config.ts . ; cp -r /src/test/web/. test/web/ ; cp -r /src/packages/web/src/. packages/web/src/ ; cp -r /src/packages/gateway/src/. packages/gateway/src/\ntimeout 900 npx vitest run --config vitest.web.config.ts test/web/page.e2e.ts 2>&1\n' > "$OUT/page.sh"
  docker run --rm --name ogb-webtest --memory 4g --memory-swap 4g --shm-size 1g --entrypoint sh -v "$PWD:/src:ro" -v "$PWD/$OUT/page.sh:/page.sh:ro" ogb-box:dev /page.sh
}
layer host npm run check
layer page page
layer box npm run test:e2e
docker cp test/journey ogb-box:/opt/ogb/test/ >/dev/null 2>&1; docker cp test/capabilities ogb-box:/opt/ogb/test/ >/dev/null 2>&1
layer journey npm run journey
layer capable npm run capabilities
echo "done $(date '+%H:%M')" >> "$OUT/summary.txt"
