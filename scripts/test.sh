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

HERE_SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE_SCRIPTS/.." && pwd)"
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
  # ADR-0006 — the suite must never bind 8016, the live pooled proxy's port.
  # A test proxy there either adopts the launcher's role (cleanup then kills
  # every session on it, including this one) or silently tests the live proxy.
  # Guard here: a start that names no --port and no --config relies on the
  # proxy's default, which is 8016 — refuse it loudly instead of dropping a
  # session. (--config is allowed: the config file names its own port.)
  if [ "$p" = "8016" ]; then
    echo "FAIL start_proxy: wait port 8016 is the live proxy's port (ADR-0006)" >&2
    return 1
  fi
  case " $* " in
    *" --port "*|*" --config "*) ;;
    *)
      echo "FAIL start_proxy: no --port or --config, proxy would bind its default 8016 (ADR-0006)" >&2
      return 1
      ;;
  esac
  node "$ROOT/proxy.mjs" "$@" >/dev/null 2>&1 &
  PIDS+=("$!")
  # Counted loop rather than `seq`, which is not POSIX and is absent on some
  # systems — its failure here would collapse the wait to zero attempts and
  # report every test as "could not start proxy".
  local i=0
  while [ "$i" -lt 60 ]; do
    curl -s -o /dev/null --max-time 2 "http://localhost:$p/v1/models" 2>/dev/null && return 0
    sleep 0.2
    i=$((i + 1))
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
    // OpenAI-shaped route for the local vision leg (ADR-0004: LM Studio). The
    // proxy translates Anthropic <-> OpenAI, so this mock answers with OpenAI
    // chat.completions SSE and the assertion reads the translated Anthropic SSE
    // the client receives. Echo the model the proxy sent (proof the rewrite
    // reached the leg) — a mock that never sees it also never reports it.
    if (req.url.includes("/v1/chat/completions")) {
      const seenModel = JSON.parse(Buffer.concat(chunks).toString("utf8")).model ?? "?";
      const oai = (d) => `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        oai({ role: "assistant", content: `LOCAL_VISION:${seenModel} ` })
        + oai({ content: "OK" })
        + `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
        + "data: [DONE]\n\n"
      );
      return;
    }
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

# --- pre-flight --------------------------------------------------------------
# Every one of these surfaces as a confusing test failure rather than as itself:
# a missing claude CLI reads as "the proxy is broken", and a missing key makes
# every DeepSeek route return an auth error that looks like a routing bug.
preflight_failed=0
need() { # need NAME COMMAND
  command -v "$2" >/dev/null 2>&1 || { echo "error: $1 not found ($2)" >&2; preflight_failed=1; }
}
need "Node.js >= 18" node
need "curl" curl
if ! command -v "$CLAUDE" >/dev/null 2>&1 && [ ! -x "$CLAUDE" ]; then
  echo "error: claude CLI not found at '$CLAUDE'. Set CLAUDE=/path/to/claude." >&2
  preflight_failed=1
