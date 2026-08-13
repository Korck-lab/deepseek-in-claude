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
  sed -n '/^function hasImageBlock/,/^}$/p' "$REPO/proxy.mjs"
  sed -n '/^function rewriteVision/,/^}$/p' "$REPO/proxy.mjs"
  sed -n '/^function restoreClientModel/,/^}$/p' "$REPO/proxy.mjs"
  cat <<'CASES'

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

for (const fn of [loadYaml, normalizeModel, familyOf, hasImageBlock, rewriteVision, restoreClientModel]) {
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

console.log("-- hasImageBlock: placement coverage --");
const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
const body = (obj) => Buffer.from(JSON.stringify(obj));
eq("image in messages[].content", hasImageBlock(body({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }, img] }] })), true);
eq("image in context[]", hasImageBlock(body({ model: "m", context: [img] })), true);
eq("image in tool_result.content", hasImageBlock(body({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", content: [img] }] }] })), true);
eq("nested arrays", hasImageBlock(body({ a: [[{ type: "text" }], [img]] })), true);

console.log("-- hasImageBlock: negatives --");
eq("no image anywhere", hasImageBlock(body({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })), false);
eq("prose mentions image", hasImageBlock(body({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "please describe this image" }] }] })), false);
eq("image word in tool type", hasImageBlock(body({ model: "m", tools: [{ type: "image_editor" }] })), false);
eq("non-JSON body", hasImageBlock(Buffer.from("not json")), false);
eq("empty body", hasImageBlock(Buffer.alloc(0)), false);

console.log("-- rewriteVision: model + effort, rest untouched --");
const src = { model: "claude-deepseek-v4-flash[1m]", max_tokens: 100, stream: true, output_config: { effort: "high" }, messages: [{ role: "user", content: "x" }] };
const rw = rewriteVision(body(src), "claude-opus-5", "low", "claude-deepseek-v4-flash[1m]");
const out = JSON.parse(rw.body.toString("utf8"));
eq("model swapped", out.model, "claude-opus-5");
eq("effort forced", out.output_config.effort, "low");
eq("max_tokens untouched", out.max_tokens, 100);
eq("stream untouched", out.stream, true);
eq("messages untouched", JSON.stringify(out.messages), JSON.stringify(src.messages));
eq("clientModel echoed", rw.clientModel, "claude-deepseek-v4-flash[1m]");
eq("absent output_config gains effort", JSON.parse(rewriteVision(body({ model: "m" }), "v", "low", "m").body.toString("utf8")).output_config.effort, "low");

// The vision redirect answers on the Anthropic leg, whose upstream host is a bare
// literal with no override (see scripts/test-auth-bridge.sh), so the echo is
// asserted here on the same function that leg calls rather than through a server.
console.log("-- restoreClientModel: the vision redirect echoes the display id --");
const startEvent = (m) => `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"${m}","role":"assistant"}}\n\n`;
eq(
  "opus-5 rewritten to the deepseek display id",
  restoreClientModel(startEvent("claude-opus-5"), "claude-deepseek-v4-flash[1m]", "claude-opus-5"),
  startEvent("claude-deepseek-v4-flash[1m]")
);
eq(
  "prose naming the vision model is untouched",
  restoreClientModel('data: {"text":"I used claude-opus-5 for this"}', "claude-deepseek-v4-flash[1m]", "claude-opus-5"),
  'data: {"text":"I used claude-opus-5 for this"}'
);
eq("identical ids are a no-op", restoreClientModel(startEvent("claude-opus-5"), "claude-opus-5", "claude-opus-5"), startEvent("claude-opus-5"));

console.log(fails ? `\n${fails} failing` : "\nall passing");
process.exit(fails ? 1 : 0);
CASES
} > "$WORK/parsing.test.mjs"

node "$WORK/parsing.test.mjs"
