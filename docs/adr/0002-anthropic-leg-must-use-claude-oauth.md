# ADR-0002 — The Anthropic leg must authenticate with the user's Claude OAuth session

Date: 2026-08-12
Status: Accepted

## Context

The proxy sits between Claude Code and two upstreams: DeepSeek's Anthropic-compatible
endpoint, and `api.anthropic.com` for every model that is not redirected. The DeepSeek leg
is paid for with a DeepSeek API key. The Anthropic leg is the one this ADR is about.

Claude Code only performs gateway model discovery — the step that puts DeepSeek models in
the `/model` picker — when an auth environment variable is set. But whichever credential is
set that way takes precedence over the claude.ai login for *every* request, including
requests for real Anthropic models.

That leaves a fork with very different billing consequences:

- Set `ANTHROPIC_API_KEY` (or a real `ANTHROPIC_AUTH_TOKEN`). Discovery works, Anthropic
  models answer — and every Anthropic token is billed to API credits at pay-as-you-go
  rates. The user's Claude subscription sits unused. Nothing warns about this; the
  requests simply succeed.
- Set nothing. The plan is used, but DeepSeek never appears in the picker, which is the
  entire point of the project.

Neither is acceptable. The user's Claude Pro/Max plan is the intended and paid-for way to
reach Anthropic models, and routing that traffic to API billing is a silent,
money-costing regression, not a configuration preference.

## Decision

The Anthropic leg authenticates with the user's existing Claude Code OAuth session, and
nothing else. This is a hard invariant, not a default.

The mechanism is the auth bridge in `proxy.mjs`:

1. Claude Code is launched with `ANTHROPIC_AUTH_TOKEN` set to a **sentinel** — a
   non-credential placeholder, generated per install by `scripts/install.sh` into
   `config.yml` and read from that same file by `claudei.sh`. Its only job is to make
   discovery run.
2. A request arriving with exactly `Bearer <sentinel>` has that header replaced, on the
   Anthropic leg only, with the real OAuth access token read from the credential store the
   CLI itself uses (macOS keychain, or `~/.claude/.credentials.json` elsewhere). The
   `oauth-2025-04-20` beta is appended to `anthropic-beta`, which the OAuth path requires.
3. The credential store is read-only by default. Refreshing an expired token writes back to
   the store the real CLI depends on, so it is opt-in via `--oauth-refresh`; otherwise an
   expired token warns and 401s, and any normal `claude` session refreshes it.

The MUSTs that follow from this, binding on the proxy, the launcher, the installer, the
config schema, and the docs:

- **No Anthropic-leg request may be authenticated by an Anthropic API key.** The project
  must never set, require, document, or fall back to `ANTHROPIC_API_KEY`. A missing or
  expired OAuth token is an error to surface, never a reason to reach for API billing.
- **The Anthropic leg's credential comes from the Claude Code credential store**, so the
  proxy inherits whatever plan the user is logged into and never holds a long-lived
  Anthropic secret of its own.
- **Every path that reaches `api.anthropic.com` goes through `applyAnthropicAuth()`** —
  including the `--fallback` retry, which is on by default whenever `--redir` is on. A path
  that copies headers straight through is a bug.
- **`--no-auth-bridge` is a diagnostic**, not a supported operating mode. In sentinel mode
  it makes Anthropic models 401 by design.

## Consequences

The user keeps one login. Anthropic models are billed to the plan; only DeepSeek traffic
touches a metered key. The proxy stores no Anthropic credential.

The invariant is **enforced in code, and guarded by a test**. The three gaps this ADR
opened with all had the same shape — an environment variable the user already exported
silently winning over the sentinel, exactly like the `.env` override recorded in the
project's session notes — and all three are closed:

- **Root cause, in the launcher.** `claudei.sh` unsets both `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` in the environment it launches the CLI with, then sets
  `ANTHROPIC_AUTH_TOKEN` to the sentinel read from `config.yml`. It no longer defers to an
  exported value via `${ANTHROPIC_AUTH_TOKEN:-…}`, so a real token in the user's shell can
  no longer beat the sentinel and be forwarded verbatim. The sentinel itself must keep
  being set, for the discovery reason below.
