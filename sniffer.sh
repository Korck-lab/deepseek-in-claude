#!/bin/sh
# sniffer.sh — run Claude Code against api.anthropic.com through a logging tap.
#
# This is the control experiment for claudei.sh: no proxy, no model merging, no credential
# bridge. Claude Code talks to Anthropic exactly as it would with no base URL override at
# all, and every exchange is written to logs/sniff/ for reading afterwards.
#
# By default no auth environment variable is set, and any inherited one is cleared: the CLI
# uses your claude.ai login, claude.ai connectors stay enabled, and the gateway model
# discovery fetch does not run. That is the same auth configuration claudei.sh now launches
# with — the difference is that claudei.sh also seeds the picker's model cache, which this
# raw tap deliberately does not, so a capture here shows the CLI on its own terms.
#
# DISCOVERY=1 sets CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 and *still* sets no auth
# variable. That combination is the open question: we believe from reading the CLI binary
# that discovery also requires an auth env var, and this is the run that tests the belief
# from the network side. Either a GET /v1/models appears in the capture — the precondition
# is not real — or none does, which confirms it with evidence rather than by disassembly.
#
# Note the scope: the tap talks straight to api.anthropic.com, so a fetch here would return
# Anthropic's own models. This tests whether the flag causes a fetch, not whether DeepSeek
# models get merged into it — that is proxy.mjs's job and needs proxy.mjs to be in the path.
#
#   ./sniffer.sh                  capture a normal session
#   ./sniffer.sh -p "hello"       capture a one-shot
#   DISCOVERY=1 ./sniffer.sh      enable gateway model discovery (no auth var)
#   KEEP=1 ./sniffer.sh           keep previous captures instead of starting clean
#   SECRETS=1 ./sniffer.sh        log credentials verbatim instead of fingerprinting them
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${SNIFFER_PORT:-8015}"
LOG_DIR="$HERE/logs/sniff"

CLAUDE="$(command -v claude || true)"
if [ -z "$CLAUDE" ]; then
  echo "error: claude not found on PATH" >&2
  exit 1
fi

# A tap left over from an interrupted session keeps listening on the port, and the
# readiness check below cannot tell it apart from the one this script starts: the run would
# proceed against a process it does not own, writing captures nobody stops.
#
# An orphan of ours is ours to clean up — it holds nothing worth keeping, so reclaim the
# port rather than making the user go and kill it by hand. Anything else on the port is
# someone else's process and only they can decide what happens to it.
BUSY="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [ -n "$BUSY" ]; then
  BUSY_CMD="$(ps -o command= -p "$BUSY" 2>/dev/null || true)"
  case "$BUSY_CMD" in
    *sniffer.mjs*)
      echo "🔎 Reclaiming port $PORT from a leftover sniffer (pid $BUSY) ..."
      kill -TERM "$BUSY" 2>/dev/null || true
      j=0
      while [ "$j" -lt 30 ] && lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
        j=$((j + 1))
        sleep 0.1
      done
      if lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "error: leftover sniffer (pid $BUSY) did not release port $PORT." >&2
        echo "       kill -9 $BUSY, or pick another port with SNIFFER_PORT." >&2
        exit 1
      fi
      ;;
    *)
      echo "error: port $PORT is already in use by pid $BUSY:" >&2
      printf '%s\n' "$BUSY_CMD" | sed 's/^/       /' >&2
      echo "       kill it (kill $BUSY) or pick another port with SNIFFER_PORT." >&2
      exit 1
      ;;
  esac
fi

if [ "${KEEP:-0}" = "1" ]; then
  echo "🔎 Keeping previous captures in $LOG_DIR"
else
  # Only ever this directory, and only files this script's sniffer writes. The rest of
  # logs/ holds probe runs and the proxy usage log, which are not ours to remove.
  rm -f "$LOG_DIR"/*.json "$LOG_DIR"/index.jsonl "$LOG_DIR"/sniffer.log 2>/dev/null || true
fi
mkdir -p "$LOG_DIR"

SNIFFER_ARGS="--port $PORT"
[ "${SECRETS:-0}" = "1" ] && SNIFFER_ARGS="$SNIFFER_ARGS --keep-secrets"

echo "🔎 Starting sniffer on :$PORT ..."
# The tap shares this terminal with Claude Code's full-screen TUI, so it must stay silent:
# a line written mid-render lands inside the interface and corrupts it. Its own progress
# goes to sniffer.log, and anything it writes to stdout/stderr anyway (a node crash trace)
# is redirected there rather than onto the screen.
# shellcheck disable=SC2086
node "$HERE/scripts/sniffer.mjs" $SNIFFER_ARGS >>"$LOG_DIR/sniffer.log" 2>&1 &
SNIFFER_PID=$!

# One cleanup path for every exit — normal, Ctrl-C, or kill — so a capture session can
# never leave a tap holding the port. SIGTERM first so the sniffer prints its own summary.
cleanup() {
  if kill -0 "$SNIFFER_PID" 2>/dev/null; then
    echo "🔎 Stopping sniffer on :$PORT ..."
    kill -TERM "$SNIFFER_PID" 2>/dev/null || true
    wait "$SNIFFER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Wait for the listener rather than sleeping a guessed interval.
i=0
while [ "$i" -lt 50 ]; do
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then break; fi
  # The tap logs to a file now, so a startup failure (a port taken between the check above
  # and the listen, a node error) would otherwise show as a silent 5-second stall followed
  # by a bare timeout. Notice the dead child and print what it wrote.
  if ! kill -0 "$SNIFFER_PID" 2>/dev/null; then
    echo "error: sniffer exited during startup:" >&2
    tail -n 15 "$LOG_DIR/sniffer.log" 2>/dev/null | sed 's/^/       /' >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.1
done
if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "error: sniffer did not come up on :$PORT" >&2
  tail -n 15 "$LOG_DIR/sniffer.log" 2>/dev/null | sed 's/^/       /' >&2
  exit 1
fi

echo "🔎 Live progress: tail -f $LOG_DIR/sniffer.log"

# Cleared unconditionally, then the flag is re-set only when asked, so an inherited value
# can never decide which experiment ran. The auth variables stay cleared in both modes —
# whether discovery needs one is the thing being measured, so setting one would answer the
# question by assumption.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
if [ "${DISCOVERY:-0}" = "1" ]; then
  echo "🔎 Starting claude against the tap (claude.ai login, discovery flag ON, no auth env var) ..."
  export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
else
  echo "🔎 Starting claude against the tap (claude.ai login, no auth env var) ..."
fi
ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" "$CLAUDE" "$@"
EXIT=$?

# cleanup runs from the trap here.
echo "🔎 Captures in $LOG_DIR"
[ -f "$LOG_DIR/index.jsonl" ] && echo "   $(wc -l < "$LOG_DIR/index.jsonl" | tr -d ' ') exchange(s) — read the index with: cat $LOG_DIR/index.jsonl"

exit $EXIT
