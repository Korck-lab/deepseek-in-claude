#!/usr/bin/env bash
# Regression test for the DeepSeek -> Anthropic fallback double-response race.
#
# When DeepSeek answers with a FALLBACK_STATUS the proxy hands the client
# response to forwardToAnthropic without awaiting it, and the DeepSeek request
# is abandoned. Its 60s idle timer used to stay armed: when it fired,
# `upstream.destroy(new Error(...))` emitted an error on the abandoned request,
# and that handler tested only `res.headersSent` — so it destroyed the response
# the Anthropic leg was streaming, cutting the client off mid-answer.
#
# Reproducing it means having the abandoned timer fire while the other leg is
# still streaming, so the test runs the proxy with UPSTREAM_TIMEOUT_MS well
# below the time a streamed Anthropic answer takes, and asks for enough tokens
# to outlast it. A correct proxy disarms the timer at handoff and the stream
# completes; the pre-fix proxy cuts it short.
#
# The Anthropic leg is real, so this needs working Claude Code credentials and
# spends roughly 2.5k output tokens. It skips itself if the auth bridge cannot answer.
#
# Usage: scripts/test-fallback-race.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
WORK="$(mktemp -d)"
STUB_PORT="${STUB_PORT:-8093}"
PROXY_PORT="${PROXY_PORT:-8094}"
# Short enough that the abandoned leg's timer fires mid-stream, long enough that
# the Anthropic leg's own first byte comfortably beats it.
TIMEOUT_MS="${TIMEOUT_MS:-4000}"
MAX_TOKENS="${MAX_TOKENS:-2500}"

STUB_PID=""
PROXY_PID=""
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

cat > "$WORK/stub.mjs" <<'STUB'
// Stands in for DeepSeek's Anthropic-compatible endpoint. Answers 503 — a
// FALLBACK_STATUS — and then holds the socket open and silent, which is what
// leaves the abandoned request's idle timer free to fire later.
import http from "node:http";
http.createServer((req, res) => {
  if (req.url.startsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash", created: 1 }] }));
    return;
  }
  res.writeHead(503, { "content-type": "application/json", "content-length": "4096" });
  res.write('{"type":"error"');
}).listen(Number(process.env.STUB_PORT), "127.0.0.1");
STUB

STUB_PORT=$STUB_PORT node "$WORK/stub.mjs" &
STUB_PID=$!
sleep 1

# PROXY_SRC lets this be pointed at an older proxy.mjs to confirm the test still
# fails on the code it was written against.
cp "${PROXY_SRC:-$REPO/proxy.mjs}" "$WORK/proxy.mjs"
: > "$WORK/.env"
# --redir sends the Anthropic families to DeepSeek and implies --fallback, so a
# claude-haiku request hits the stub first and falls back to Anthropic.
DEEPSEEK_API_KEY=sk-stub DEEPSEEK_BASE_URL="http://127.0.0.1:$STUB_PORT" \
UPSTREAM_TIMEOUT_MS="$TIMEOUT_MS" \
  node "$WORK/proxy.mjs" --port "$PROXY_PORT" --redir >"$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
sleep 2

SENTINEL="$(sed -n 's/^sentinel:[[:space:]]*//p' "$REPO/config.yml" 2>/dev/null | head -n 1 | tr -d "\"'" | tr -d '[:space:]')"
SENTINEL="${SENTINEL:-local-deepseek-proxy}"

# Streamed, and long enough to outlive the abandoned leg's timer.
curl -s -N -m 120 -o "$WORK/out.sse" -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/v1/messages" \
  -H "authorization: Bearer $SENTINEL" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":$MAX_TOKENS,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Count slowly from 1 to 500, one number per line.\"}]}" \
  > "$WORK/code" 2>/dev/null
CODE="$(cat "$WORK/code")"

if [ "$CODE" = "401" ]; then
  echo "SKIP: the auth bridge could not authenticate (run \`claude\` and log in first)"
  exit 0
fi

BYTES=$(wc -c < "$WORK/out.sse" | tr -d ' ')
echo "status:           ${CODE:-<none>}"
echo "stream bytes:     $BYTES"
echo "message_stop:     $(grep -c 'message_stop' "$WORK/out.sse" || true)"

if grep -q "ERR_STREAM_WRITE_AFTER_END\|Cannot write after end\|ERR_HTTP_HEADERS_SENT" "$WORK/proxy.log"; then
  echo "FAIL: proxy logged a second write to a response another leg owns:"
  grep -m 3 "ERR_STREAM_WRITE_AFTER_END\|Cannot write after end\|ERR_HTTP_HEADERS_SENT" "$WORK/proxy.log"
  exit 1
fi

# A complete Anthropic SSE stream ends with message_stop. Missing it means the
# abandoned leg tore the response down partway through.
if ! grep -q "message_stop" "$WORK/out.sse"; then
  echo "FAIL: stream ended without message_stop — the abandoned leg cut it short"
  exit 1
fi

echo "PASS: the fallback stream completed with the abandoned leg's timer disarmed"
