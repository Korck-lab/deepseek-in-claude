#!/usr/bin/env bash
# Guard for ADR-0002 — the Anthropic leg must authenticate with the user's Claude
# OAuth session and never with an Anthropic API key. Following ADR-0001's
# convention this suite is the named guard for that ADR and must not be deleted
# as redundant: every case here exists because a credential the user already
# exported was measured winning over the sentinel (ADR-0002 "Consequences").
#
# Two halves, because the invariant has two independent holes:
#
#   A. proxy.mjs — the header object handed to https.request on the Anthropic leg
#      must carry no client-supplied x-api-key. api.anthropic.com prefers x-api-key
#      over the Authorization bearer, so a valid exported key authenticates and
#      bills every Anthropic request to API credits while the bridge looks like it
#      is working. Stripping it is load-bearing, not hygiene.
#   B. claudei.sh — the launched CLI must inherit neither ANTHROPIC_API_KEY nor a
#      caller-supplied ANTHROPIC_AUTH_TOKEN, so the client cannot send either in
#      the first place.
#
# Half A is a slice-extraction unit suite, on the precedent of test-parsing.sh and
# for a sharper reason: UPSTREAM is a bare literal ("api.anthropic.com") with no
# env or config override, so no running-server test can observe what reaches the
# Anthropic leg without either a source seam or real authenticated traffic. The
# two functions are sliced out of the real proxy.mjs and composed in the same
# order production composes them — applyAnthropicAuth(forwardHeaders(...)) — so a
# strip that lands in the wrong function cannot satisfy this suite. If either
# slice comes back empty the generated module fails its own typeof guard and the
# suite exits 2, so the extraction cannot rot into a vacuous pass.
#
# Half B drives the real claudei.sh against a stub CLI that dumps its environment,
# inside an isolated HOME/TMPDIR/PORT so it cannot touch the user's live session.
# It asserts what the CLI receives, not how the script spells it.
#
# Usage: scripts/test-auth-bridge.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

FAILS=0
chk() { # chk NAME CONDITION
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; FAILS=$((FAILS + 1)); fi
}

# --- A. the Anthropic-leg header transform -----------------------------------