- **Defence in depth, in the proxy.** `applyAnthropicAuth()` deletes any client-supplied
  `x-api-key` on the Anthropic leg. Placement is the whole design: **after** the
  `!AUTH_BRIDGE` early return, so `--no-auth-bridge` stays a genuine passthrough for
  someone bringing their own real Anthropic credential, and **before** the sentinel gate,
  because the two paths that return early from that gate — a real non-sentinel bearer, and
  a credential lookup that yields nothing — are precisely the ones where a surviving key
  would win the request. This is load-bearing rather than hygiene: measured 2026-08-12,
  Claude Code sends `x-api-key` *alongside* the bearer when both variables are set, and
  `api.anthropic.com` prefers the key — the identical request answers 401 with a bogus
  `x-api-key` attached and 200 with it removed, so a *valid* key would authenticate and
  bill every Anthropic request to API credits while the bridge appeared to work. The
  DeepSeek leg is untouched: it sets its own `x-api-key` after `forwardHeaders`.
- **The guard test** is `scripts/test-auth-bridge.sh`, run by `scripts/test.sh` so nobody
  has to know its name. Following ADR-0001's convention it is the named guard for this ADR
  and must not be deleted as redundant. Its Anthropic-leg half composes `forwardHeaders`
  and `applyAnthropicAuth` sliced out of the real `proxy.mjs`, in production order, so a
  strip that lands in the wrong function cannot satisfy it:
  - **A1** bridge on, sentinel bearer + stray `x-api-key` → sentinel swapped for the OAuth
    token, `x-api-key` absent, `oauth-2025-04-20` appended to `anthropic-beta`.
  - **A2** bridge on, credential lookup returns null → sentinel left in place (the request
    401s by design) but `x-api-key` still absent, so a lookup failure can never degrade
    into API billing.
  - **A3** bridge on, non-sentinel real bearer + `x-api-key` → the bearer passes through
    untouched, which is this ADR's documented behaviour, and the key is gone. This is the
    case that discriminates strip placement: behind the sentinel gate a strip would pass
    A1 and A2 and still leak the key for anyone exporting a real bearer.
  - **A4** `--no-auth-bridge` → `authorization` and `x-api-key` both pass through untouched
    and no beta is added, so the escape hatch stays a genuine passthrough.
  - **A5** `forwardHeaders` alone still returns `x-api-key` (and still drops `host`),
    proving the strip lives on the Anthropic leg only.

  Its launcher half drives the real `claudei.sh` against a stub CLI that dumps its
  environment, inside an isolated `HOME`/`TMPDIR`/port, and asserts what the CLI receives
  rather than how the script spells it:
  - **L0** `claudei.sh` actually reached the CLI — a fixture guard, so an aborted launcher
    reports as a broken fixture instead of passing vacuously.
  - **L1** an exported `ANTHROPIC_API_KEY` does not appear in the launched CLI's
    environment.
  - **L2** `ANTHROPIC_AUTH_TOKEN` in that environment equals the `config.yml` sentinel, not
    the exported real bearer.
  - **L3** `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is still set, so the fix cannot be
    satisfied by quietly removing discovery.

Removing `ANTHROPIC_API_KEY` from the picture breaks nothing: no file in this repo reads
it, and with only the sentinel set, gateway discovery still runs (`Bearer <sentinel>` on
`GET /v1/models?limit=1000`) and Anthropic models answer 200 through the bridge. Routing is
already decided from the payload's `model` field alone — no code path reads a credential to
choose a leg — so the proxy can ignore every client-supplied credential without losing
function. What it cannot do is stop the *client* from sending one: discovery returns early
and never fetches when no auth env var is present, so the sentinel must keep being set.

The sentinel value is load-bearing in the other direction too: `claudei.sh` and `proxy.mjs`
must read the same `config.yml` key, or every Anthropic-model request 401s.

## Alternatives rejected

**`ANTHROPIC_API_KEY` on the Anthropic leg** — works, and silently moves the user's
Anthropic spend from a plan they already pay for onto metered API credits. This is the
option this ADR exists to forbid.

**Dropping the auth variable entirely** — the plan is preserved, but gateway model
discovery never runs and DeepSeek never reaches the picker.

**Redirecting every model to DeepSeek so the Anthropic leg is never used** — narrows the
tool to a DeepSeek-only client; `--redir` stays opt-in precisely so both families remain
reachable in one session.

**The proxy minting or storing its own Anthropic credential** — a second thing to rotate,
a long-lived secret on disk, and still not the user's plan.
