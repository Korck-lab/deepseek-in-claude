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
  # A modified tracked file makes --ff-only abort with git's "local changes
  # would be overwritten" — accurate, but it names git as the problem and says
  # nothing about which of these files a person is expected to care about. The
  # common cause is a version copied in over the checkout rather than pulled, in
  # which case there is nothing to keep. .env and config.yml are gitignored and
  # are never at risk either way, so say so rather than leaving that in doubt.
  DIRTY="$(git -C "$DEST" status --porcelain --untracked-files=no)"
  if [ -n "$DIRTY" ]; then
    echo "error: $DEST has uncommitted changes to tracked files:" >&2
    printf '%s\n' "$DIRTY" | sed 's/^/       /' >&2
    echo "" >&2
    echo "       Your .env and config.yml are gitignored and are not affected." >&2
    echo "       To see what differs:   git -C $DEST diff" >&2
    echo "       To discard and update: git -C $DEST checkout -- . && $0" >&2
    exit 1
  fi
  git -C "$DEST" pull --ff-only --quiet origin "$BRANCH"
elif [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null || echo x)" ]; then
  # git clone into a non-empty directory fails with "destination path already
  # exists and is not an empty directory", which reads like a git problem rather
  # than "something else already lives where the checkout goes".
  echo "error: $DEST already exists and is not a deepseek-in-claude checkout." >&2
  echo "       Move it aside, or set DEEPSEEK_IN_CLAUDE_HOME to a different path." >&2
  exit 1
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
    # Trim surrounding whitespace: a pasted key often carries a trailing space or
    # CR, and the proxy would send it verbatim and get a puzzling 401.
    KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
    if [ -n "$KEY" ] && [ "${KEY#sk-}" != "$KEY" ]; then
      break
    fi
    echo "error: key must start with 'sk-'. Try again." >&2
  done

  if [ -n "$KEY" ]; then
    # Rewrite through a private temp file in the same directory and rename it
    # into place: the previous read-then-truncate left a window where a second
    # installer (or a proxy start) could see a .env with no key at all.
    TMP_ENV="$(mktemp "$DEST/.env.XXXXXX")"
    chmod 600 "$TMP_ENV"
    grep -v '^DEEPSEEK_API_KEY=' "$ENV_FILE" > "$TMP_ENV" || true
    printf 'DEEPSEEK_API_KEY=%s\n' "$KEY" >> "$TMP_ENV"
    mv "$TMP_ENV" "$ENV_FILE"
    echo "==> DEEPSEEK_API_KEY saved to $ENV_FILE (gitignored)"
  fi
else
  echo "warning: no terminal — key prompt skipped. Add DEEPSEEK_API_KEY to $ENV_FILE later." >&2
fi

# --- auth sentinel ----------------------------------------------------------
# The sentinel is the ANTHROPIC_AUTH_TOKEN value the proxy swaps for the real
# Claude Code OAuth token. A published constant means anyone who can reach the
# proxy can spend that token, so generate a per-install random value instead.
# config.yml is the single source of truth: the proxy reads it, and claudei.sh
# reads it back out to hand Claude Code the matching value. Written only when
# absent — never overwrite a sentinel already in use.
CFG_FILE="$DEST/config.yml"

if [ ! -f "$CFG_FILE" ]; then
  # Deliberately minimal, not a copy of config.example.yml — that file enables
  # the redir map, which would silently reroute Anthropic models to DeepSeek.
  printf '# deepseek-in-claude proxy config. See config.example.yml for every option.\n' > "$CFG_FILE"
fi

if ! grep -q '^sentinel:' "$CFG_FILE"; then
  # Append-safe even if the existing file lacks a trailing newline. Written as an
  # `if` rather than a `&&` chain because under `set -e` a false test at the end
  # of a chain would abort the installer, and a file already ending in a newline
  # is the normal case, not a failure.
  if [ -s "$CFG_FILE" ] && [ -n "$(tail -c 1 "$CFG_FILE")" ]; then printf '\n' >> "$CFG_FILE"; fi
  if command -v openssl >/dev/null 2>&1; then
    RAND="$(openssl rand -hex 16)"
  else
    RAND="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  printf 'sentinel: local-deepseek-proxy-%s\n' "$RAND" >> "$CFG_FILE"
  chmod 600 "$CFG_FILE"
  echo "==> generated a per-install auth sentinel in $CFG_FILE"
fi

# --- global launcher --------------------------------------------------------
# A symlink rather than a copy: the checkout is what `git pull` updates, so a
# copy would silently keep running the version installed on the day it was made.
# claudei.sh resolves the checkout from DEEPSEEK_IN_CLAUDE_HOME or $HOME, never
# from $0, so it behaves identically however it is invoked.
#
# ~/.local/bin is the default because it is the conventional per-user bin
# directory and needs no sudo. Nothing here writes outside $HOME.
BIN_DIR="${CLAUDEI_BIN_DIR:-$HOME/.local/bin}"
LINK="$BIN_DIR/claudei"

mkdir -p "$BIN_DIR"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  # Someone else's file with our name. Overwriting it would be the installer
  # destroying data it does not own.
  echo "warning: $LINK exists and is not a symlink — leaving it alone." >&2
  echo "         Run claudei.sh from $DEST, or set CLAUDEI_BIN_DIR." >&2
else
  ln -sf "$DEST/claudei.sh" "$LINK"
  chmod +x "$DEST/claudei.sh" 2>/dev/null || true
  echo "==> linked $LINK -> $DEST/claudei.sh"

  # A symlink in a directory that is not on PATH is a command the user cannot
  # run, and the failure ("command not found") says nothing about why. Check the
  # real PATH rather than assuming the conventional directory is on it.
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo "    note: $BIN_DIR is not on your PATH. Add it:" >&2
      echo "          echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc" >&2
      ;;
  esac
fi

echo "==> done"
echo "    run:     claudei                      # from anywhere"
echo "    start:   node $DEST/proxy.mjs"
# No auth variable is set here on purpose: either one moves Anthropic spend onto
# API credits (ADR-0002) and disables claude.ai connectors. DeepSeek reaches the
# picker through the seeded model cache instead, which claudei.sh writes — hence
# pointing at it rather than printing a recipe that would leave the picker empty.
echo "    connect: unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 ANTHROPIC_BASE_URL=http://localhost:8016 claude"
echo "             (DeepSeek models need the picker cache seeded — run claudei, which does it)"
