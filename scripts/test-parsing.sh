#!/usr/bin/env bash
# Unit tests for the pure parsing helpers in proxy.mjs.
#
# proxy.mjs starts a server on import, so it cannot be imported from a test.
# Instead the three pure functions are sliced out of the real file and run
# against a table of cases — if a slice comes back empty or malformed the
# generated module fails to parse and the test exits non-zero, so the
# extraction cannot rot silently into a vacuously passing test.
#
# Usage: scripts/test-parsing.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

{
  echo 'const CONFIG_PATH = "test.yml";'
  sed -n '/^function loadYaml/,/^}$/p' "$REPO/proxy.mjs"
  sed -n '/^const normalizeModel/,/^};$/p' "$REPO/proxy.mjs"
  echo 'const REDIR_MAP = { haiku: 1, sonnet: 1, opus: 1, fable: 1 };'
  echo 'const FAMILY_KEYS = Object.keys(REDIR_MAP);'
  sed -n '/^function familyOf/,/^}$/p' "$REPO/proxy.mjs"
  cat <<'CASES'

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

for (const fn of [loadYaml, normalizeModel, familyOf]) {
  if (typeof fn !== "function") { console.error("extraction failed"); process.exit(2); }
}

console.log("-- loadYaml: quoted keys are still keys --");
eq("bare key", loadYaml("port: 8016").port, 8016);
eq("double-quoted key", loadYaml('"port": 8016').port, 8016);
eq("single-quoted key", loadYaml("'port': 8016").port, 8016);
eq("quoted nested key", loadYaml('redir:\n  "haiku": deepseek-v4-flash').redir.haiku, "deepseek-v4-flash");
eq("quoted key and value", loadYaml('"sentinel": "abc"').sentinel, "abc");
eq("booleans unaffected", loadYaml("fallback: false").fallback, false);
eq("inline comment stripped", loadYaml("port: 8016  # listen here").port, 8016);

console.log("-- loadYaml: warn on broken settings, stay quiet on unsupported YAML --");
const warnings = (text) => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try { loadYaml(text); } finally { console.error = orig; }
  return errs.length;
};
eq("sequence is quiet", warnings("redir:\n  - haiku\n  - sonnet\n"), 0);
eq("sequence of maps is quiet", warnings("tools:\n  - name: a\n"), 0);
eq("document markers are quiet", warnings("---\nport: 8016\n...\n"), 0);
eq("valid config is quiet", warnings("port: 8016\nredir:\n  haiku: deepseek-v4-flash\n"), 0);
eq("missing colon warns", warnings("port 8016\n") > 0, true);
eq("unsupported block scalar warns", warnings("note: |\n  some text\n") > 0, true);

console.log("-- familyOf: segment match, not substring --");
eq("claude-sonnet-4-5", familyOf("claude-sonnet-4-5"), "sonnet");
eq("claude-opus-5", familyOf("claude-opus-5"), "opus");
eq("claude-haiku-4-5-20251001", familyOf("claude-haiku-4-5-20251001"), "haiku");
eq("claude-fable-5", familyOf("claude-fable-5"), "fable");
eq("us.anthropic.claude-sonnet-4-5-v1:0", familyOf("us.anthropic.claude-sonnet-4-5-v1:0"), "sonnet");
eq("bare family name", familyOf("opus"), "opus");
eq("opusculum-1 is not opus", familyOf("opusculum-1"), null);
eq("sonnetta is not sonnet", familyOf("sonnetta"), null);
eq("deepseek id has no family", familyOf("deepseek-v4-flash"), null);

console.log("-- normalizeModel: shorthand only, never blind prefixing --");
eq("real id passes through", normalizeModel("deepseek-v4-flash"), "deepseek-v4-flash");
eq("v4-flash", normalizeModel("v4-flash"), "deepseek-v4-flash");
eq("v4flash", normalizeModel("v4flash"), "deepseek-v4-flash");
eq("v4-pro", normalizeModel("v4-pro"), "deepseek-v4-pro");
eq("v4pro", normalizeModel("v4pro"), "deepseek-v4-pro");
eq("future v5-pro", normalizeModel("v5-pro"), "deepseek-v5-pro");
eq("typo is not prefixed", normalizeModel("gpt-4"), "gpt-4");
eq("anthropic id is not prefixed", normalizeModel("claude-haiku-4-5"), "claude-haiku-4-5");

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
CASES
} > "$WORK/parsing.test.mjs"

node "$WORK/parsing.test.mjs"
