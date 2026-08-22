# ADR-0004 — Image-bearing requests redirect from vision-less models to one that can see

Date: 2026-08-12
Status: Accepted (amended 2026-08-16 — the redirect target is a local model, not an
Anthropic one; and, later the same day, the redirect is opt-in rather than on by
default. Amended 2026-08-21 — the Anthropic leg returns as a second tier behind
the opt-in local one, on by default, targeting claude-sonnet-5 at medium effort.
Amended 2026-08-21 — the premise below is corrected: DeepSeek no longer 400s an
image block, it answers 200 without having seen it. The decision is unchanged and
the case for it is stronger. Also amended 2026-08-21 — the default below reads a
`vision`/`vl` marker in the id, so a vision-capable model outside the claude
family keeps its own image turns.)

## Context

The base DeepSeek V4 models (`deepseek-v4-flash`, `deepseek-v4-pro`) have no
vision — `deepseek-v4-flash-vision-exp` does, and is the reason capability is
detected per model, not per family. A Claude Code request whose body carries an
image block — pasted into the prompt, dropped into the context, or returned by a
tool — used to 400 upstream, because DeepSeek's Anthropic-compatible endpoint
rejected `{"type":"image"}` content it could not process.

Measured again 2026-08-21, that is no longer what happens, and the new behaviour is
worse. DeepSeek accepts the image block and answers 200 without having seen it. Sent
a 1x1 `rgba(255,0,0,127)` pixel and asked its colour it answered "blue"; sent a
64x64 image split green/yellow it answered "Cannot determine." The same two requests
through the redirect answered "Pink" (correct — half-alpha red on white) and
"Green, yellow". So the failure is silent: the user gets a fluent, confident answer
about an image the model never saw, with nothing in the response marking it as
blind. A hard 400 at least announced itself.

The proxy knows which leg a request is bound for before dispatch. It also knows —
or can know — which models are vision-capable: since 2026-03 Anthropic's
`GET /v1/models` reports `capabilities.image_input.supported` per model, and
DeepSeek's `/models` will not. That asymmetry is the design seam: capability
information is *fetched when present, defaulted otherwise*, which is what makes
the fix provider-agnostic rather than a hardcoded rule.

Originally the redirect sent the image turn to a vision-capable Anthropic model
(`claude-opus-5`). That cost Anthropic plan traffic per image and, on a week
without Anthropic credits, made every image turn fail where it was meant to be
the fix. A local vision model serves the same need at zero plan cost: LM Studio
speaks OpenAI protocol rather than Anthropic, so the redirect leg translates
between the two instead of forwarding to `api.anthropic.com`.

Making that local leg opt-in (below) left a gap the original decision did not
have: with no `vision:` block — the shape every installed `config.yml` ships with
— an image turn 400s. The warning names the setting, but the setting only helps a
user who is running LM Studio. Everyone else is back to the hard failure this ADR
was written to remove, and the fix on offer requires standing up a server. The
Anthropic leg is already there, already authenticated, and already the leg the
proxy talks to for every non-DeepSeek turn; the objection that retired it was
cost and credit-dependence, not correctness. As a *second tier behind* the local
one, it pays that cost only when the free option is not configured.

## Decision

The proxy detects image-bearing requests at route time and, when the resolved
target model is not vision-capable, reroutes the turn to a model that can see it
— the configured local vision model when that leg is turned on, the Anthropic leg
otherwise.

1. **Detection is a recursive walk anchored on the `type` field.** `hasImageBlock`
   walks the parsed JSON body and matches any object whose `type` is `"image"`.
   This catches every placement — `messages[].content`, `context[]`, and
   `tool_result.content` — while prose that merely mentions the word "image" (a
   `type:"text"` block) never matches. `count_tokens` requests are excluded; the
   proxy already answers those locally.
2. **The redirect target is a local vision model.** `vision.baseUrl` is the
   OpenAI-compatible server (default `http://127.0.0.1:1234`, LM Studio) and
   `vision.model` the vision-capable id it reports (default `prism-ml/bonsai-27b`).
   `anthropicToOpenAI` rewrites the body: `model`, `system` (string or text
   blocks) into a leading system message, image blocks into OpenAI `image_url`
   data URIs, `tool_use`/`tool_result` into OpenAI tool messages, the `tools`
   array into OpenAI function tools with `advisor_*` dropped (the same rule the
   DeepSeek leg applies), and `output_config.effort` dropped — OpenAI has no
   effort concept, and the local model's own temperature comes from its LM Studio
   model.yaml. `stream`, `max_tokens`, `temperature`, `top_p`, `stop_sequences`
   survive.