fi
if ! grep -q '^DEEPSEEK_API_KEY=sk-' "$ROOT/.env" 2>/dev/null && [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "error: no DEEPSEEK_API_KEY — set it in $ROOT/.env or the environment." >&2
  preflight_failed=1
fi
if [ "$preflight_failed" -ne 0 ]; then
  echo "==> pre-flight failed; not running tests" >&2
  exit 1
fi

# --- unit and race suites ----------------------------------------------------
# Run first: they are fast, need no credentials, and a failure here explains any
# feature failure that follows. Kept as separate scripts because each stands up
# its own fixtures, but invoked from here so they cannot rot unnoticed — nobody
# runs a suite they have to know the name of.
echo "==> unit and race suites"
for suite in test-parsing test-model-race test-auth-bridge test-session-pool; do
  if bash "$HERE_SCRIPTS/$suite.sh" >"$TMP/$suite.out" 2>&1; then
    PASS=$((PASS + 1)); echo "PASS  $suite"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  $suite"; sed 's/^/      /' "$TMP/$suite.out" | tail -15
  fi
done

# The fallback race suite drives the real Anthropic leg — it needs working
# credentials and spends roughly 2.5k output tokens — so it is opt-in.
if [ "${RUN_SLOW_TESTS:-0}" = "1" ]; then
  if bash "$HERE_SCRIPTS/test-fallback-race.sh" >"$TMP/fallback.out" 2>&1; then
    PASS=$((PASS + 1)); echo "PASS  test-fallback-race"
  else
    FAIL=$((FAIL + 1)); echo "FAIL  test-fallback-race"; sed 's/^/      /' "$TMP/fallback.out" | tail -15
  fi
else
  echo "SKIP  test-fallback-race (RUN_SLOW_TESTS=1 to include; real API traffic)"
fi
echo ""

# ---------------------------------------------------------------------------
echo "==> deepseek-in-claude feature tests"
echo "    claude: $CLAUDE ($("$CLAUDE" --version 2>/dev/null | head -1))"

# T1 --help
H="$(node "$ROOT/proxy.mjs" --help)"
check "T1 --help lists flags" 'echo "$H" | grep -q -- "--port" && echo "$H" | grep -q -- "--redir" && echo "$H" | grep -q -- "--fallback" && echo "$H" | grep -q -- "--no-auth-bridge"'

# T2/T3/T4 default config. ADR-0006: the suite never binds 8016, the live
# pooled proxy's port — a test proxy there either adopts the launcher's role
# (and cleanup kills every session on it) or silently tests the live proxy.
# The default config is exercised on a scratch port instead.
if start_proxy 8015 --port 8015; then
  M="$(curl -s --max-time 15 http://localhost:8015/v1/models)"
  check "T2 /v1/models has deepseek ids" 'echo "$M" | grep -q "deepseek-v4-flash"'
  check "T2c display ids carry the [1m] window marker" 'echo "$M" | grep -q "claude-deepseek-v4-flash\[1m\]"'
  # Must not match the `claude-deepseek-*` display ids — look for a real one.
  if echo "$M" | grep -qE '"id":"claude-(opus|sonnet|haiku|fable)'; then
    check "T2b /v1/models merged anthropic ids" 'true'
  else
    echo "SKIP T2b anthropic merge (upstream fetch unauthenticated)"
  fi

  CT="$(curl -s --max-time 5 -X POST http://localhost:8015/v1/messages/count_tokens -H "content-type: application/json" -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}')"
  check "T3 count_tokens local estimate" 'echo "$CT" | grep -q "input_tokens"'

  O="$(cc 8015 --model deepseek-v4-flash "Reply with exactly: OK")"
  check "T4 default config cc -p deepseek model" 'ok "$O"'
else
  echo "FAIL T2-T4 could not start proxy on 8015"
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

  W1="$(curl -s --max-time 5 -X POST http://localhost:8004/v1/messages -H "content-type: application/json" -d '{"model":"claude-deepseek-v4-flash[1m]","messages":[{"role":"user","content":"x"}]}')"
  check "T13 [1m] window marker stripped before DeepSeek" 'echo "$W1" | grep -q "ROUTED:deepseek-v4-flash EFFORT"'

  W2="$(curl -s --max-time 5 -X POST http://localhost:8004/v1/messages -H "content-type: application/json" -d '{"model":"claude-deepseek-v4-pro","messages":[{"role":"user","content":"x"}]}')"
  check "T13b bare display id still routes" 'echo "$W2" | grep -q "ROUTED:deepseek-v4-pro"'

  # The request goes out as the real id (T13) and the response must come back as
  # the display id. Claude Code restores a resumed session's model from the
  # `model` of the last assistant message in the transcript, so an unrewritten
  # `deepseek-v4-flash` there is an id it cannot resolve: it declines the restore
  # and falls back to one without `[1m]`, dropping the session to an assumed 200k
  # window. The mock echoes whatever model it received into message_start, so
  # `ROUTED:` proves what was sent and `"model":` proves what came back.
  check "T14 response echoes the display id, not the DeepSeek id" 'echo "$W1" | grep -q "\"model\":\"claude-deepseek-v4-flash\[1m\]\""'
  check "T14b the real id is gone from the response body" '! echo "$W1" | grep -q "\"model\":\"deepseek-v4-flash\""'
  check "T14c the request still carried the real id" 'echo "$W1" | grep -q "ROUTED:deepseek-v4-flash"'

  # Claude Code strips [1m] before dispatching, so this is the shape the proxy
  # actually sees in production. Echoing back what arrived would drop the suffix
  # from the transcript and cost the resumed session its 1M window, so the
  # response carries the canonical display id regardless of what was asked.
  W3="$(curl -s --max-time 5 -X POST http://localhost:8004/v1/messages -H "content-type: application/json" -d '{"model":"claude-deepseek-v4-flash","messages":[{"role":"user","content":"x"}]}')"
  check "T14d suffix-less request still answers with the [1m] display id" 'echo "$W3" | grep -q "\"model\":\"claude-deepseek-v4-flash\[1m\]\""'
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

# Vision redirect (ADR-0004): a DeepSeek-bound request carrying an image block is
# rerouted to a vision-capable Anthropic model instead of 400ing upstream. V1 is
# one real claude-opus-5 answer (tiny cost, mirrors T8's real-API pattern); V2/V3
# prove the gates against the mock. 1x1 transparent PNG so the real model accepts
# the image.
PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
# max_tokens is a realistic Claude Code field and keeps the mock's echo tight.
IMG_BODY='{"model":"claude-deepseek-v4-flash[1m]","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"'"$PNG"'"}},{"type":"text","text":"Reply with exactly: OK"}]}]}'

cat >"$TMP/vision.yml" <<'EOF'
port: 8010
sentinel: test-vision-sentinel
vision:
  redirect: true
  baseUrl: http://localhost:__MOCK__
EOF
sed "s/__MOCK__/$MOCK_PORT/" "$TMP/vision.yml" > "$TMP/vision-mock.yml"
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8010 --port 8010 --config "$TMP/vision-mock.yml"; then
  V1="$(curl -s --max-time 30 -X POST http://localhost:8010/v1/messages -H "content-type: application/json" -H "authorization: Bearer test-vision-sentinel" -H "anthropic-version: 2023-06-01" -d "$IMG_BODY")"
  # The gate itself is deterministic and free: the image request must not reach
  # the DeepSeek mock route (which answers ROUTED:), and must reach the local
  # vision leg's OpenAI route instead (which answers LOCAL_VISION:).
  check "V1 image on deepseek redirects (never hits deepseek route)" '! echo "$V1" | grep -q "ROUTED:"'
  check "V1a image request reaches the local vision leg" 'echo "$V1" | grep -q "LOCAL_VISION:"'
  # The mock echoes the model the proxy sent on the OpenAI leg — proof the
  # translation swapped to the configured local model, not the client's id.
  check "V1b local leg receives the configured vision model" 'echo "$V1" | grep -q "LOCAL_VISION:prism-ml/bonsai-27b"'
  # The Anthropic-shaped response the client sees must still echo the display id
  # the normal DeepSeek path would have used (ADR-0001 restore contract).
  check "V1c redirected response echoes the display id" 'echo "$V1" | grep -q "\"model\":\"claude-deepseek-v4-flash\[1m\]\""'
  check "V1d redirected turn logged with a redirected field" 'grep -q "\"redirected\"" "$ROOT/logs/proxy-usage.jsonl"'

  # negative control: same proxy, no image, still routes to the mock
  N="$(curl -s --max-time 5 -X POST http://localhost:8010/v1/messages -H "content-type: application/json" -d '{"model":"claude-deepseek-v4-flash[1m]","messages":[{"role":"user","content":"x"}]}')"
  check "V1e no-image request still routes to deepseek" 'echo "$N" | grep -q "ROUTED:deepseek-v4-flash"'
else
  echo "FAIL V1 could not start proxy with vision config"
fi

cat >"$TMP/vision-off.yml" <<'EOF'
port: 8011
vision:
  redirect: false
EOF
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8011 --port 8011 --config "$TMP/vision-off.yml"; then
  V2="$(curl -s --max-time 5 -X POST http://localhost:8011/v1/messages -H "content-type: application/json" -d "$IMG_BODY")"
  check "V2 vision.redirect false leaves image on deepseek" 'echo "$V2" | grep -q "ROUTED:deepseek-v4-flash"'
else
  echo "FAIL V2 could not start proxy with vision-off config"
fi

# A redir-routed family name is DeepSeek-bound too, so the image check fires — but
# the response must still echo `sonnet`, the id the client sent. Echoing a DeepSeek
# display id here would flip the session model, which is the failure the redirect
# exists to avoid, pointed the other way.
cat >"$TMP/vision-redir.yml" <<'EOF'
port: 8013
redir:
  sonnet: deepseek-v4-flash
vision:
  redirect: true
  baseUrl: http://localhost:__MOCK__
EOF
IMG_SONNET='{"model":"claude-sonnet-4-5","stream":true,"max_tokens":32,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"'"$PNG"'"}},{"type":"text","text":"hi"}]}]}'
sed "s/__MOCK__/$MOCK_PORT/" "$TMP/vision-redir.yml" > "$TMP/vision-redir-mock.yml"
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8013 --port 8013 --config "$TMP/vision-redir-mock.yml"; then
  V4="$(curl -s --max-time 30 -X POST http://localhost:8013/v1/messages -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -d "$IMG_SONNET")"
  check "V4 redir-routed image redirects too (never hits deepseek route)" '! echo "$V4" | grep -q "ROUTED:"'
  check "V4a redir-routed image reaches the local vision leg" 'echo "$V4" | grep -q "LOCAL_VISION:"'
  # Echoing a DeepSeek display id here would flip the session model — the failure
  # the redirect exists to avoid, pointed the other way. The client's own string
  # (`claude-sonnet-4-5`) is what the normal redir path would have echoed.
  check "V4b redirect echoes the client's own id, not a deepseek display id" 'echo "$V4" | grep -q "\"model\":\"claude-sonnet-4-5\"" && ! echo "$V4" | grep -q "claude-deepseek-"'

  NR="$(curl -s --max-time 5 -X POST http://localhost:8013/v1/messages -H "content-type: application/json" -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"x"}]}')"
  check "V4c redir without an image still routes to deepseek" 'echo "$NR" | grep -q "ROUTED:deepseek-v4-flash"'
else
  echo "FAIL V4 could not start proxy with redir+vision config"
fi

cat >"$TMP/vision-cap.yml" <<'EOF'
port: 8012
vision:
  redirect: true
capabilities:
  deepseek-v4-flash:
    vision: true
EOF
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:$MOCK_PORT" start_proxy 8012 --port 8012 --config "$TMP/vision-cap.yml"; then
  V3="$(curl -s --max-time 5 -X POST http://localhost:8012/v1/messages -H "content-type: application/json" -d "$IMG_BODY")"
  check "V3 capability override vision:true keeps image on deepseek" 'echo "$V3" | grep -q "ROUTED:deepseek-v4-flash"'
else
  echo "FAIL V3 could not start proxy with capability config"
fi

# T8 forward fallback: dead deepseek -> real anthropic
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:1" start_proxy 8005 --port 8005 --redir --fallback; then
  O="$(cc 8005 --model sonnet "Reply with exactly: OK")"
  check "T8 fallback deepseek-dead -> anthropic" 'ok "$O"'
else
  echo "FAIL T8 could not start proxy"
fi

# T8b the same proxy without --fallback must not cross legs. ADR-0005: --redir
# used to imply fallback, so a dead DeepSeek quietly spent Anthropic plan traffic
# — and the reverse spent DeepSeek credits on a 429 the user never saw. Crossing
# is opt-in now, and a dead upstream is an error the user gets told about.
if DEEPSEEK_ANTHROPIC_BASE_URL="http://localhost:1" start_proxy 8017 --port 8017 --redir; then
  O="$(curl -s --max-time 10 -X POST http://localhost:8017/v1/messages -H "content-type: application/json" \
    -d '{"model":"sonnet","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}')"
  check "T8b no --fallback: dead deepseek errors instead of crossing" 'echo "$O" | grep -q "deepseek upstream error"'
