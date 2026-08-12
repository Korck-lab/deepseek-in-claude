#!/usr/bin/env bash
# Guard: the proxy is pooled across concurrent claudei.sh sessions.
#
# One proxy serves every session, so the launcher's exit trap must stop it only
# when no other session is still using it. Before this was pooled, the first
# session to exit killed the proxy underneath every other one — a live session
# would lose its connection mid-response, which surfaces as an unexplained
# disconnect rather than as an error anyone can trace back to the launcher.
#
# Each case drives the real claudei.sh against a stub CLI and a stub proxy in an
# isolated HOME/TMPDIR/port, and asserts on the port: whether a listener is
# actually there afterwards, not on what the script printed.
#
# Usage: scripts/test-session-pool.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
WORK="$(mktemp -d)"
PORT=8897

cleanup() {
  # Any launcher still running would otherwise outlive the suite holding the port.
  pkill -f "proxy\.mjs" 2>/dev/null | true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

FAILS=0
chk() { # chk NAME CONDITION
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILS=$((FAILS + 1)); fi
}

port_open() { lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

mkdir -p "$WORK/ph" "$WORK/bin" "$WORK/home" "$WORK/tmp"
printf 'sentinel: pool-test\n' > "$WORK/ph/config.yml"
printf '0.0.0-test\n' > "$WORK/ph/VERSION"

# Serves only what the launcher needs to seed the picker; the contract under test
# is the launcher's lifecycle, not the model list.
cat > "$WORK/ph/proxy.mjs" <<'STUBPROXY'
import http from "node:http";
http.createServer((req, res) => {
  if (req.url === "/_proxy/deepseek-models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-deepseek-v4-flash[1m]", display_name: "DeepSeek V4 Flash", type: "model" }] }));
    return;
  }
  res.writeHead(404).end();
}).listen(Number(process.env.PORT) || 8897, "127.0.0.1");
STUBPROXY

# STUB_SLEEP is how a session is held open: the launcher blocks on the CLI, so a
# sleeping stub is a session that has not exited yet.
cat > "$WORK/bin/claude" <<'STUB'
#!/bin/sh
[ "${1:-}" = "update" ] && exit 0
sleep "${STUB_SLEEP:-0}"
exit 0
STUB
chmod +x "$WORK/bin/claude"

export HOME="$WORK/home" TMPDIR="$WORK/tmp" \
       DEEPSEEK_IN_CLAUDE_HOME="$WORK/ph" DEEPSEEK_PROXY_PORT="$PORT" \
       CLAUDE="$WORK/bin/claude" CLAUDEI_SKIP_PERMISSIONS=0

echo "== session pool =="

# --- P1/P2: a second session exiting must not stop a first session's proxy ----
STUB_SLEEP=12 bash "$REPO/claudei.sh" >"$WORK/s1.log" 2>&1 &
S1=$!
# Wait for the proxy rather than guessing: the launcher sleeps 2s after start.
i=0; while [ "$i" -lt 60 ] && ! port_open; do i=$((i + 1)); sleep 0.2; done

chk "P0 first session brought the proxy up" 'port_open'

bash "$REPO/claudei.sh" >"$WORK/s2.log" 2>&1
chk "P1 second session reused the running proxy" 'grep -q "reusing" "$WORK/s2.log"'
chk "P2 proxy survives the second session exiting" 'port_open'
# Matches the leaving-it-up message specifically. "other session" alone also
# appears in the restart branch, so it stayed green under a sabotage that removed
# this path entirely — a guard that passes without the behaviour is not a guard.
chk "P3 second session said why it left the proxy up" 'grep -q "Leaving proxy" "$WORK/s2.log"'

wait "$S1" 2>/dev/null
chk "P4 proxy stops once the last session exits" '! port_open'

# --- P5: a stale lease must not pin the proxy open forever -------------------
# A session killed with SIGKILL leaves its lease file behind. The next exit has
# to notice the pid is gone and clean up, or the proxy outlives every session.
SESSION_DIR="$WORK/tmp/deepseek-in-claude-$(id -u)/sessions"
mkdir -p "$SESSION_DIR"
# A pid that cannot be running: 0 is never a user process, and the launcher
# treats any non-live pid the same way.
: >"$SESSION_DIR/999999"
bash "$REPO/claudei.sh" >"$WORK/s3.log" 2>&1
chk "P5 stale lease does not keep the proxy alive" '! port_open'
chk "P6 stale lease file was pruned" '[ ! -e "$SESSION_DIR/999999" ]'

echo ""
if [ "$FAILS" -ne 0 ]; then
  echo "session pool guard FAILED"
  exit 1
fi
echo "session pool guard passing"
exit 0