{
  echo 'let AUTH_BRIDGE = true;'
  echo 'const AUTH_SENTINEL = "sentinel-value";'
  echo 'const OAUTH_BETA = "oauth-2025-04-20";'
  echo 'let OAUTH_TOKEN = "real-oauth-token";'
  echo 'async function anthropicAccessToken() { return OAUTH_TOKEN; }'
  echo 'function warnOnce() {}'
  sed -n '/^function forwardHeaders/,/^}$/p' "$REPO/proxy.mjs"
  sed -n '/^async function applyAnthropicAuth/,/^}$/p' "$REPO/proxy.mjs"
  cat <<'CASES'

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

for (const fn of [forwardHeaders, applyAnthropicAuth]) {
  if (typeof fn !== "function") { console.error("extraction failed"); process.exit(2); }
}

// Exactly what forwardToAnthropic (proxy.mjs) and serveModels hand to
// https.request: the client's headers through forwardHeaders, then through the
// bridge. Asserting on the composition means a strip placed in either function
// satisfies the suite and a strip placed in neither cannot.
const NO_BODY = Buffer.alloc(0);
const anthropicLeg = (clientHeaders) => applyAnthropicAuth(forwardHeaders(clientHeaders, NO_BODY));

// What Claude Code actually sends when the user's shell exports ANTHROPIC_API_KEY
// alongside the sentinel: both credentials, measured 2026-08-12.
const bothCredentials = (bearer) => ({
  host: "localhost:8016",
  authorization: `Bearer ${bearer}`,
  "x-api-key": "sk-ant-leaked-key",
  "content-type": "application/json",
});

console.log("-- bridge on: the stray key never reaches api.anthropic.com --");
let h = await anthropicLeg(bothCredentials("sentinel-value"));
eq("sentinel swapped for the OAuth token", h.authorization, "Bearer real-oauth-token");
eq("x-api-key stripped", "x-api-key" in h, false);
eq("oauth beta appended", String(h["anthropic-beta"] ?? "").includes("oauth-2025-04-20"), true);

console.log("-- bridge on, credential lookup failed: still no key --");
// A missing OAuth token is an error to surface (the request 401s), never a
// reason to let API billing take over — so the strip must precede the
// early return that leaves the sentinel in place.
OAUTH_TOKEN = null;
h = await anthropicLeg(bothCredentials("sentinel-value"));
eq("sentinel left alone when no token", h.authorization, "Bearer sentinel-value");
eq("x-api-key stripped anyway", "x-api-key" in h, false);
OAUTH_TOKEN = "real-oauth-token";

console.log("-- bridge on, real bearer: passthrough of the bearer, not of the key --");
// The discriminating case for placement: the strip must sit between the
// AUTH_BRIDGE check and the sentinel gate. Behind the sentinel gate it would
// pass the two cases above and still leak the key for anyone whose shell
// exports a real ANTHROPIC_AUTH_TOKEN.
h = await anthropicLeg(bothCredentials("real-user-bearer"));
eq("non-sentinel bearer untouched", h.authorization, "Bearer real-user-bearer");
eq("x-api-key stripped", "x-api-key" in h, false);

console.log("-- key with no bearer at all: the bare-claude shape --");
// A shell that exports only ANTHROPIC_API_KEY makes the CLI send x-api-key and
// no Authorization at all, so the sentinel gate returns early on `undefined`.
// Nothing above pins this: a strip gated on headers.authorization, or moved
// below the gate, passes every case so far and leaks on this one.
h = await anthropicLeg({ host: "localhost:8016", "x-api-key": "sk-ant-leaked-key", "content-type": "application/json" });
eq("x-api-key stripped with no bearer present", "x-api-key" in h, false);
eq("no bearer invented", "authorization" in h, false);

console.log("-- --no-auth-bridge stays a genuine passthrough --");
// The documented escape hatch for someone bringing their own real Anthropic
// credential. Diagnostic, not a supported mode — but it must not lie.
AUTH_BRIDGE = false;
h = await anthropicLeg(bothCredentials("sentinel-value"));
eq("headers passed through", h.authorization, "Bearer sentinel-value");
eq("x-api-key preserved", h["x-api-key"], "sk-ant-leaked-key");
eq("no beta added", "anthropic-beta" in h, false);
AUTH_BRIDGE = true;

console.log("-- the DeepSeek leg is untouched --");
// handleDeepSeek sets its own x-api-key after forwardHeaders, so the strip must
// live on the Anthropic leg alone; a strip inside forwardHeaders would pass the
// cases above and break nothing visibly, but it moves the invariant to the wrong
// boundary.
const ds = forwardHeaders(bothCredentials("sentinel-value"), NO_BODY);
eq("forwardHeaders keeps x-api-key", ds["x-api-key"], "sk-ant-leaked-key");
eq("forwardHeaders drops host", "host" in ds, false);

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
CASES
} > "$WORK/auth-bridge.test.mjs"

echo "== proxy: Anthropic-leg headers =="
node "$WORK/auth-bridge.test.mjs"
NODE_STATUS=$?  # 1 = a case failed, 2 = a slice came back missing

# --- B. the launcher hands the CLI neither credential ------------------------

echo ""
echo "== launcher: exported credentials do not reach the CLI =="

PH="$WORK/proxy-home"
mkdir -p "$PH" "$WORK/bin" "$WORK/home/.claude/cache" "$WORK/tmpdir"
SENTINEL="sentinel-for-this-test"
printf 'sentinel: %s\n' "$SENTINEL" > "$PH/config.yml"
printf '0.0.0-test\n' > "$PH/VERSION"
# Has to stay alive, be recognisable to pid_is_proxy (which matches "proxy\.mjs"
# in the process command line), and serve the one endpoint the launcher seeds the
# model cache from. A stub rather than the real proxy because the real one needs
# a DeepSeek key and reaches the network; the contract under test is the
# launcher's, not the model list's.
cat > "$PH/proxy.mjs" <<'STUBPROXY'
import http from "node:http";
import fs from "node:fs";
// The flags the launcher chose, for L6. Written from the proxy rather than read
// off the process table because the launcher backgrounds it and nothing else in
// this fixture can see the argv.
if (process.env.CLAUDEI_PROXY_ARGV_DUMP) fs.writeFileSync(process.env.CLAUDEI_PROXY_ARGV_DUMP, process.argv.slice(2).join(" ") + "\n");
http.createServer((req, res) => {
  if (req.url === "/_proxy/deepseek-models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-deepseek-v4-flash[1m]", display_name: "DeepSeek V4 Flash", type: "model" }] }));
    return;
  }
  res.writeHead(404).end();
}).listen(Number(process.env.PORT) || 8899, "127.0.0.1");
STUBPROXY

