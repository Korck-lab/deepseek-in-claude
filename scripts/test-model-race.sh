#!/usr/bin/env bash
# Regression test for the DeepSeek model-list cache race.
#
# deepseekModelList() checks a TTL and then, on a miss, does a network round
# trip before writing the cache. Without an in-flight guard every concurrent
# caller sees the empty cache, fetches, and clobbers the shared deepseekIds /
# displayToReal maps in completion order. Claude Code opens several /v1/models
# requests at once, so this is the ordinary startup path.
#
# The test stands a counting stub in front of the proxy in place of DeepSeek,
# fires N concurrent /v1/models, and asserts the burst caused at most one
# upstream fetch.
#
# Usage: scripts/test-model-race.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
WORK="$(mktemp -d)"
STUB_PORT="${STUB_PORT:-8090}"
PROXY_PORT="${PROXY_PORT:-8091}"
N="${N:-10}"
# Long enough that the burst lands while the first fetch is still open.
STUB_DELAY="${STUB_DELAY:-3000}"

STUB_PID=""
PROXY_PID=""
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

cat > "$WORK/stub.mjs" <<'STUB'
import http from "node:http";
let count = 0;
const DELAY = Number(process.env.STUB_DELAY ?? 3000);
http.createServer((req, res) => {
  if (req.url === "/__count") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count }));
    return;
  }
  if (req.url.startsWith("/models")) {
    count++;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash", created: 1 }] }));
    }, DELAY);
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
STUB

STUB_DELAY=$STUB_DELAY STUB_PORT=$STUB_PORT node "$WORK/stub.mjs" &
STUB_PID=$!
sleep 1

# Run from a copy with an empty .env: the proxy resolves HERE from its own path,
# and the real checkout's .env carries a live key. Real env vars win over .env
# inside the proxy, so DEEPSEEK_BASE_URL is pinned on the command line too —
# a developer shell that exports it would otherwise point this at production.
cp "$REPO/proxy.mjs" "$WORK/proxy.mjs"
: > "$WORK/.env"
DEEPSEEK_API_KEY=sk-stub DEEPSEEK_BASE_URL="http://127.0.0.1:$STUB_PORT" \
  node "$WORK/proxy.mjs" --port "$PROXY_PORT" --no-auth-bridge >"$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
sleep 1

# Startup calls refreshDeepseekIds() once, so count from there rather than zero.
BASE="$(curl -s "http://127.0.0.1:$STUB_PORT/__count" | tr -dc '0-9')"

CURLS=""
i=0
while [ "$i" -lt "$N" ]; do
  curl -s -m 20 -o /dev/null "http://127.0.0.1:$PROXY_PORT/v1/models" &
  CURLS="$CURLS $!"
  i=$((i + 1))
done
# Wait on the clients only — a bare `wait` would also block on the two servers.
for p in $CURLS; do wait "$p"; done

AFTER="$(curl -s "http://127.0.0.1:$STUB_PORT/__count" | tr -dc '0-9')"
FETCHES=$((AFTER - BASE))

echo "concurrent /v1/models requests: $N"
echo "upstream model-list fetches:    $FETCHES"

if [ "$FETCHES" -le 1 ]; then
  echo "PASS: concurrent callers collapsed onto one fetch"
  exit 0
fi
echo "FAIL: $FETCHES duplicate fetches — the in-flight guard is not holding"
exit 1
