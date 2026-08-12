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
- Auth: CLI sends its own credential; the proxy substitutes `x-api-key` on the DeepSeek
  target (`proxy.mjs:813-814`). On the Anthropic target it passes the `Authorization`
  header through untouched *except* for the sentinel swap — and, since 2026-08-12, drops
  any client-supplied `x-api-key` there (`applyAnthropicAuth`, see "Header precedence at
  `api.anthropic.com`" in the second document below for the measurement that forced it).
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
| `x-api-key` substitution, `authorization` drop, DeepSeek leg (813-814) | required |
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

---

# Model discovery, context window, and auth — Claude Code 2.1.228

Date: 2026-08-11. Method: decompiled string/code extraction from the `claude` binary
(2.1.228) plus a sniffing proxy in front of `api.anthropic.com` running real `claude -p`
calls. Every claim below is either quoted from the binary or reproduced by a sniffer run.

## 1. Gateway model discovery

```js
eTs()  // discovery enabled?
  requires CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, provider === "firstParty",
           a non-Anthropic ANTHROPIC_BASE_URL
$vu()  // the fetch
  GET ${ANTHROPIC_BASE_URL}/v1/models?limit=1000
  auth: Authorization: Bearer $ANTHROPIC_AUTH_TOKEN, else x-api-key: <api key>
  if neither is present it returns early — no fetch at all
  schema: { id: string, display_name?: string }  (.strip() — extra fields discarded)
  filter: /(claude|anthropic)/i.test(model.id)
  cache:  ~/.claude/cache/gateway-models.json, keyed by baseUrl
picker entry: { value: id, label: display_name || id, description: "From gateway" }
```

Captured payload, 2026-08-12, stub upstream on `127.0.0.1:8990`, `claude -p` twice — once
with `~/.claude/cache/gateway-models.json` deleted, once with it present:

```http
GET /v1/models?limit=1000
authorization: Bearer <ANTHROPIC_AUTH_TOKEN>      # or x-api-key when only the key is set
anthropic-version: 2023-06-01
user-agent: claude-code/2.1.228
accept: */*
```

No request body, no `anthropic-beta`. The reply was a normal model list whose entries
carried `type`, `created_at` and a junk `extra_field` alongside `id`/`display_name`; what
landed on disk was only:

```json
{ "baseUrl": "http://127.0.0.1:8990", "fetchedAt": 1786553772389,
  "models": [ { "id": "claude-deepseek-v4-flash[1m]", "display_name": "DeepSeek V4 Flash" } ] }
```

**Both runs fetched.** The cache did not suppress the request on the warm run, so it is a
seed the picker can fall back on, not a gate in front of the fetch — which is why a stale
`gateway-models.json` only ever shows up as a *wrong* list, never as a missing one, and why
the launcher can purge it unconditionally without costing a round trip.

Consequences:

- The id filter is why DeepSeek models are served as `claude-deepseek-*`.
- The schema is stripped, so a proxy cannot ship context-window metadata with a model.
- Discovery only *appends*. Claude Code's own bundled catalog rows (Opus 4.7, Sonnet 4.6, …)
  are not affected by anything the proxy returns.
- `CLAUDE_CODE_USE_GATEWAY=1` makes `Vn()` return `"gateway"` instead of `"firstParty"`,
  which fails the `eTs()` precondition — it *disables* discovery.

## 2. Context window for an unknown model

```js
hEu(model) {
  if (/\[1m\]/i.test(model)) return 1_000_000;      // no catalog lookup
  ...
  const n = CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (n > 0 && !model.startsWith("claude-")) return n;
  return 200_000;
}
```

- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is skipped for every id starting with `claude-` — which
  the discovery filter forces on us. The two mechanisms are mutually exclusive.
- The `[1m]` marker is a pure regex test, so it works for a model Claude Code has never
  heard of. It also makes `W6()` skip the `unknown-model` branch, suppressing the
  "not a model this version recognizes" notice.
- `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` only changes the window
  *source* label. The assumed window stays 200k.
- `--autocompact N` (settings branch of `W6`) wins over everything: with `--autocompact 350k`
  a 1M model reports 350k.

Verified: `claude -p "/context" --model 'claude-deepseek-v4-flash[1m]'` reports
**57.2k / 1m (6%)**.

## 3. Auth: discovery vs. your claude.ai login

Three sniffer runs, same `claude -p` invocation, only the auth env var changed:

| Env | `/v1/models` fetched | `/v1/messages` |
| --- | --- | --- |
| `ANTHROPIC_AUTH_TOKEN=<sentinel>` | yes (`Bearer <sentinel>`) | **401 Invalid bearer token** |
| none (subscription OAuth) | no — discovery skipped | 200 (`Bearer sk-ant-oat01-…`) |
| `ANTHROPIC_API_KEY=<bogus>` | yes (`x-api-key`) | 401 — the key overrides the login too |

So discovery needs an auth env var, and any auth env var takes precedence over the
claude.ai login for every request. The proxy's credential bridge closes the gap: it swaps
the sentinel for the CLI's own OAuth access token and appends the `oauth-2025-04-20` beta.
Verified end-to-end — with the bridge, `/v1/models` returns the real 12-model merged list
and `--model claude-opus-5` answers 200 in the same session that reaches DeepSeek.

Scope of that verification: the **swap** is proven. The **refresh grant is not** — probing it
with a deliberately invalid refresh token returned `429 rate_limit_error`, so the accepted
content-type was never established and no successful rotation has ever run. That is why
`--oauth-refresh` is opt-in and the proxy is read-only by default: the grant rotates the
refresh token, and a mis-persisted rotation would break the real CLI's own sessions.

OAuth constants used by the refresh grant (from the binary):
`TOKEN_URL=https://platform.claude.com/v1/oauth/token`,
`CLIENT_ID=9d1c250a-e61b-44d9-88ed-5944d1962f5e`.

## 4. Header precedence at `api.anthropic.com` — added 2026-08-12

Same sniffing harness, one header changed at a time, on `POST /v1/messages`:

| Headers sent | Result |
| --- | --- |
| `Authorization: Bearer <sentinel-swapped OAuth token>` + bogus `x-api-key` | **401** |
| the same `Authorization`, `x-api-key` removed | **200** |

`api.anthropic.com` therefore honours `x-api-key` in preference to the `Authorization`
bearer — the same precedence the `ANTHROPIC_API_KEY=<bogus>` row of §3's three-run table
records against the claude.ai login, now isolated to the header rather than the env var.
The damaging case is not the 401: a *bogus* key fails loudly, but a **valid** exported key
in that slot authenticates and bills every Anthropic request to API credits while the
credential bridge looks like it is working. Claude Code sends both headers whenever
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are both set, which is what a launcher
inherits from a shell that exports the key. Hence the two fixes of the same date:
`claudei.sh` unsets both variables before launching the CLI, and `applyAnthropicAuth`
drops `x-api-key` on the Anthropic leg — below the `--no-auth-bridge` escape hatch, above
the sentinel gate. Guarded by `scripts/test-auth-bridge.sh`.

## 5. What the gateway protocol actually specifies — added 2026-08-12

Source: Anthropic's own documentation, which turns out to specify this feature in full.
Everything in §1–§2 was reverse-engineered from the binary before we found it. The docs
confirm the mechanics and correct two conclusions we had drawn from them.

- <https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery>
- <https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id>

### 5.1 The payload cannot carry a context window

The response schema is exactly two fields, and this is the documented contract, not an
implementation detail we might grow out of:

> Claude Code reads `id` and the optional `display_name` from each entry in the response's
> `data` array.

There is no field for context window, max output tokens, or capabilities. The docs are also
explicit that the provider-capability variables do not fill the gap:

> The `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` variables declare model
> capabilities only in the provider configurations […] They have no effect behind an
> `ANTHROPIC_BASE_URL` gateway.

So a gateway describes *which* models exist and nothing about *what they are*. Every other
model property is client-side, which is why the window has to be solved with environment
variables rather than by enriching what `serveModels` returns.

### 5.2 The id filter loosened, and that unblocks the window

§1 records the filter as the reason DeepSeek models are named `claude-deepseek-*`, and §2
records that `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is skipped for exactly that prefix — the two
mechanisms read as mutually exclusive. They are not, as of 2.1.223:

> Claude Code keeps an entry when its `id` contains `claude` or `anthropic` anywhere in the
> string, matched case-insensitively […] Provider-prefixed IDs such as
> `vertex_ai/claude-sonnet-4-6` […] pass the filter. Before v2.1.223, Claude Code kept an
> entry only when its `id` began with `claude` or `anthropic`.

The window rule keys on `startsWith("claude-")`, the filter on *contains*. An id such as
`deepseek/claude-deepseek-chat` satisfies the filter without triggering the prefix rule, and
the docs confirm that is the supported case:

> If the ID doesn't start with `claude-` or contain `[1m]`, in any casing, and Claude Code
> can't resolve it to a Claude model, the variable applies directly and proactive compaction
> continues at the declared window.

That is the only combination that yields a *correct* window with proactive compaction
intact. The alternatives both degrade: `[1m]` claims a flat 1M regardless of the model's
real window, and a `claude-` prefix needs `DISABLE_COMPACT`, which turns compaction off
entirely. ADR-0001 chose its ids under the old filter and should be revisited against this.

Note the scope of `CLAUDE_CODE_MAX_CONTEXT_TOKENS`: it is one value for the whole session,
not per model. Declaring DeepSeek's window necessarily misdeclares the Anthropic models in
the same session, so this is a trade to make deliberately.

### 5.3 The cache lists models with no fetch and no credential

Measured 2026-08-12 with `sniffer.sh`, which is a raw tap that neither bridges credentials
nor merges models. `~/.claude/cache/gateway-models.json` was hand-written, the discovery
flag set, and no auth environment variable exported at all:

```
/model  ->  7. DeepSeek Chat   From gateway
            8. DeepSeek Chat   From gateway
capture ->  2 exchanges, GET /v1/models: NONE
```

The picker's list comes from `Qln()`, which reads the cache file and never fetches; the
credential check lives only in `$vu()`, the refresher. So listing needs the flag, a
non-Anthropic `ANTHROPIC_BASE_URL`, and a cache `baseUrl` byte-identical to it (compared
with `!==`) — and no credential. This does not contradict §1's "both runs fetched": the
fetch still happens whenever a credential is present, and the docs say the cache is
"refreshed on each startup". A seeded file is therefore authoritative only for as long as
no authenticated discovery run overwrites it.

Two limits found the same way. The label is `display_name || id` with no suffix logic, so
two variants of one model render identically unless the distinction is baked into
`display_name`. And seeding does not register a context window — the "not a model this
version recognizes" notice persists, because that path never consults the cache.

### 5.4 Other documented facts worth not rediscovering

- Discovery is `GET /v1/models?limit=1000` with a **3-second timeout**, and **any redirect
  is treated as failure** so the credential cannot leak to a redirect target. Serving the
  endpoint anywhere but directly at the base URL fails discovery silently.
- The credential is **one header, not both**: `ANTHROPIC_AUTH_TOKEN` as a bearer when set,
  otherwise the resolved API key as `x-api-key`. Inference requests send both, so a gateway
  that authenticates `/v1/models` must accept `x-api-key` too.
- A discovered id is **skipped when it matches a picker row already**, and an explicit id is
  folded into a built-in row when both resolve to the same model. Serving `claude-sonnet-5`
  would collapse into the `sonnet` row rather than adding one.
- `availableModels` bounds what discovery may add; `modelOverrides` keys **must be real
  Anthropic model ids** ("Unknown keys are ignored"), so it cannot register an invented id —
  it can only redirect a genuine one at a different upstream string.
- `ANTHROPIC_CUSTOM_MODEL_OPTION` skips id validation entirely and needs no flag, no cache
  and no credential, but is **a single entry**. An id embedding a family name also disables
  that family's `availableModels` wildcard.
- The `claude gateway` command is the enterprise auth/telemetry broker (Postgres, OIDC, JWT,
  CIDR policy). Connecting to one makes `Vn()` return `"gateway"`, which fails `eTs()` — it
  **disables** model discovery. Same word, opposite feature.
