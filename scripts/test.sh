#!/usr/bin/env bash
# Feature smoke tests — real Claude Code calls (claude -p) through the proxy,
# across configs. A mock DeepSeek upstream (echoing what the proxy actually
# sent) proves routing; everything else is real API traffic.
#
#   bash scripts/test.sh
#
# Needs: node >= 18, claude CLI, network, DEEPSEEK_API_KEY in .env.
# Real API calls are tiny ("Reply with exactly: OK") but cost a few cents.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="${CLAUDE:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
TMP="$(mktemp -d)"
MOCK_PORT=8801
MOCK="$TMP/mock-upstream.mjs"
PIDS=()
PASS=0
FAIL=0

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

check() { # check NAME CONDITION
  if eval "$2"; then PASS=$((PASS + 1)); echo "PASS  $1";
  else FAIL=$((FAIL + 1)); echo "FAIL  $1"; fi
}

start_proxy() { # start_proxy WAIT_PORT [node args...]
  local p="$1"; shift
  node "$ROOT/proxy.mjs" "$@" >/dev/null 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "http://localhost:$p/v1/models" 2>/dev/null && return 0
    sleep 0.2
  done
  return 1
}

cc() { # cc PORT [claude args...] -> stdout+stderr
  local p="$1"; shift
  local tmp; tmp="$(mktemp)"
  ( ANTHROPIC_BASE_URL="http://localhost:$p" "$CLAUDE" -p --output-format json "$@" >"$tmp" 2>&1 ) &
  local pid=$! i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; fi
  cat "$tmp"
  rm -f "$tmp"
}

ok() { grep -qE '"type":"result"|"is_error":false' <<<"$1"; }