3. **Capabilities come from a map with three sources, in precedence order:**
   explicit `capabilities:` config overrides, values read from a provider's own
   model list, then a default read off the id — `true` for `claude-*` and for any
   id naming `vision` or `vl`, `false` for everything else. Both model-list fetches
   the proxy already makes run the same reader: Anthropic's reports
   `capabilities.image_input.supported` today, and DeepSeek's does not, so its
   models fall through to that default. The reader on the DeepSeek list is the
   extensibility point — a list that starts reporting the field stops the redirect
   for that model with no code change.

   The id marker was added 2026-08-21, when DeepSeek's list turned out to carry
   `deepseek-v4-flash-vision-exp`. A pure per-family rule called it blind, so the
   one model in the catalogue that can already see would have had its image turns
   taken away from it and billed to the plan — a user picking a vision model on
   purpose, silently overruled. Reading the id is a guess where reported
   capability is a fact, which is why it sits at the bottom of the precedence
   chain: a wrong guess is one `capabilities:` line to correct, and the pattern is
   anchored on token boundaries so `supervision-model` is not mistaken for a
   claim.
4. **The check fires before dispatch, independent of the error-fallback
   machinery.** In `handle()`, before the DeepSeek branches, a request that has
   an image, resolves to a DeepSeek-bound target, and is routed to a model whose
   capability is `vision: false` is redirected. This runs whether the target came
   from a direct DeepSeek id or from `--redir` family mapping.
5. **The redirect leg forwards with `fb: null`.** Error-falling back to DeepSeek
   would re-send the image to the vision-less model and fail again. The redirect
   is the fix, not a stage in the fallback chain.
6. **The redirected response answers in the client's vocabulary.** `forwardToLocalVision`
   synthesizes the Anthropic SSE itself — `message_start` reports the display id
   the normal DeepSeek path would have echoed, not the local model's id — so a
   resumed session keeps the model the user picked and the next image turn
   re-redirects. This is ADR-0001's display-id contract applied here; the same
   contract the original Anthropic redirect enforced via `restoreClientModel`.
7. **The local leg is opt-in; the Anthropic leg is the default tier behind it.**
   Precedence is local, then Anthropic, then the warning — the local leg wins when
   both are configured, because it is the one the user turned on by name and the
   one that spends nothing. `vision.anthropic` is boolean-or-object, the shape
   `redir` already uses: `false` disables the tier, an object sets `model`
   (default `claude-sonnet-5`) and `effort` (default `medium`), absent takes the
   defaults. Sonnet 5 is the cheapest current model that can see, and medium
   effort is enough to read a screenshot without paying max-effort thinking for
   it; both legs of that default are one config key away from anything else.
   `rewriteVision` swaps those two fields and leaves the rest of the body alone —
   both legs speak Anthropic, so there is no translation to do. `effort: false`
   sends no effort field at all, which models older than the current tier need:
   Haiku 4.5 answers `This model does not support the effort parameter`.

   The response is restored by `restoreRedirectedModel`, not `restoreClientModel`.
   The difference is load-bearing and was found by running the leg for real:
   Anthropic answers an alias with its dated snapshot, so a request for
   `claude-haiku-4-5` echoes `claude-haiku-4-5-20251001`, and the
   equality-anchored rewrite the DeepSeek leg uses finds nothing and no-ops. The
   turn still answers, so nothing looks wrong until a reconnect restores the
   session to a model the user never picked — the exact ADR-0001 failure, arriving
   silently and far from its cause. The redirect leg therefore rewrites the first
   `model` field in the buffered head rather than a named one. The DeepSeek leg
   keeps the named rewrite: it echoes the id it was sent, and the narrower rule is
   what keeps prose naming a model from being rewritten.

   Defaulting a tier *on* is the posture ADR-0005 rejected for fallback, and the
   difference is worth naming rather than glossing. Fallback fires on any upstream
   error, silently crosses to a provider the user is not paying attention to, and
   spends metered credits on a routine 429. This fires only on an image block
   against a vision-less model — a turn that has exactly one other outcome, a hard
   400 — on the plan the user is already on, through the leg the proxy already
   talks to, with no new host named and nothing to install. The asymmetry is not
   that this crossing is harmless; it is that the alternative is a guaranteed
   failure rather than a working turn on the other provider.

8. **The local redirect stays opt-in — `vision.redirect: true`, off otherwise.** It was on by
   default when the target was an Anthropic model the user was already paying for
   and already talking to; a blind answer was the worse outcome. Naming a *local* target
   changed what the default asserts. The redirect now ships the prompt and the image
   to a host the proxy would otherwise never contact, one the user has to be running
   for it to work at all, and answers out of a model they did not pick in `/model`.
   Defaulting that on decides for a user who never configured the leg, and the same
   global `config.yml` decides it for every project at once — the shape ADR-0005
   rejected for fallback. Off, the turn 400s as it did before the feature existed,
   and the disabled path warns which setting would have handled it, so the failure
   is actionable rather than opaque. No credential bridge is involved either way —
   the leg needs no auth, so the old startup warning about the bridge is gone.
9. **Redirected legs that answer are logged.** The usage log gains a `redirected:
   {to, reason: "vision"}` field; without it those turns are invisible. A redirect
   that fails upstream logs nothing, matching the rest of the log's contract: it
   records answered turns, and a failed one bills nothing to account for. The one
   exception is a socket error on the Anthropic tier, which logs a 502 with the
   `redirected` field: nothing else in the ledger would otherwise show that the
   turn was routed away, and unlike an upstream status this is the proxy's own
   leg failing, which is worth a line.