else
  echo "FAIL T8b could not start proxy"
fi

# T9 reverse fallback: anthropic 404 -> real deepseek
# The usage log is append-only and outlives a run, so T9b reads only the lines
# this run added — otherwise one passing run leaves a row that makes every later
# run pass whether the tagging still works or not.
USAGE_BEFORE="$( (wc -l < "$ROOT/logs/proxy-usage.jsonl") 2>/dev/null || echo 0)"
if start_proxy 8006 --port 8006 --fallback; then
  O="$(cc 8006 --model claude-sonnet-4-5-fake "Reply with exactly: OK")"
  check "T9 fallback anthropic-404 -> deepseek" 'ok "$O"'
  # The crossing that just happened spent DeepSeek credits on a turn aimed at
  # Anthropic, and the response reports the Anthropic model. The usage log is the
  # only place that says so, so it has to say so.
  check "T9b the crossing is tagged in the usage log" 'tail -n "+$((USAGE_BEFORE + 1))" "$ROOT/logs/proxy-usage.jsonl" | grep -q "\"fallbackFrom\":\"anthropic\""'
else
  echo "FAIL T9 could not start proxy"
fi

# T11 per-request usage log line (written after real proxy runs above)
check "T11 usage log written" 'test -s "$ROOT/logs/proxy-usage.jsonl" && grep -q "usage" "$ROOT/logs/proxy-usage.jsonl"'

# ---------------------------------------------------------------------------
echo ""
echo "==> results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
