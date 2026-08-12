#!/bin/bash

PROXY_HOME="$HOME/.deepseek-in-claude"
PORT=8016

echo "🚀 Checking update ..."
~/.local/bin/claude update

echo "🚀 Starting proxy on :$PORT ..."
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "   proxy already running, reusing"
else
  (cd "$PROXY_HOME" && PORT=$PORT nohup node proxy.mjs --fallback >/tmp/deepseek-proxy.log 2>&1 &)
  sleep 2
fi

echo "🚀 Starting claude code irrestrict..."
# ANTHROPIC_AUTH_TOKEN is a sentinel, not a credential: Claude Code only runs
# gateway model discovery (what puts DeepSeek in the /model picker) when an auth
# env var is set, and the proxy swaps this exact value for your real Claude Code
# OAuth token on the Anthropic leg.
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-local-deepseek-proxy}" \
ANTHROPIC_BASE_URL=http://localhost:$PORT claude --dangerously-skip-permissions \
   --append-system-prompt "Be terse while keep information density. Forward terseness instruction to all sub-agents" \
   "$@"
EXIT=$?

echo "🚀 Stopping proxy on :$PORT ..."
lsof -ti :$PORT | xargs kill 2>/dev/null || true

exit $EXIT
