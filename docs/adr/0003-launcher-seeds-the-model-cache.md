# ADR-0003 — The launcher seeds Claude Code's model cache instead of authenticating discovery

Date: 2026-08-12
Status: Accepted

## Context

DeepSeek models reach the `/model` picker through Claude Code's gateway model discovery.
Until v0.7.0 the launcher made that work by setting `ANTHROPIC_AUTH_TOKEN` to a sentinel,
because the discovery request returns early when no auth environment variable is present
(ADR-0002).

That cost a feature. Claude Code disables claude.ai connectors whenever it finds any
Anthropic auth environment variable, and the check has no bypass outside
`CLAUDE_CODE_REMOTE`. So the choice looked like: DeepSeek in the picker, or connectors.

The premise was wrong. Discovery is two independent functions, and only one of them needs a
credential:

- **The fetch** refreshes `~/.claude/cache/gateway-models.json`. It returns early unless
  `ANTHROPIC_AUTH_TOKEN` or an API key is set — read from the environment, never from the
  user's claude.ai login.
- **The reader** is what the picker lists from. It reads that cache file and never fetches
  or authenticates.

Anthropic's own documentation specifies the feature, including the response schema and the
cache path: <https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery>.

Measured 2026-08-12 with `sniffer.sh`, a raw tap that neither bridges credentials nor merges
models: with a hand-written cache, the discovery flag set, and **no auth variable exported**,
the picker listed the seeded models as "From gateway" and the capture contained no
`GET /v1/models` at all (`docs/probe-findings.md` §5.3).

## Decision

`claudei.sh` writes `~/.claude/cache/gateway-models.json` itself, from the proxy's
`/_proxy/deepseek-models` endpoint, and launches Claude Code with **no Anthropic auth
environment variable**.

1. The launcher MUST purge the cache before seeding it. A list captured by an older proxy is
   keyed by the same base URL and would otherwise survive as stale ids.
2. The seeded `baseUrl` MUST be byte-identical to the exported `ANTHROPIC_BASE_URL`. Claude
   Code compares them with a string `!=`, so `localhost` versus `127.0.0.1`, or a trailing
   slash, silently yields an empty gateway list that looks exactly like the feature not
   working. Both MUST come from the same shell variable, never from two literals.
3. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` MUST still be set. It gates the reader, not
   just the fetch; without it the picker shows no gateway rows however good the cache is.
4. Only DeepSeek entries are seeded. Anthropic's models are already built-in picker rows, and
   the seeding endpoint deliberately skips the proxy's Anthropic leg so the launcher needs no
   credential to build the list.
5. A failure to seed MUST be reported, not swallowed. The symptom is a silently short picker,
   which is indistinguishable from the proxy having no DeepSeek models at all.

## Consequences

- **claude.ai connectors work.** This is the point of the ADR.
- **The Anthropic leg is authenticated by the CLI's own claude.ai OAuth bearer**, which it
  sends unprompted to a custom base URL together with the `oauth-2025-04-20` capability the
  upstream requires. `proxy.mjs` passes a non-sentinel bearer through untouched, so this is
  the pre-existing passthrough branch rather than new machinery. Verified end to end through
  the installed checkout: `--model claude-opus-5` answers, and so does
  `--model 'claude-deepseek-v4-flash[1m]'`, in the same configuration.
- **The sentinel and credential bridge remain supported** for anyone who sets
  `ANTHROPIC_AUTH_TOKEN` deliberately. ADR-0002's invariant is untouched and its guard cases
  A1–A6 still apply. This ADR removes a *reason* to set the variable; it does not remove the
  variable's handling.
- **The project writes into the CLI's own state directory.** ADR-0002 treats that directory
  as read-only unless explicitly opted in, because of the credential store. A cache file is a
  far weaker case — it is disposable, holds no secrets, and Claude Code rewrites it on any
  authenticated discovery run — but the boundary is the same one, and this is the deliberate
  exception to it. Write it atomically (temp file plus rename, mode 600) so a CLI starting up
  beside the launcher can never read a half-written list.
- **No discovery request is made, ever, in the default configuration.** A capture containing
  no `GET /v1/models` is now the expected state, not a symptom to debug.
- **The seed is per-base-URL.** Changing `DEEPSEEK_PROXY_PORT` invalidates it; the launcher
  reseeds on every run, so this only bites hand-rolled launches.

Guarded by `scripts/test-auth-bridge.sh`: **L2** asserts the CLI receives no
`ANTHROPIC_AUTH_TOKEN` (the absence is the feature), **L4** that the cache was seeded, and
**L5** that its `baseUrl` matches the exported base URL exactly. All three were red-tested by
sabotaging the seeding step.

## Alternatives rejected

**Keep authenticating discovery with the sentinel** — works, and costs claude.ai connectors
for a fetch whose result the proxy already knows.

**`ANTHROPIC_CUSTOM_MODEL_OPTION`** — needs no flag, no cache and no credential, and skips id
validation entirely. But it is a single entry, and the proxy serves several models.

**`modelOverrides`** — the CLI's own error text suggests it for unrecognized ids, but its keys
must be real Anthropic model ids ("Unknown keys are ignored"), so it cannot register an
invented id. It can only redirect a genuine model's row at a different upstream string, which
would mean hijacking a real model to reach DeepSeek.

**Running `claude gateway`** — despite the shared name, connecting to the enterprise gateway
makes the CLI's provider resolve to `"gateway"` rather than `"firstParty"`, which fails the
discovery precondition outright. It *disables* the feature, and it needs Postgres and OIDC.
