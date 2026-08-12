<div align="center">

# deepseek-in-claude

**Run DeepSeek models in Claude Code — zero dependencies, zero protocol translation.**

DeepSeek models appear right in Claude Code's model picker. A small local proxy merges the Anthropic model list with DeepSeek's live model list, then forwards DeepSeek traffic to DeepSeek's Anthropic-compatible endpoint. Native Anthropic SSE in, native Anthropic SSE out.

Your Anthropic account keeps working: only DeepSeek-model traffic goes to DeepSeek, authenticated with your DeepSeek key. Everything else streams through to Anthropic on your normal claude.ai login.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](#requirements)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-orange.svg)](#features)
[![GitHub stars](https://img.shields.io/github/stars/Korck-lab/deepseek-in-claude)](https://github.com/Korck-lab/deepseek-in-claude)

---

**Install in 30 seconds**

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
```

Then start Claude Code and pick a model with `/model`.

</div>

## Features

- **Zero dependencies** — Node built-ins only (`node:http`, `node:https`, `node:fs`). No `npm install`, no build step, no lockfile, no supply chain.
- **DeepSeek in the model picker** — models are fetched live from the DeepSeek API (10-minute cache) and merged into Anthropic's model list, so `deepseek-v4-flash` and `deepseek-v4-pro` show up natively and you select them with `/model` like any other model.
- **No protocol translation** — DeepSeek exposes an Anthropic-compatible endpoint, so the proxy forwards native Anthropic SSE. There is no adapter layer to break or debug.
- **Key isolation** — `DEEPSEEK_API_KEY` is injected as `x-api-key` only on the DeepSeek leg, and `authorization` is dropped there. The Anthropic leg is authenticated by your Claude plan's OAuth session and nothing else: any `x-api-key` the client sends is dropped before the request leaves, because `api.anthropic.com` prefers that header over the bearer and a stray Anthropic API key would silently move your Anthropic spend onto metered API credits.
- **Anthropic auth stays yours, and connectors keep working** — `claudei.sh` sets no Anthropic auth environment variable at all. It writes Claude Code's gateway model cache itself, which is what the `/model` picker actually reads, so nothing has to be authenticated to get DeepSeek listed. Your claude.ai login authenticates Anthropic models as usual, and because no auth variable is set, claude.ai connectors stay enabled. See [Anthropic credential bridge](#anthropic-credential-bridge).
- **Real 1M context** — DeepSeek V4's window is 1M tokens, but Claude Code assumes 200k for any model it doesn't know. The proxy advertises the display id with Claude Code's `[1m]` marker, so the status line and auto-compact use the real window.
- **Effort passthrough** — DeepSeek V4 accepts all five Claude Code effort levels (`low|medium|high|xhigh|max`) natively, so nothing is rewritten by default. The `effort` block in `config.yml` is there to remap specific levels if you want.
- **Instant `count_tokens`** — Claude Code's housekeeping call is answered locally with a fast estimate instead of hitting an undocumented endpoint.
- **Model aliases** — short names (`v4flash`, `v4-flash`, `v4pro`, `v4-pro`) are normalized to their `deepseek-*` ids wherever you configure models.
- **Usage observability** — every DeepSeek request appends one JSON line with the real input/cache/output token counts to `logs/proxy-usage.jsonl`. Message content and auth headers are never logged.
- **Tool compat** — server tools Claude Code ships that DeepSeek's schema doesn't know (e.g. `advisor_20260301`) are dropped before forwarding; any other unknown variant is spliced out at runtime from the 400 error and retried.
- **Resilient** — if Anthropic's model list hiccups, the proxy still serves DeepSeek models. Your session is never bricked.

## Quickstart

One command installs the proxy into `~/.deepseek-in-claude`. A fresh install prompts for your API key — it opens the [key page](https://platform.deepseek.com/api_keys) and reads a hidden paste. Updates keep your existing `.env` untouched:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
```

Install somewhere else with `DEEPSEEK_IN_CLAUDE_HOME` — use an absolute path and `export` it first, or the variable won't reach the installer:

```bash
export DEEPSEEK_IN_CLAUDE_HOME="$HOME/.deepseek-in-claude"
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
```

Prefer to review the script first, or hit a terminal without a TTY (SSH without `-t`, CI)? Download it and run it — stdin stays yours, no pipe tricks:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh -o /tmp/deepseek-in-claude-install.sh
bash /tmp/deepseek-in-claude-install.sh
```

Manual setup, three commands:

```bash
git clone https://github.com/Korck-lab/deepseek-in-claude
cd deepseek-in-claude
cp .env.example .env        # paste your DEEPSEEK_API_KEY
node proxy.mjs
```

## Use it in Claude Code

```bash
ANTHROPIC_BASE_URL=http://localhost:8016 claude
```

Then run `/model` and pick `DeepSeek V4 Flash` (or `DeepSeek V4 Pro`). Anthropic models keep working in the same session — see [Anthropic credential bridge](#anthropic-credential-bridge) for how.

For the `/model` picker to list the DeepSeek models, Claude Code must run in gateway-discovery mode. That takes exactly two env vars beyond the base URL — the proxy ships `claudei.sh` which sets them, or set them yourself:

```bash
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
mkdir -p ~/.claude/cache
curl -fsS http://localhost:8016/_proxy/deepseek-models \
  | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(JSON.stringify({baseUrl:"http://localhost:8016",fetchedAt:Date.now(),models:JSON.parse(r).data})))' \
  > ~/.claude/cache/gateway-models.json
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
ANTHROPIC_BASE_URL=http://localhost:8016 claude
```

The `unset` is not tidiness. If your shell exports `ANTHROPIC_API_KEY`, Claude Code sends `x-api-key` *alongside* the bearer, and `api.anthropic.com` prefers the key — so a valid key would authenticate your Anthropic traffic and bill it to API credits while the credential bridge appeared to be working. Either variable also disables claude.ai connectors.

The `curl` writes the file Claude Code's `/model` picker reads its gateway rows from. Seeding it is what makes the auth variable unnecessary: the discovery *fetch* needs a credential, but the *reader* does not. The `baseUrl` field must match `ANTHROPIC_BASE_URL` byte for byte — Claude Code compares them with a string `!=`, so `localhost` versus `127.0.0.1` silently yields an empty list. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is still required: it gates the reader too. `claudei.sh` does all of this for you.

You can also skip discovery entirely and name the model directly — this needs no auth env var at all, and your claude.ai login is untouched:

```bash
ANTHROPIC_BASE_URL=http://localhost:8016 claude --model 'claude-deepseek-v4-flash[1m]'
```

### The `claudei.sh` launcher

`claudei.sh` is a convenience launcher: it updates the `claude` CLI, starts the proxy on `:8016` (reusing it if already running), and boots Claude Code with gateway discovery enabled.

It clears `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment it hands the CLI — either would move your Anthropic spend onto API credits, and either disables claude.ai connectors — and prints which of them it ignored, by name only, if you had either exported. It sets neither in their place: the DeepSeek rows come from the model cache it seeds from the proxy, not from an authenticated discovery fetch.

It stops the proxy again on the way out — including after Ctrl+C — and refuses to signal anything on the port that is not actually its own proxy, so a port inherited by some other process is left alone.

The `claude` invocation is plain and easy to customize — edit the launch line to suit your setup. Common tweaks:

- `--dangerously-skip-permissions` — skip permission prompts. On by default (that is the `i` in `claudei`); turn it off for a session with `CLAUDEI_SKIP_PERMISSIONS=0 ./claudei.sh`.
- `--autocompact N` — compaction threshold in tokens. Note that it also *caps* the reported context window: passing `--autocompact 350k` makes a 1M-window model report 350k. The launcher no longer sets it.
- `--append-system-prompt "..."` — extra instructions injected on every session.
- `--model <id>` — start on a specific model instead of the last-used default.

Any Claude Code flag or env var applies there. If you prefer not to use it, the three-command form above does the same job.

A few environment variables steer the launcher itself: `DEEPSEEK_IN_CLAUDE_HOME` (checkout location), `DEEPSEEK_PROXY_PORT` (listen port), `CLAUDE` (path to the CLI), and `CLAUDEI_SKIP_PERMISSIONS`. Its pid file, launch fingerprint and proxy log live together in a per-user `$TMPDIR/deepseek-in-claude-$UID` directory created mode `0700`.

`--fallback` is passed only when `config.yml` says nothing about `fallback:` — CLI flags win over the config file inside the proxy, so passing it unconditionally would override an explicit `fallback: false`.

Three env vars earlier versions of this launcher set have been dropped — they were measured against Claude Code 2.1.228 and do not do what their names suggest:

| Dropped | Why |
| --- | --- |
| `CLAUDE_CODE_USE_GATEWAY` | Puts Claude Code in cloud-gateway provider mode, which *disables* gateway model discovery (it requires the first-party provider). It works against the picker, not for it. |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Ignored for any model id starting with `claude-` — which the discovery filter forces on every DeepSeek display id. The `[1m]` marker does the job instead. |
| `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` | Only suppresses the unknown-model notice. The assumed window stays 200k either way. |

## How it works

Claude Code speaks Anthropic SSE. The proxy:

1. Intercepts `/v1/models` and merges the live Anthropic model list with the live DeepSeek list.
2. For every request whose `model` is a DeepSeek id, rewrites `authorization` → `x-api-key` and forwards to `$DEEPSEEK_ANTHROPIC_BASE_URL` (default `https://api.deepseek.com/anthropic`).
3. Streams everything else through to `api.anthropic.com`, with the body untouched and only the credential headers reworked — the sentinel bearer swapped for your OAuth token, any client-supplied `x-api-key` dropped.

### Why the picker shows `claude-deepseek-v4-flash[1m]`

Two Claude Code rules shape that id, and both are read off the id string alone:

- **`claude-` prefix.** Gateway model discovery drops any model whose id fails `/(claude|anthropic)/i` before it reaches the `/model` picker, so a bare `deepseek-v4-flash` is silently filtered out.
- **`[1m]` suffix.** For a model it has no catalog entry for, Claude Code assumes a 200k context window unless the id carries the `[1m]` marker, in which case it uses 1M. (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` cannot substitute — it is skipped for ids starting with `claude-`, so the prefix above rules it out.)

So the display id is `claude-deepseek-v4-flash[1m]`, labelled `DeepSeek V4 Flash` in the picker. The proxy rewrites it back to the real id (`deepseek-v4-flash`) on every upstream request — the marker is a Claude Code convention and would be rejected by DeepSeek. The bare display id and the real id both route to DeepSeek too.

The discovery result is cached by Claude Code under `~/.claude/cache/gateway-models.json` keyed by base URL. The base URL never changes here, so a list captured before a proxy change survives a restart — after changing the model list, delete that file (`claudei.sh` does it whenever it starts a proxy). Upgrading to the `[1m]` ids counts: without the purge the picker keeps showing the old ids and a 200k window.

### Anthropic credential bridge

**As of 2026-08-12 the default launch does not use this.** `claudei.sh` seeds the model cache instead and sets no auth variable, so your claude.ai login authenticates Anthropic models directly and connectors stay enabled. The bridge below remains supported for anyone who sets `ANTHROPIC_AUTH_TOKEN` deliberately.

The problem it solves: the discovery *fetch* only runs when Claude Code has an auth env var — `ANTHROPIC_AUTH_TOKEN` or an API key. But whichever one you set then takes precedence over your claude.ai login for *every* request, so a placeholder value makes real Anthropic models answer `401 Invalid bearer token`. Discovery and working Anthropic models look mutually exclusive.

The proxy resolves it. `ANTHROPIC_AUTH_TOKEN` is a sentinel; requests arriving with exactly that value get your real Claude Code OAuth access token substituted on the Anthropic leg, plus the `oauth-2025-04-20` beta that path requires. Any other `Authorization` value passes through untouched, so a real token is never rewritten. An `x-api-key` header is the exception: whenever the bridge is on it is dropped on the Anthropic leg regardless of the bearer, because Anthropic honours it in preference to the bearer and would bill the request to API credits instead of your plan.

Because presenting the sentinel is what buys a request your OAuth token, it is not a published constant: `scripts/install.sh` generates a random one per install and writes it to `sentinel:` in `config.yml`. That file is the single source of truth — the proxy reads it, and `claudei.sh` reads it back to hand Claude Code the matching value. Without a `config.yml`, both sides fall back to the historical `local-deepseek-proxy`, so old checkouts keep working.

- Credentials are read from the store the CLI itself uses — the macOS keychain item `Claude Code-credentials`, or `~/.claude/.credentials.json` elsewhere. They are never logged and never leave your machine except to `api.anthropic.com`.
- The store is read-only by default. When the access token expires, the proxy warns and Anthropic models 401 until something refreshes it — running `claude` normally does, and the proxy re-reads the store every 30s.
- `--oauth-refresh` (or `oauthRefresh: true`) lets the proxy run the OAuth refresh grant itself and write the rotated token back. It is opt-in on purpose: this is the only path that writes to the credentials the real CLI depends on, and it has not been exercised against the live token endpoint — a bad rotation costs you a `/login`. On macOS the write also passes the credential blob to `security` as a command-line argument, so it is briefly visible to `ps`; both argv-free routes that CLI offers silently truncate a payload this size, and a partial write is the worse failure.
- `--no-auth-bridge` (or `authBridge: false` in `config.yml`) turns the whole bridge off, including the `x-api-key` strip — it is a full passthrough for diagnosing with your own real Anthropic credential, which is exactly why the strip sits behind this switch and not in front of it. In sentinel mode without the bridge, Anthropic models 401.
- `ANTHROPIC_AUTH_SENTINEL` changes the sentinel value the proxy accepts (`sentinel:` in `config.yml` wins over it). `claudei.sh` reads the same variable, so exporting it keeps both sides in step; on a hand-rolled launch you have to set `ANTHROPIC_AUTH_TOKEN` to the same value yourself — a mismatch 401s every Anthropic request.

Don't want the proxy near your credentials at all? Skip discovery and pass `--model 'claude-deepseek-v4-flash[1m]'` — no auth env var, no sentinel, nothing to swap.

## Redirect & fallback

`--redir` routes Claude Code's default models to DeepSeek counterparts, so the built-in models keep working without you switching anything: `haiku` / `sonnet` / `opus` → `deepseek-v4-flash`, `fable` → `deepseek-v4-pro`.

`--fallback` retries the other way when the routed upstream fails — error, timeout, or `404` / `429` / `5xx`. A redirected `sonnet` call that DeepSeek fails falls back to real Anthropic `sonnet`; a direct Anthropic call that fails falls back to its DeepSeek counterpart. Same relation map, both directions, one retry.

```bash
node proxy.mjs --redir --fallback
```

Configure the whole thing in a local YAML file instead (`config.yml`, override with `--config`) — `--redir` becomes just the toggle:

```yaml
port: 8016
redir:
  haiku: deepseek-v4-flash
  sonnet: deepseek-v4-flash
  opus: deepseek-v4-flash
  fable: deepseek-v4-pro
fallback: true
debug: false
effort:
  medium: high
  xhigh: max
```

The `effort` block is opt-in: DeepSeek V4 accepts all five Claude Code effort levels natively, so nothing is remapped unless you list a level here.

## Configuration

All variables come from `.env` or real environment variables (real vars win). Only the key is required — for DeepSeek traffic.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Required. DeepSeek API key. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API base URL. |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro,deepseek-v4-flash` | Comma-separated model fallbacks shown in the picker. |
| `DEEPSEEK_ANTHROPIC_BASE_URL` | `$DEEPSEEK_BASE_URL/anthropic` | DeepSeek's Anthropic-compatible endpoint. |
| `PORT` | `8016` | Proxy listen port. |
| `UPSTREAM_TIMEOUT_MS` | `60000` | Idle-socket timeout for each upstream leg. Streaming resets it per chunk, so it bounds silence, not total duration. |
| `ANTHROPIC_AUTH_SENTINEL` | `sentinel:` in `config.yml`, else `local-deepseek-proxy` | The `ANTHROPIC_AUTH_TOKEN` value the credential bridge swaps for your real Claude Code OAuth token. |

Example:

```env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-flash,deepseek-v4-pro
```

Precedence: CLI args > `config.yml` > `.env` > defaults. Run `node proxy.mjs --help` for the full flag list.

## Inspecting payloads

Pass `--debug` (or `debug: true` in `config.yml`) to have the proxy append one JSON line per request to `/tmp/deepseek-proxy-payloads.jsonl` — method, path, status, latency, and routing shape (`model`, `tools`, `stream`, `max_tokens`, `effort`, `thinking`). Message content and auth headers are never logged.

```bash
node proxy.mjs --fallback --debug
```

Use it to confirm Claude Code is actually requesting `/v1/models`, which display id it sends, and what reaches DeepSeek:

```bash
tail -f /tmp/deepseek-proxy-payloads.jsonl
```

Real token accounting — input, cache-creation, cache-read, output — lands per request in `logs/proxy-usage.jsonl` (always on, no flags needed):

```bash
tail -f logs/proxy-usage.jsonl
```

For full request/response captures (every tool definition, the system prompt, SSE events) the repo ships `scripts/observe.mjs` (sniff proxy for either backend) and `scripts/probe.mjs` (a `claude -p` matrix runner); see `docs/probe-findings.md` for what a probe run looks like and what was learned from it.

## Security

- The API key lives only in `.env` (gitignored) and is sent only to the DeepSeek API.
- The credential bridge reads your Claude Code OAuth token from the CLI's own store and sends it only to `api.anthropic.com`, only in place of the sentinel. It is never logged, never written anywhere new, and never sent to DeepSeek. No client-supplied Anthropic API key is ever forwarded upstream while the bridge is on, so an `ANTHROPIC_API_KEY` left over in your shell cannot quietly take over the billing. Disable it with `--no-auth-bridge`, which restores that passthrough too.
- No code is piped from curl straight into a shell — `install.sh` only does a shallow git checkout of `main`, then runs the proxy with `node`.
- Response streams are forwarded in identity encoding, so SSE framing is never corrupted.

## Requirements

- Node.js 18 or newer.
- A [DeepSeek API key](https://platform.deepseek.com/api_keys).
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — your existing Anthropic auth stays in charge of Anthropic traffic.

## Development

```bash
node --check proxy.mjs   # syntax check
bash scripts/test.sh     # feature smoke tests (real claude -p calls + mock upstream)
```

`scripts/test.sh` needs the `claude` CLI and a real `DEEPSEEK_API_KEY` — it makes a handful of tiny real API calls across the config matrix (default, `--port`, `--redir`, `--fallback`, YAML config).

## License

[MIT](LICENSE)
