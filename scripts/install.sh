#!/usr/bin/env bash
# One-shot curl installer: clones deepseek-in-claude from GitHub main into a
# stable location and sets up .env. Zero runtime deps — no build step.
#
#   curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
#
# The checkout lives at $DEEPSEEK_IN_CLAUDE_HOME (default ~/.deepseek-in-claude).
#
# Security notes:
#   - No code is piped straight from curl into a shell: this script only does a
#     shallow git checkout of a pinned branch, then runs the proxy with node.
#   - The API key is read with input hidden (-s) straight from /dev/tty, and
#     written only to $DEST/.env (gitignored).
#   - git pull is --ff-only: local edits in the checkout are never overwritten.
set -euo pipefail

REPO="Korck-lab/deepseek-in-claude"
BRANCH="main"
DEST="${DEEPSEEK_IN_CLAUDE_HOME:-$HOME/.deepseek-in-claude}"
ENV_FILE="$DEST/.env"
KEY_URL="https://platform.deepseek.com/api_keys"

echo "==> deepseek-in-claude curl installer"
echo "    repo:   https://github.com/$REPO ($BRANCH)"
echo "    target: $DEST"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found. Need Node.js >= 18." >&2
  exit 1
fi

# Under `curl | bash` stdin is the already-exhausted pipe, so interactive steps
# read from the controlling terminal directly (/dev/tty) instead of stdin.
# No controlling terminal (CI, SSH -T) → non-interactive fallback (--yes).
TTY_OK=false
if (: </dev/tty) 2>/dev/null; then
  TTY_OK=true
fi

MODE="fresh install"
if [ -d "$DEST/.git" ]; then
  MODE="update"
  echo "==> existing checkout, updating..."
  git -C "$DEST" pull --ff-only --quiet origin "$BRANCH"
else
  echo "==> cloning..."
  git clone --quiet --branch "$BRANCH" --depth 1 "https://github.com/$REPO.git" "$DEST"
fi
echo "    mode:   $MODE"

cd "$DEST"

# --- API key ----------------------------------------------------------------
# Fresh install has no key (placeholder sk-... from .env.example counts as unset).
# Ask for one interactively, showing the direct key-creation page. Updates keep
# whatever key is already in .env — never overwrite it.
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "==> created $ENV_FILE"
fi

EXISTING_KEY="$(grep '^DEEPSEEK_API_KEY=' "$ENV_FILE" | head -n 1 | cut -d= -f2- || :)"

if [ -n "$EXISTING_KEY" ] && [ "$EXISTING_KEY" != "sk-..." ]; then
  echo "==> DEEPSEEK_API_KEY already set in .env — keeping it"
elif [ "$TTY_OK" = true ]; then
  echo ""
  echo "DEEPSEEK_API_KEY is not set yet."
  echo "Create one here: $KEY_URL"
  if command -v open >/dev/null 2>&1; then
    open "$KEY_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$KEY_URL" >/dev/null 2>&1 || true
  fi

  KEY=""
  while :; do
    printf '%s' "Paste (Cmd/Ctrl+V) or type your key — input hidden; Ctrl+C to abort: "
    if ! IFS= read -r -s KEY </dev/tty; then
      echo ""
      echo "warning: could not read from terminal — add the key to .env later." >&2
      KEY=""
      break
    fi
    echo ""
    if [ -n "$KEY" ] && [ "${KEY#sk-}" != "$KEY" ]; then
      break
    fi
    echo "error: key must start with 'sk-'. Try again." >&2
  done

  if [ -n "$KEY" ]; then
    grep -v '^DEEPSEEK_API_KEY=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    printf 'DEEPSEEK_API_KEY=%s\n' "$KEY" >> "$ENV_FILE"
    echo "==> DEEPSEEK_API_KEY saved to $ENV_FILE (gitignored)"
  fi
else
  echo "warning: no terminal — key prompt skipped. Add DEEPSEEK_API_KEY to $ENV_FILE later." >&2
fi

echo "==> done"
echo "    start:   node $DEST/proxy.mjs"
echo "    connect: ANTHROPIC_BASE_URL=http://localhost:8016 claude"
