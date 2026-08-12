#!/bin/bash
# Launcher: start the proxy, point Claude Code at it, stop the proxy on the way
# out. See README "The claudei.sh launcher".
set -u
# No job-control notices: the proxy is a background child we stop deliberately,
# and "Terminated: 15" printed over the shutdown line reads like a crash.
set +m

PROXY_HOME="${DEEPSEEK_IN_CLAUDE_HOME:-$HOME/.deepseek-in-claude}"
PORT="${DEEPSEEK_PROXY_PORT:-8016}"
CLAUDE="${CLAUDE:-$(command -v claude || echo "$HOME/.local/bin/claude")}"

# Per-user state directory, mode 0700. The pid file, the launch fingerprint and
# the proxy log all describe one person's session; at fixed /tmp paths they were
# world-readable and collided between users on a shared machine.
STATE_DIR="${TMPDIR:-/tmp}/deepseek-in-claude-$(id -u)"
mkdir -p "$STATE_DIR" || { echo "error: cannot create $STATE_DIR" >&2; exit 1; }
chmod 700 "$STATE_DIR"
STAMP="$STATE_DIR/proxy.sha"
PIDFILE="$STATE_DIR/proxy.pid"
PROXY_LOG="$STATE_DIR/proxy.log"

# --- proxy lifecycle ---------------------------------------------------------

