# ADR-0005 — Leg-crossing fallback is opt-in

Status: accepted (2026-08-13)

## Context

`--fallback` retries a failed request on the other upstream: a DeepSeek failure
goes to Anthropic, an Anthropic failure goes to DeepSeek via the redir relation.
Until now it was on unless something turned it off. Three separate defaults
compounded into that:

- `claudei.sh` passed `--fallback` whenever `config.yml` did not mention the key,
  which for a fresh install is always.
- In `proxy.mjs`, `FALLBACK` defaulted to `redirOn`, and a truthy `FALLBACK` in
  turn synthesised `REDIR_MAP` from `DEFAULT_REDIR` — so the relation existed even
  with redir off, and every family-named model (`opus`, `sonnet`, `haiku`,
  `fable`) carried an `fb` into `forwardToAnthropic`.
- `FALLBACK_STATUS` includes 429. On a plan session that is not an exceptional
  status; it is a Tuesday. The proxy's own test suite hits one often enough that
  `V1b` skips on it.

So a routine rate limit on the Anthropic leg rerouted the turn to DeepSeek and
spent metered credits. Nothing said so at the time: `restoreClientModel` rewrites
the response's `model` field back to the id the client asked for — load-bearing
for the 1M window across a resume, see ADR-0001 — so the transcript attributes the
turn to an Anthropic model that never ran. And `logUsage` recorded only the model,
so afterwards the row was indistinguishable from deliberate DeepSeek use.

Two multipliers made this worse than a per-session mistake. The proxy is pooled
across sessions (one listener on `:8016` for every project), and its `config.yml`
lives in `$PROXY_HOME` — a single global file. There is no per-project fallback
setting and cannot be one through a shared listener: whoever starts the proxy
decides for every project at once, including the ones they are not looking at.

## Decision

Fallback is opt-in. `FALLBACK` defaults to `false`; `claudei.sh` passes no
`--fallback`. Opting in is `fallback: true` in `$PROXY_HOME/config.yml`, or the
flag when running `proxy.mjs` directly.

Both directions of a crossing are tagged in the usage log with
`fallbackFrom: "anthropic" | "deepseek"`, following the precedent
`opts.redirected` set for the vision redirect (ADR-0004). The Anthropic leg does
not otherwise write to that log — it is the DeepSeek spend ledger — but a turn
that reached it only because DeepSeek gave up is the counterpart of the rows
tagged the other way, and a ledger showing crossings in one direction only is
worse than one showing none. A crossing that itself fails is logged too, with the
upstream error — the ledger is where someone goes to find out what happened to a
turn, and one that records only the successful crossings answers that badly.

## Consequences

- A dead or rate-limited upstream now surfaces as an error the user sees, instead
  of a silent charge to the other provider. That is the intended trade.
- `--redir` no longer implies fallback. `scripts/test-fallback-race.sh` passes
  both flags explicitly.
- With redir and fallback both off, `REDIR_MAP` is null, `familyOf` returns null
  and every `fb` is null — no orphaned relation left behind.
- Guards: `T8b` (no `--fallback` errors rather than crossing), `T9b` (a crossing
  is tagged in the usage log), and `L6` in `scripts/test-auth-bridge.sh` (the
  launcher passes no `--fallback`).
- Making a crossing visible *in the CLI* rather than only in the log was
  investigated and rejected — see `docs/probe-model-echo.md`. Reporting the served
  model in `message_start.model` does not announce anything; it breaks the session
  restore and drops the next resume onto the machine's default model. The field is
  a restore key, not a notification channel. Injecting a visible text block into
  the stream remains possible and was not attempted; not crossing legs by default
  removes the reason to need it.