## Consequences

- **Image turns are no longer answered blind out of the box.** A pasted screenshot, an image in
  context, or a tool-returned image routes to a model that can actually see it,
  and the session model is unchanged for the turns that follow. With
  `vision.redirect: true` that costs nothing but local inference and works on a
  week with zero Anthropic credits; without it, it costs one Sonnet 5 call per
  image on the user's plan. Both tiers off is still the old behavior — a 400 with
  a warning naming the settings.
- **An image turn can now spend plan traffic without the user configuring
  anything.** That is the deliberate trade for removing the default 400, and it is
  bounded: image turns only, one call each, on the cheapest vision-capable model.
  `vision.anthropic: false` opts out.
- **The routing rule is capability-driven, not family-hardcoded.** Adding a
  vision-capable DeepSeek-class model later is a one-line `capabilities:` override
  or, if upstream starts reporting the field, nothing at all.
- **The redirect leg translates protocol where the rest of the proxy does not.**
  The DeepSeek leg forwards Anthropic SSE untouched because DeepSeek speaks
  Anthropic; LM Studio speaks OpenAI, so this leg translates both directions.
  The translation is scoped to the vision leg and exercised by the mock-upstream
  V1/V4 cases; it is the one deliberate exception to the zero-translation design.
- **A redirected turn can break the model-restore invariants if the echo is
  wrong** — hence synthesizing `message_start` with the display id rather than
  reporting the local model, which would silently and permanently change a
  resumed session's model.
- **The check adds a body scan per request.** A recursive JSON walk on every
  messages request; negligible next to the upstream round trip it gates.
- **A redirected turn depends on the local server being up.** If LM Studio is not
  running, the leg answers a clear 502 naming the base URL. A loud 502 is the
  visible trade for cutting the plan dependency — and still preferable to the
  silent wrong answer the unredirected path now gives.

Guarded by `scripts/test-parsing.sh` (pure `hasImageBlock` / `anthropicToOpenAI` /
`rewriteVision` slices) and `scripts/test.sh` mock-upstream cases (redirect
on/off, capability override, negative control, local-model echo, tier
precedence). The two defaults have one guard each. `V6` runs a config with no
`vision` block at all — the shape every installed config has — and asserts the
turn leaves both mock-visible legs, that a real Sonnet 5 answer comes back, and
that it echoes the display id; `V7` sets `anthropic: false` with the local leg off
and asserts the image stays on DeepSeek with a warning naming both settings. `V2`
covers the same both-off state on the wire rather than on stderr.

`V6`'s request body carries the Claude Code identity block as `system[0]`, and that
is load-bearing rather than decoration. A plan OAuth token is gated on it: the same
request without that block comes back `429 rate_limit_error` with an opaque
`"message":"Error"`, for `claude-sonnet-5` but not for `claude-haiku-4-5`, which is
exempt. Hand-testing this leg with a curl body that omits it therefore reads as a
plan rate limit, and the model-specific behaviour makes that reading look confirmed.
It cost real time on 2026-08-21. Real Claude Code always sends the block and
`rewriteVision` preserves it, so this never affects live traffic — only tests and
hand probes.

The Anthropic leg's host is hardcoded to `api.anthropic.com` (ADR-0002 — it
carries the plan OAuth token), so the mock cannot stand in for it and `V6` is a
real-API case, the pattern `T8` already uses. Making that host configurable would
turn a test affordance into a way to point a credential-bearing leg at an
arbitrary host, which is precisely what ADR-0002 forbids. The body rewrite is
covered hermetically instead, as a pure function.

## Alternatives rejected

**Let the vision model's id through with no echo** — zero machinery, but a single
image turn permanently flips the resumed session to the local model (not the one
the user picked), violating the session-model contract ADR-0001 exists to protect.

**Keep the Anthropic redirect and make it opt-in** — preserves the old behavior
for people who want plan-traffic vision, but leaves the no-credits failure mode
in place for everyone else, and splits the leg's behavior across two targets.
*(Superseded 2026-08-21: the split is what the two-tier shape accepts, and the
no-credits mode is what the local tier answers. Opt-in for the Anthropic leg
specifically was still rejected — a default-off tier behind another default-off
tier leaves the out-of-the-box 400 exactly where it was.)*

**Let the existing error-fallback retry the image on another leg** — the
fallback fires only after an upstream error, and the failure mode here is a 400
on the DeepSeek leg; relying on retry-on-error would also re-send the image to
the vision-less model on every attempt, and couples the redirect to the fallback
machinery.

**Send the image only, not the model** — e.g. stripping image blocks instead of
rerouting. The user asked for routing; degrading the prompt silently loses the
image the user intended the model to see.

**Capability detection via a hardcoded list** — a `deepseek: no vision` /
`claude: vision` rule in code works today but is precisely the non-extensible
shape the "fetch capabilities" ask rejected. The map with fetched-overlay and
config-override is the same rule with the seams the next provider needs.