# True only for a live process that is still this proxy. Pids get recycled, so
# "something is listening on 8016" is not licence to kill it — that is how a
# launcher ends up terminating an unrelated process that inherited the port.
pid_is_proxy() {
  case "${1:-}" in "" | *[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  ps -o command= -p "$1" 2>/dev/null | grep -q "proxy\.mjs"
}

proxy_pid() {
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if pid_is_proxy "$pid"; then printf '%s' "$pid"; return 0; fi
  # No usable pid file — an older launcher, or one that died. Fall back to the
  # port, still refusing to signal anything that isn't our proxy.
  pid="$(lsof -ti :"$PORT" 2>/dev/null | head -n 1)"
  if pid_is_proxy "$pid"; then printf '%s' "$pid"; return 0; fi
  return 1
}

stop_proxy() {
  local pid i
  pid="$(proxy_pid)" || { rm -f "$PIDFILE"; return 0; }
  kill "$pid" 2>/dev/null
  # Escalate rather than assume: a proxy mid-stream can ignore TERM, and leaving
  # it alive means the next launch reuses a process it thinks it replaced.
  i=0
  while [ "$i" -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
    i=$((i + 1))
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  rm -f "$PIDFILE"
}

# The proxy is started detached, so without a trap it outlives an interrupted
# launcher — holding the port with nothing left to shut it down. On EXIT covers
# every ordinary path: normal exit, an error exit, Ctrl+C (which signals the
# whole foreground group, so `claude` returns and this runs), and a SIGTERM
# aimed at this script, which bash defers until `claude` exits but still
# honours. Only SIGKILL escapes it; the next launch reclaims that proxy by port.
on_exit() {
  echo "🚀 Stopping proxy on :$PORT ..."
  stop_proxy
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- update ------------------------------------------------------------------

if ! command -v "$CLAUDE" >/dev/null 2>&1 && [ ! -x "$CLAUDE" ]; then
  echo "error: claude CLI not found at '$CLAUDE'. Set CLAUDE=/path/to/claude." >&2
  exit 1
fi

echo "🚀 Checking update ..."
# A failed update is not a reason to refuse to start — the installed version
# still works, and offline or rate-limited is the common cause.
"$CLAUDE" update || echo "   update check failed, continuing with the installed version"

# --- proxy -------------------------------------------------------------------

echo "🚀 Starting proxy on :$PORT ..."
printf '   proxy source: %s (version %s)\n' "$PROXY_HOME" "$(cat "$PROXY_HOME/VERSION" 2>/dev/null || echo unknown)"

# A long-lived proxy keeps the proxy.mjs it was launched with in memory, so an
# updated checkout is invisible until the process is replaced. Fingerprint at
# launch and restart on mismatch — otherwise the reuse path below silently
# serves stale model ids (and thus a stale context window).
#
# config.yml is in the fingerprint too: every key in it (port, redir, fallback,
# effort, authBridge, sentinel) is read once at proxy startup. The sentinel is
# the sharp case — the installer writing a new one while a proxy is already
# running would leave this script exporting a value the old process doesn't
# recognise, and every Anthropic-model request would 401 while DeepSeek models
# kept working.
if command -v shasum >/dev/null 2>&1; then
  SHA="$(cat "$PROXY_HOME/proxy.mjs" "$PROXY_HOME/config.yml" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
else
  SHA="$(cat "$PROXY_HOME/proxy.mjs" "$PROXY_HOME/config.yml" 2>/dev/null | sha256sum | cut -d' ' -f1)"
fi

# CLI flags win over config.yml inside the proxy, so passing --fallback
# unconditionally would override an explicit `fallback: false`. Only supply it
# when the config expresses no opinion.
PROXY_FLAGS=""
if ! grep -q '^fallback:' "$PROXY_HOME/config.yml" 2>/dev/null; then
  PROXY_FLAGS="--fallback"
fi

if RUNNING_PID="$(proxy_pid)" && [ "$SHA" = "$(cat "$STAMP" 2>/dev/null)" ]; then
  echo "   proxy already running (pid $RUNNING_PID), reusing"
else
  if proxy_pid >/dev/null; then
    echo "   proxy.mjs or config.yml changed since launch, restarting"
    stop_proxy
  fi
  # The log can carry request paths and upstream error text, so create it 0600
  # before anything writes to it rather than inheriting the ambient umask.
  : >"$PROXY_LOG" && chmod 600 "$PROXY_LOG"
  # Started by absolute path rather than from a subshell `cd`: proxy.mjs resolves
  # .env, config.yml and logs/ from its own module path, so the working
  # directory is irrelevant — and keeping it in this shell means `disown` can
  # take it out of the job table, so stopping it later prints no "Terminated"
  # notice over the shutdown line.
  # $PROXY_FLAGS is deliberately unquoted: it is a list of flags, never a path.
  # shellcheck disable=SC2086
  PORT=$PORT nohup node "$PROXY_HOME/proxy.mjs" $PROXY_FLAGS >"$PROXY_LOG" 2>&1 &
  echo $! >"$PIDFILE"
  disown "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 2
  if ! proxy_pid >/dev/null; then
    echo "error: proxy failed to start — see $PROXY_LOG" >&2
    tail -5 "$PROXY_LOG" >&2 2>/dev/null
    exit 1
  fi
  printf '%s' "$SHA" >"$STAMP"
fi

# --- model list --------------------------------------------------------------
# Claude Code builds the /model picker's gateway rows from this cache file, not
# from a live fetch: the reader takes the file, and the fetch that would refresh
# it runs only when an auth environment variable is set (documented at
# code.claude.com/docs/en/llm-gateway-protocol#model-discovery, and measured —
# see docs/probe-findings.md §5.3). Writing the file ourselves is what lets the
# launcher set no auth variable at all, which is what keeps claude.ai connectors
# working; the CLI disables them whenever one is present.
#
# Purged first and unconditionally, because a list captured by an older proxy is
# keyed by the same base URL and would otherwise survive the restart as stale ids.
CACHE_DIR="$HOME/.claude/cache"
rm -f "$CACHE_DIR/gateway-models.json"

# The base URL is a variable rather than a literal from here on: Claude Code
# compares the cache's baseUrl to ANTHROPIC_BASE_URL with a string !=, so
# "localhost" vs "127.0.0.1", or a stray trailing slash, silently yields an empty
# gateway list that looks exactly like the feature not working.
BASE_URL="http://localhost:$PORT"

# Only the DeepSeek entries are seeded. Anthropic's models are already built-in
# rows in the picker, and this endpoint skips the proxy's Anthropic leg so the
# launcher needs no credential to build the list.
mkdir -p "$CACHE_DIR"
if MODELS_JSON="$(curl -fsS --max-time 10 "$BASE_URL/_proxy/deepseek-models" 2>/dev/null)"; then
  # Written through a temp file and renamed so a half-written cache can never be
  # read by the CLI starting up beside us.
  TMP_CACHE="$(mktemp "$CACHE_DIR/gateway-models.XXXXXX")"
  if printf '%s' "$MODELS_JSON" | BASE_URL="$BASE_URL" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const models = JSON.parse(raw).data ?? [];
      if (models.length === 0) process.exit(1);
      process.stdout.write(JSON.stringify({
        baseUrl: process.env.BASE_URL,
        fetchedAt: Date.now(),
        models,
      }));
    });
  ' >"$TMP_CACHE" 2>/dev/null; then
    chmod 600 "$TMP_CACHE"
    mv "$TMP_CACHE" "$CACHE_DIR/gateway-models.json"
    echo "   seeded the model picker from the proxy"
  else
    rm -f "$TMP_CACHE"
    echo "   warning: could not build the model list — DeepSeek models will be missing from /model" >&2
  fi
else
  echo "   warning: proxy did not serve a model list — DeepSeek models will be missing from /model" >&2
fi

# --- claude ------------------------------------------------------------------

echo "🚀 Starting claude code irrestrict..."
# No auth environment variable is set, deliberately. Claude Code disables
# claude.ai connectors whenever it finds one, and with the picker seeded above
# there is nothing left that needs one: the CLI authenticates the Anthropic leg
# with its own claude.ai OAuth bearer, which the proxy passes through untouched
# (a bearer that is not the sentinel is never rewritten), and which already
# carries the oauth-2025-04-20 capability the upstream requires.
#
# The sentinel and the credential bridge are not gone — they remain the
# supported path for anyone who sets ANTHROPIC_AUTH_TOKEN deliberately, and
# proxy.mjs still swaps that exact value for the real OAuth token. This launcher
# simply no longer needs them, having previously set the sentinel only to make
# gateway model discovery run at all.
#
# Whatever this shell already exports is cleared rather than deferred to, because
# either variable outranks the sentinel at the upstream and moves your Anthropic
# spend off the plan you already pay for (ADR-0002). ANTHROPIC_API_KEY is the
# quiet one: the CLI sends it as x-api-key alongside the bearer, api.anthropic.com
# prefers the key, so a valid one authenticates and bills every Anthropic request
# to API credits while the sentinel swap still looks like it is working.
# ANTHROPIC_AUTH_TOKEN is the loud one: it would be forwarded to Anthropic
# verbatim, bridging nothing, and it would disable claude.ai connectors on top.
# Mutating this shell's own environment is safe because nothing below reads
# either name — the EXIT trap only stops the proxy.
#
# A value you deliberately exported vanishing without a word is its own surprise,
# so say so. It goes to stdout beside the other 🚀 progress lines because it
# reports a decision the launcher made, not a failure; only the name is printed,
# never the value, since this text can end up in a pasted terminal log.
IGNORED=""
[ -n "${ANTHROPIC_API_KEY:-}" ] && IGNORED="ANTHROPIC_API_KEY"
[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && IGNORED="${IGNORED:+$IGNORED and }ANTHROPIC_AUTH_TOKEN"
if [ -n "$IGNORED" ]; then
  echo "   ignoring $IGNORED from your shell: Anthropic models bill to your Claude plan, not API credits"
fi
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

# Permission prompts are skipped by default — that is what the "i" in claudei
# is for — but it is a real safety switch, so it is a variable you can turn off
# rather than a hardcoded flag: CLAUDEI_SKIP_PERMISSIONS=0 claudei.sh
CLAUDE_FLAGS=""
if [ "${CLAUDEI_SKIP_PERMISSIONS:-1}" != "0" ]; then
  CLAUDE_FLAGS="--dangerously-skip-permissions"
fi

# shellcheck disable=SC2086
# The discovery flag stays set even though nothing fetches: it also gates the
# *reader* of the seeded cache, so without it the picker shows no gateway rows.
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
ANTHROPIC_BASE_URL="$BASE_URL" "$CLAUDE" $CLAUDE_FLAGS \
   --append-system-prompt "Be terse while keep information density. Forward terseness instruction to all sub-agents" \
   "$@"
EXIT=$?

exit $EXIT
