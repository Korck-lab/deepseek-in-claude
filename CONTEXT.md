# Context — deepseek-in-claude

A zero-dependency local proxy that makes DeepSeek models selectable inside Claude Code.
It sits between the CLI and two upstreams, merges their model lists, and routes each
request to whichever upstream owns the requested model. No protocol translation is
involved — DeepSeek exposes an Anthropic-compatible endpoint, so the CLI sees native
Anthropic SSE either way.

Everything runs from a single file, `proxy.mjs`, on Node built-ins only.

## Glossary

Use these terms; avoid the synonyms noted.

**Proxy** — the `proxy.mjs` process listening on `PORT` (8016 under the launcher).
Claude Code reaches it via `ANTHROPIC_BASE_URL`.

**Upstream** — either of the two backends the proxy forwards to: the *Anthropic leg*
(`api.anthropic.com`) or the *DeepSeek leg* (`api.deepseek.com/anthropic`). Say which
leg; "the API" is ambiguous here.

**Display id** — the model id the proxy advertises to Claude Code, e.g.
`claude-deepseek-v4-flash[1m]`. Both the prefix and the suffix are load-bearing;
see ADR-0001.

**Real id** — the id DeepSeek actually accepts, e.g. `deepseek-v4-flash`. The proxy
keeps a `displayToReal` map and rewrites before forwarding.

**Gateway model discovery** — the Claude Code feature (enabled by
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`) that calls `GET /v1/models` on the base
URL and populates the `/model` picker. Only runs when an auth env var is set.

**Credential bridge** — the substitution of the caller's sentinel
`ANTHROPIC_AUTH_TOKEN` for the user's real Claude Code OAuth token on the Anthropic leg.
Disable with `--no-auth-bridge`. Not to be called "auth passthrough" — passthrough is
what happens to a *real* credential, the bridge is a swap. The Anthropic leg must
authenticate with the user's plan OAuth session and never with an Anthropic API key —
enforced on both sides now: `claudei.sh` unsets `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` before launching the CLI, and the bridge drops any
client-supplied `x-api-key` on the Anthropic leg, because Anthropic prefers that header
over the bearer. See ADR-0002 and its guard suite, `scripts/test-auth-bridge.sh`.

**Sentinel** — the placeholder auth value Claude Code is given. Random per install, stored as `sentinel:` in `config.yml` (the single source of truth for both the proxy and `claudei.sh`); falls back to `local-deepseek-proxy` when that file is absent.
It is not a credential and never leaves the proxy.

**Redir** — the `--redir` mode that routes Anthropic-family model names
(haiku/sonnet/opus/fable) to DeepSeek via a mapping. Distinct from *fallback*.

**Fallback** — the `--fallback` mode that retries the *other* leg when an upstream
returns 404/429/5xx. Bidirectional.

## Shape of proxy.mjs

Sections in file order:

| Region | Responsibility |
| --- | --- |
| Config | precedence `CLI args > config.yml > .env > defaults` |
| Payload debug log | `--debug`, one JSON line per request/response |
| Anthropic credential bridge | sentinel → real OAuth token, optional refresh grant |
| DeepSeek model list | live fetch, 10-min cache, `.env` fallback, display/real mapping |
| Usage log | one JSON line per DeepSeek request, always on |
| DeepSeek routing | transparent forward to the Anthropic-compatible endpoint |
| Merged model list | serves `GET /v1/models` — union of both legs |
| Anthropic forward | body untouched; credential headers reworked by the bridge |
| Server | request dispatch |

## Deployment topology — read this before debugging

**`claudei.sh` does not run the proxy from this repo.** It starts
`$PROXY_HOME/proxy.mjs`, where `PROXY_HOME` defaults to `~/.deepseek-in-claude` — a
separate shallow checkout created by `scripts/install.sh`. Editing `proxy.mjs` here has
no effect on a running session until the file is copied across *and* the process is
replaced.

Three layers can independently keep stale behavior alive:

1. **The installed checkout lags the repo.** `install.sh` updates it with
   `git pull --ff-only origin main`, so a fix that is committed locally but unpushed
   never arrives. Check `cat $PROXY_HOME/VERSION` against the repo's.
2. **The running process holds the `proxy.mjs` it launched with.** Since v0.6.4 the
   launcher fingerprints the file with `shasum` (stamp at `/tmp/deepseek-proxy.sha`) and
   restarts on mismatch. Before that, the reuse path printed "proxy already running,
   reusing" and kept serving old code indefinitely.
3. **Claude Code caches the discovered model list** at
   `~/.claude/cache/gateway-models.json`, keyed by base URL — which never changes here,
   so a list captured by an older proxy outlives restarts and re-logins. The launcher now
   purges it unconditionally.

All three fired at once on 2026-08-11. The visible symptom was a context window of
`200k tokens (default for an unrecognized model)`, which reads like a CLI or
model-support problem rather than deployment drift.

**Fastest check when behavior does not match the source** — confirm the deployed
artifact before reading code:

```sh
cat ~/.deepseek-in-claude/VERSION
git -C ~/.deepseek-in-claude log --oneline -1
curl -s http://localhost:8016/v1/models
```

The decisive signal is a differential: run this repo's `proxy.mjs` on a scratch port and
diff its `/v1/models` output against the live one.

## Verification

`scripts/test.sh` is the suite: its own inline `T*` cases, plus the unit and race suites it
invokes itself — `test-parsing`, `test-model-race`, `test-auth-bridge` — with
`test-fallback-race` gated behind `RUN_SLOW_TESTS=1` because it spends real API traffic.
Most cases need no network. Counting cases here has gone stale repeatedly; run the suite for
the number. `T2c` and `T13` cover the display-id contract from ADR-0001;
`scripts/test-auth-bridge.sh` is the guard for ADR-0002 — half of it slices
`forwardHeaders` + `applyAnthropicAuth` out of `proxy.mjs` to assert no `x-api-key` reaches
the Anthropic leg, half drives `claudei.sh` against a stub CLI that dumps its environment.
Both ADRs' guards must not be deleted as redundant.

`scripts/observe.mjs` sniffs live traffic; `scripts/probe.mjs` runs a `claude -p` matrix
across models and effort levels. Findings from the last full run are in
`docs/probe-findings.md`.