# Two invocations reach this stub: `claude update` on the launcher's update
# check, then the real launch. Only the launch carries the environment under
# test, so the update call must not overwrite the dump.
cat > "$WORK/bin/claude" <<'STUB'
#!/bin/sh
if [ "${1:-}" = "update" ]; then exit 0; fi
env > "$CLAUDEI_ENV_DUMP"
exit 0
STUB
chmod +x "$WORK/bin/claude"

DUMP="$WORK/cli-env.dump"
ARGV_DUMP="$WORK/proxy-argv.dump"
CLAUDEI_PROXY_ARGV_DUMP="$ARGV_DUMP" \
ANTHROPIC_API_KEY="sk-ant-exported-by-the-user" \
ANTHROPIC_AUTH_TOKEN="real-bearer-exported-by-the-user" \
HOME="$WORK/home" \
TMPDIR="$WORK/tmpdir" \
DEEPSEEK_IN_CLAUDE_HOME="$PH" \
DEEPSEEK_PROXY_PORT=8899 \
CLAUDE="$WORK/bin/claude" \
CLAUDEI_SKIP_PERMISSIONS=0 \
CLAUDEI_ENV_DUMP="$DUMP" \
  bash "$REPO/claudei.sh" >"$WORK/launcher.log" 2>&1

# Separate from the credential assertions so a launcher that aborted early (no
# proxy, bad PROXY_HOME) reports as a broken fixture rather than as a pass.
chk "L0 launcher reached the CLI" '[ -f "$DUMP" ]'
if [ -f "$DUMP" ]; then
  chk "L1 ANTHROPIC_API_KEY absent from the CLI environment" '! grep -q "^ANTHROPIC_API_KEY=" "$DUMP"'
  # No auth variable at all is the point, not an omission. Claude Code disables
  # claude.ai connectors whenever it finds one, and since the launcher seeds the
  # model cache itself there is nothing left that needs one — the CLI's own
  # claude.ai OAuth bearer authenticates the Anthropic leg and the proxy passes
  # it through untouched. Asserting absence, not a value, is what keeps a future
  # edit from quietly reintroducing the sentinel and taking connectors with it.
  chk "L2 ANTHROPIC_AUTH_TOKEN absent from the CLI environment" '! grep -q "^ANTHROPIC_AUTH_TOKEN=" "$DUMP"'
  chk "L3 gateway discovery still enabled" 'grep -qx "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1" "$DUMP"'
  # The seeded cache is what puts DeepSeek in the picker now, so its absence is a
  # silent feature loss rather than a crash. HOME is the isolated fixture.
  chk "L4 launcher seeded the gateway model cache" '[ -s "$WORK/home/.claude/cache/gateway-models.json" ]'
  chk "L5 cache baseUrl matches the exported base URL exactly" 'grep -q "\"baseUrl\":\"http://localhost:8899\"" "$WORK/home/.claude/cache/gateway-models.json" 2>/dev/null'
  # ADR-0005. The launcher armed --fallback whenever config.yml said nothing about
  # it, which put silent leg-crossing — DeepSeek credits spent on a turn aimed at
  # Anthropic, reported under the Anthropic model — on every session of every
  # project through the pooled proxy. Crossing is opt-in now, and opting in is
  # config.yml's job, which the proxy reads itself.
  chk "L6 launcher passes no --fallback" '! grep -q -- "--fallback" "$ARGV_DUMP" 2>/dev/null'
else
  sed 's/^/      /' "$WORK/launcher.log" | tail -10
fi

echo ""
if [ "$NODE_STATUS" != "0" ] || [ "$FAILS" -ne 0 ]; then
  echo "auth-bridge guard FAILED (ADR-0002)"
  exit 1
fi
echo "auth-bridge guard passing (ADR-0002)"
exit 0
