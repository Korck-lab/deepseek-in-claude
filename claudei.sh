#!/bin/bash

PROXY_HOME="$HOME/.deepseek-in-claude"
PORT=8016

echo "🚀 Checking update ..."
~/.local/bin/claude update

echo "🚀 Starting proxy on :$PORT ..."
echo "   proxy source: $PROXY_HOME (version $(cat "$PROXY_HOME/VERSION" 2>/dev/null || echo unknown))"

# A long-lived proxy keeps the proxy.mjs it was launched with in memory, so an
# updated checkout is invisible until the process is replaced. Fingerprint the
# file at launch and restart on mismatch — otherwise the reuse path below
# silently serves stale model ids (and thus a stale context window).
#
# config.yml is in the fingerprint too: every key in it (port, redir, fallback,
# effort, authBridge, sentinel) is read once at proxy startup. The sentinel is
# the sharp case — the installer writing a new one while a proxy is already
# running would leave the launcher exporting a value the old process doesn't
# recognise, and every Anthropic-model request would 401 while DeepSeek models
# kept working.
STAMP=/tmp/deepseek-proxy.sha
SHA="$(cat "$PROXY_HOME/proxy.mjs" "$PROXY_HOME/config.yml" 2>/dev/null | shasum | cut -d' ' -f1)"

if lsof -ti :$PORT >/dev/null 2>&1 && [ "$SHA" = "$(cat "$STAMP" 2>/dev/null)" ]; then
  echo "   proxy already running, reusing"
else
  if lsof -ti :$PORT >/dev/null 2>&1; then
    echo "   proxy.mjs or config.yml changed since launch, restarting"
    lsof -ti :$PORT | xargs kill 2>/dev/null || true
    sleep 1
  fi
  (cd "$PROXY_HOME" && PORT=$PORT nohup node proxy.mjs --fallback >/tmp/deepseek-proxy.log 2>&1 &)
  sleep 2
  printf '%s' "$SHA" > "$STAMP"
fi

# Claude Code caches the discovered model list keyed by base URL, which never
# changes here — so a list captured before a proxy change would survive the
# restart and show stale ids. Purge unconditionally: the reuse path above can
# still be serving a list captured by an older proxy.
rm -f "$HOME/.claude/cache/gateway-models.json"

echo "🚀 Starting claude code irrestrict..."
# ANTHROPIC_AUTH_TOKEN is a sentinel, not a credential: Claude Code only runs
# gateway model discovery (what puts DeepSeek in the /model picker) when an auth
# env var is set, and the proxy swaps this exact value for your real Claude Code
# OAuth token on the Anthropic leg.
#
# The value must match what the proxy expects exactly or every Anthropic-model
# request 401s, so both sides read it from the same config.yml. install.sh
# writes a per-install random value there; if the key is absent, both fall back
# to the historical literal. Parsing mirrors the proxy's YAML subset: strip an
# inline comment (whitespace + #) and surrounding quotes.
SENTINEL="$(sed -n 's/^sentinel:[[:space:]]*//p' "$PROXY_HOME/config.yml" 2>/dev/null \
  | head -n 1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d "\"'" | tr -d '[:space:]')"

CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-${SENTINEL:-local-deepseek-proxy}}" \
ANTHROPIC_BASE_URL=http://localhost:$PORT claude --dangerously-skip-permissions \
   --append-system-prompt "Be terse while keep information density. Forward terseness instruction to all sub-agents" \
   "$@"
EXIT=$?

echo "🚀 Stopping proxy on :$PORT ..."
lsof -ti :$PORT | xargs kill 2>/dev/null || true

exit $EXIT