# --- mock upstream: echoes model + effort the proxy actually sent -------------
cat >"$MOCK" <<'EOF'
import http from "node:http";
const PORT = Number(process.env.PORT ?? 8801);
const ev = (e, d) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let model = "?", effort = "?", advisor = false, future = false;
    try {
      const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      model = j.model ?? "?";
      effort = j.output_config?.effort ?? "?";
      advisor = Array.isArray(j.tools) && j.tools.some((t) => /^advisor_/.test(t.type ?? ""));
      future = Array.isArray(j.tools) && j.tools.some((t) => t.type === "web_search_20260401");
    } catch {}
    if (advisor) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Failed to deserialize the JSON body into the target type: tools[249]: unknown variant `advisor_20260301`, expected `web_search_20250305` or `web_search_20260209` at line 1 column 393737", type: "invalid_request_error", param: null, code: "invalid_request_error" } }));
      return;
    }
    if (future) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Failed to deserialize the JSON body into the target type: tools[0]: unknown variant `web_search_20260401`, expected `web_search_20250305` or `web_search_20260209` at line 1 column 100", type: "invalid_request_error", param: null, code: "invalid_request_error" } }));
      return;
    }
    const text = `ROUTED:${model} EFFORT:${effort}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      ev("message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 1, output_tokens: 1 } } })
      + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
      + ev("content_block_stop", { type: "content_block_stop", index: 0 })
      + ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
      + ev("message_stop", { type: "message_stop" })
    );
  });
}).listen(PORT);
EOF
node "$MOCK" &
PIDS+=("$!")
sleep 0.3

# ---------------------------------------------------------------------------
echo "==> deepseek-in-claude feature tests"
echo "    claude: $CLAUDE ($("$CLAUDE" --version 2>/dev/null | head -1))"

# T1 --help
H="$(node "$ROOT/proxy.mjs" --help)"
check "T1 --help lists flags" 'echo "$H" | grep -q -- "--port" && echo "$H" | grep -q -- "--redir" && echo "$H" | grep -q -- "--fallback"'

# T2/T3/T4 default config (port 8016)
if start_proxy 8016; then
  M="$(curl -s --max-time 15 http://localhost:8016/v1/models)"
  check "T2 /v1/models has deepseek ids" 'echo "$M" | grep -q "deepseek-v4-flash"'
  if echo "$M" | grep -q '"id":"claude'; then
    check "T2b /v1/models merged anthropic ids" 'true'
  else
    echo "SKIP T2b anthropic merge (upstream fetch unauthenticated)"
  fi

  CT="$(curl -s --max-time 5 -X POST http://localhost:8016/v1/messages/count_tokens -H "content-type: application/json" -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}')"
  check "T3 count_tokens local estimate" 'echo "$CT" | grep -q "input_tokens"'

  O="$(cc 8016 --model deepseek-v4-flash "Reply with exactly: OK")"
  check "T4 default config cc -p deepseek model" 'ok "$O"'
else
  echo "FAIL T2-T4 could not start proxy on 8016"
fi

# T5 --port flag
if start_proxy 8002 --port 8002; then
  O="$(cc 8002 --model deepseek-v4-flash "Reply with exactly: OK")"
  check "T5 --port flag cc -p" 'ok "$O"'
else
  echo "FAIL T5 could not start proxy on 8002"
fi

# T6 yml config (port + redir + fallback)
cat >"$TMP/test.yml" <<'EOF'
port: 8003
redir:
  sonnet: deepseek-v4-flash
fallback: true
EOF
if start_proxy 8003 --config "$TMP/test.yml"; then
  O="$(cc 8003 --model sonnet "Reply with exactly: OK")"
  check "T6 yml config cc -p sonnet -> deepseek" 'ok "$O"'
else
  echo "FAIL T6 could not start proxy with config"
fi

# T7 --redir routing proven by mock upstream echo
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8004 --port 8004 --redir; then
  O="$(cc 8004 --model sonnet "Reply with exactly: OK")"
  check "T7 redir sonnet rewritten to deepseek-v4-flash" 'echo "$O" | grep -q "ROUTED:deepseek-v4-flash"'

  EF="$(curl -s --max-time 5 -X POST http://localhost:8004/v1/messages -H "content-type: application/json" -d '{"model":"claude-sonnet-4-5","output_config":{"effort":"xhigh"},"messages":[{"role":"user","content":"x"}]}')"
  check "T7b effort xhigh passes through" 'echo "$EF" | grep -q "EFFORT:xhigh"'

  EFM="$(curl -s --max-time 5 -X POST http://localhost:8004/v1/messages -H "content-type: application/json" -d '{"model":"claude-sonnet-4-5","output_config":{"effort":"medium"},"messages":[{"role":"user","content":"x"}]}')"
  check "T7d effort medium passes through" 'echo "$EFM" | grep -q "EFFORT:medium"'

  FB="$(curl -s --max-time 5 -X POST http://localhost:8004/v1/messages -H "content-type: application/json" -d '{"model":"claude-fable-1","messages":[{"role":"user","content":"x"}]}')"
  check "T7c fable rewritten to deepseek-v4-pro" 'echo "$FB" | grep -q "ROUTED:deepseek-v4-pro"'
else
  echo "FAIL T7 could not start proxy with mock upstream"
fi

# T7e effort map override via config.yml
cat >"$TMP/effort.yml" <<'EOF'
port: 8007
effort:
  medium: low
EOF
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8007 --port 8007 --config "$TMP/effort.yml"; then
  EFM="$(curl -s --max-time 5 -X POST http://localhost:8007/v1/messages -H "content-type: application/json" -d '{"model":"deepseek-v4-flash","output_config":{"effort":"medium"},"messages":[{"role":"user","content":"x"}]}')"
  check "T7e effort override medium->low via config" 'echo "$EFM" | grep -q "EFFORT:low"'
else
  echo "FAIL T7e could not start proxy with effort config"
fi

# T10 advisor_ tool dropped before forwarding (mock 400 retry path)
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8008 --port 8008 --redir; then
  AD="$(curl -s --max-time 5 -X POST http://localhost:8008/v1/messages -H "content-type: application/json" -d '{"model":"claude-sonnet-4-5","tools":[{"type":"advisor_20260301","name":"advisor"}],"messages":[{"role":"user","content":"x"}]}')"
  check "T10 advisor tool dropped, request reaches mock" 'echo "$AD" | grep -q "ROUTED:"'
else
  echo "FAIL T10 could not start proxy on 8008"
fi

# T12 unknown-variant retry: non-advisor tool rejected by mock 400, proxy
# splices tools[N] from the error message and retries (runtime, not preflight)
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8009 --port 8009 --redir; then
  RT="$(curl -s --max-time 5 -X POST http://localhost:8009/v1/messages -H "content-type: application/json" -d '{"model":"claude-sonnet-4-5","tools":[{"type":"web_search_20260401","name":"web_search"}],"messages":[{"role":"user","content":"x"}]}')"
  check "T12 unknown variant spliced and retried" 'echo "$RT" | grep -q "ROUTED:"'
else
  echo "FAIL T12 could not start proxy on 8009"
fi

# T8 forward fallback: dead deepseek -> real anthropic
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:1" start_proxy 8005 --port 8005 --redir --fallback; then
  O="$(cc 8005 --model sonnet "Reply with exactly: OK")"
  check "T8 fallback deepseek-dead -> anthropic" 'ok "$O"'
else
  echo "FAIL T8 could not start proxy"
fi

# T9 reverse fallback: anthropic 404 -> real deepseek
if start_proxy 8006 --port 8006 --fallback; then
  O="$(cc 8006 --model claude-sonnet-4-5-fake "Reply with exactly: OK")"
  check "T9 fallback anthropic-404 -> deepseek" 'ok "$O"'
else
  echo "FAIL T9 could not start proxy"
fi

# T11 per-request usage log line (written after real proxy runs above)
check "T11 usage log written" 'test -s "$ROOT/logs/proxy-usage.jsonl" && grep -q "usage" "$ROOT/logs/proxy-usage.jsonl"'

# ---------------------------------------------------------------------------
echo ""
echo "==> results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
