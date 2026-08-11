# Probe findings — Claude Code ↔ Anthropic vs DeepSeek through proxy.mjs

Date: 2026-08-11. Claude Code 2.1.227, node 26, proxy.mjs @ HEAD (a1f04bb).
Harness: `scripts/observe.mjs` (sniff proxy, `--target anthropic|deepseek`) + `scripts/probe.mjs`
(claude -p matrix runner). Captures: `logs/probe/*.jsonl` (full request/response/usage per call).

## 1. Handshake (what the CLI actually does)

```
HEAD /api/hello          → 200  auth probe at CLI startup, no body
POST /v1/messages?beta=true → SSE stream, one call per turn
```

- Print mode (`claude -p`) never calls `/v1/models` and never calls `count_tokens`.
  `count_tokens` + `/v1/models` appear in interactive sessions only.
- Auth: CLI sends its own credential; proxy must pass auth through untouched (Anthropic
  target) or substitute `x-api-key` (DeepSeek target, `proxy.mjs:403-404`).
- `?beta=true` query param rides along on `/v1/messages` — DeepSeek accepts it.

## 2. Anthropic baseline (truth set, 15 runs: 3 models × 5 efforts)

| model | max_tokens | effort sent | thinking | cache |
| --- | --: | --- | --- | --- |
| claude-opus-5 | 64000 | honored (low→max all pass) | `adaptive` | cc then cr (1h ephemeral) |
| claude-sonnet-5 | 64000 | honored (all 5) | `adaptive` | cc then cr |
| claude-haiku-4-5 | 32000 | **omitted** (CLI sends none) | `enabled` | cc then cr |

- `output_config.effort` is the key (`effort` top-level does not exist).
- `system`: 3 blocks, last 2 with `cache_control` breakpoints (12–31 KB).
- `tools`: 218–250 definitions, ~360 KB (≈86% of a 421 KB request).
- Cache: first call `cache_creation_input_tokens` (~127–169 K), subsequent calls
  `cache_read_input_tokens` (hit, same 1h window). Cache tokens dominate billing.

## 3. DeepSeek direct probes (raw API, minimal bodies — no tools)

Both `deepseek-v4-flash` and `deepseek-v4-pro`, through observe deepseek target:

| parameter | values tested | result |
| --- | --- | --- |
| `max_tokens` | 2048, 8192, 16384, 32000, 64000 | **all OK** — silently clamped, no error |
| `thinking.type` | omitted, `adaptive`, `enabled`, `disabled` | **all OK** — no rewrite needed |
| `output_config.effort` | low, medium, high, xhigh, max | **all OK** — no rewrite needed |
| context window | ~16K → ~256K tokens (801 KB) | OK at 256K; automatic `cache_read_input_tokens` (up to 91 K) reported **without** `cache_control` |
| `GET /v1/models`, `GET /models` on Anthropic-compat base | — | 404 — no models endpoint on `/anthropic` |
| `GET /models` on OpenAI base | — | OK — 2 models, fields only `id/object/owned_by` |

Implication: **the `effort` bridge (`proxy.mjs:363-367,393-396`) is unnecessary** — DeepSeek
accepts all five Claude Code effort levels natively. It is a payload mutation that does nothing
for these models (keep only as an opt-in config override for other models).

## 4. THE blocker — tool schema drift

Every request redir'd to DeepSeek dies with:

```
400 invalid_request_error:
Failed to deserialize the JSON body into the target type: tools[249]:
unknown variant `advisor_20260301`, expected `web_search_20250305` or `web_search_20260209`
```

- Claude Code 2.1.227 appends a server tool `{"type":"advisor_20260301","name":"advisor","model":"claude-opus-5"}`
  (index 249, ~28 KB). DeepSeek's Anthropic-compat schema only knows `web_search_20250305` /
  `web_search_20260209` — the newer variant fails deserialization of the **whole request**.
- Verified uniform: all 15 redir'd matrix combos → same 400, before model/effort/thinking matter.
- Validated fix: **drop the `advisor_20260301` tool → 200 OK**, full payload (249 tools,
  `thinking: adaptive`, `max_tokens: 64000`, cache breakpoints) accepted, real usage returned.
  Renaming `type` to `web_search_20260209` still fails (`name: "advisor"` is also an unknown
  variant) — dropping is the correct move; DeepSeek does not implement this tool.

## 5. Proxy rewrite audit (`proxy.mjs`)

| mutation | verdict |
| --- | --- |
| model id display→real / redir map (386-392) | required |
| `x-api-key` substitution, `authorization` drop (403-404) | required |
| `/v1/models` merge (448-486) | required (user-sanctioned) |
| `count_tokens` answered locally bytes/4 (218, 374-378) | tolerable; real usage available in SSE and thrown away |
| effort bridge medium→high, xhigh→max (363-367, 393-396) | **unnecessary** for v4 models — remove default |
| `max_tokens` / `thinking` / `cache_control` / `context_management` | pass-through correct — DeepSeek accepts |
| `tools` array | **untouched — the bug.** Needs unknown-variant drop |

## 6. Observability gap

`proxy.mjs` streams the upstream response raw (`proxy.mjs:425-427`) — the SSE `usage`
(real `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) is never
parsed. `log_proxy.mjs:207-240` already contains a working SSE usage decoder. Without it,
the context-size problem (cache tokens dominate) is invisible.

## 7. Fix spec

1. **Tool schema compat (blocker).** In the `handleDeepSeek` rewrite block (`proxy.mjs:381-400`),
   drop tools whose `type` fails DeepSeek deserialization. Runtime-driven, not hardcoded:
   - On 400 `invalid_request_error` with `unknown variant` in the message, parse the offending
     tool index from the error text, drop that tool, retry once. (Error text gives both the
     variant and the expected set — self-adapting to future CLI/API drift.)
   - Default policy additionally drops `advisor_*` / unknown server-tool variants preflight
     (zero-latency common case); the retry path covers anything else.
   - Anthropic target (`forwardToAnthropic`) stays untouched — never strip for Anthropic.
2. **Remove effort bridge default** (`proxy.mjs:363-367,393-396`): pass effort through;
   keep `effort:` config block as override for other model families. Update `config.example.yml`
   comment (lines 26-32) accordingly.
3. **Observability.** Port SSE usage extraction (`log_proxy.mjs:207-240`) into `proxy.mjs`:
   parse `message_start`/`message_delta` usage, log per-request line (method, path, status,
   ms, real input/cache/output tokens) to `logs/proxy-usage.jsonl` (or `--debug` stream).
   Feeds the original context-size investigation with real numbers.
4. **`count_tokens`** (`proxy.mjs:374-378`): keep bytes/4 as fallback; optionally answer from
   last observed usage when available. Low priority.
5. **Context window** (`claudei.sh:20`): 256K verified working with automatic caching; the 1M
   claim is unverified — leave the env override but document 256K as the measured floor.
6. **Config precedence**: runtime probe (retry-derived) > `config.yml` > defaults — same
   precedence chain as today (`proxy.mjs:16`).

## 8. Validation summary

- 15/15 Anthropic baseline runs OK (truth set captured).
- 15/15 proxy→DeepSeek runs → 400, same root cause.
- Fix hypothesis proven: dropping `advisor_20260301` → 200 with real usage.
- DeepSeek param surface (max_tokens/thinking/effort/context) fully tolerant — only tool
  schema is the incompatibility.
