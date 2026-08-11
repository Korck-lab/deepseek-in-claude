/**
 * probe.mjs — run claude -p through observe.mjs and print a matrix summary.
 *
 * Usage:
 *   node scripts/probe.mjs "say hello"           # default matrix
 *   PROBE_TARGET=anthropic|deepseek|proxy        # what upstream to hit
 *   PROBE_MODELS="opus sonnet haiku"             # --model values
 *   PROBE_EFFORTS="low medium high xhigh max"    # --effort values
 *
 * Targets:
 *   anthropic — observe.mjs on :8788, target anthropic (real API)
 *   deepseek  — observe.mjs on :8788, target deepseek (direct, model=deepseek-*)
 *   proxy     — proxy.mjs on :8016, DEEPSEEK_ANTHROPIC_BASE_URL=http://localhost:8788
 *               (observe deepseek target) so the full chain CLI->proxy->DeepSeek
 *               is captured
 *
 * Case tag -> /tmp/probe-tag before each run so observe.mjs names captures.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TAG_FILE = "/tmp/probe-tag";

const target = process.env.PROBE_TARGET ?? "anthropic";
const prompt = process.argv[2] ?? "say hello";
const models = (process.env.PROBE_MODELS ?? "opus sonnet haiku").split(/\s+/).filter(Boolean);
const efforts = (process.env.PROBE_EFFORTS ?? "low medium high xhigh max").split(/\s+/).filter(Boolean);
const extraArgs = (process.env.PROBE_EXTRA ?? "").split(/\s+/).filter(Boolean);

const baseUrl =
  target === "proxy" ? "http://localhost:8016"
  : target === "deepseek" ? "http://localhost:8788"
  : "http://localhost:8788";

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: baseUrl,
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
};

const results = [];
for (const model of models) {
  for (const effort of efforts) {
    const tag = `${target}_m${model}_e${effort}`;
    fs.writeFileSync(TAG_FILE, tag);
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", ...(model !== "default" ? ["--model", model] : []), "--effort", effort, ...extraArgs];
    const t0 = Date.now();
    const r = spawnSync("claude", args, { env, encoding: "utf8", timeout: 120000 });
    const ms = Date.now() - t0;
    const ok = r.status === 0;
    results.push({ tag, status: r.status, ms, ok, stderrTail: (r.stderr ?? "").split("\n").slice(-2).join(" ").slice(0, 300) });
    console.log(`${ok ? "OK " : "ERR"} ${tag} (${ms}ms)${ok ? "" : " " + (r.stderr ?? "").split("\n").slice(-1)[0]}`);
  }
}

console.log("\n=== summary ===");
for (const r of results) console.log(`${r.ok ? "OK " : "ERR"} ${r.tag} ${r.ms}ms`);
