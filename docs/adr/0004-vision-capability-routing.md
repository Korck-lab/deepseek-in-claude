# ADR-0004 — Image-bearing requests redirect from vision-less models to a local vision model

Date: 2026-08-12
Status: Accepted (amended 2026-08-16 — the redirect target is a local model, not an
Anthropic one; and, later the same day, the redirect is opt-in rather than on by default)

## Context

DeepSeek V4 models have no vision. A Claude Code request whose body carries an
image block — pasted into the prompt, dropped into the context, or returned by a
tool — currently 400s upstream, because DeepSeek's Anthropic-compatible endpoint
rejects `{"type":"image"}` content it cannot process. The failure is a hard one:
the turn dies with an opaque upstream error instead of degrading.

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

## Decision

The proxy detects image-bearing requests at route time and, when the resolved
target model is not vision-capable, rewrites the request for a configured local
vision model and forwards it to that model's OpenAI-compatible endpoint.

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
   model list, then a per-family default — `true` for `claude-*`, `false` for
   everything else. Both model-list fetches the proxy already makes run the same
   reader: Anthropic's reports `capabilities.image_input.supported` today, and
   DeepSeek's does not, so its models keep the family default. The reader on the
   DeepSeek list is the extensibility point — a list that starts reporting the
   field stops the redirect for that model with no code change.
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
7. **Redirect is opt-in — `vision.redirect: true`, off otherwise.** It was on by
   default when the target was an Anthropic model the user was already paying for
   and already talking to; a hard 400 was the worse answer. Naming a *local* target
   changed what the default asserts. The redirect now ships the prompt and the image
   to a host the proxy would otherwise never contact, one the user has to be running
   for it to work at all, and answers out of a model they did not pick in `/model`.
   Defaulting that on decides for a user who never configured the leg, and the same
   global `config.yml` decides it for every project at once — the shape ADR-0005
   rejected for fallback. Off, the turn 400s as it did before the feature existed,
   and the disabled path warns which setting would have handled it, so the failure
   is actionable rather than opaque. No credential bridge is involved either way —
   the leg needs no auth, so the old startup warning about the bridge is gone.
8. **Redirected legs that answer are logged.** The usage log gains a `redirected:
   {to, reason: "vision"}` field; without it those turns are invisible. A redirect
   that fails upstream logs nothing, matching the rest of the log's contract: it
   records answered turns, and a failed one bills nothing to account for.

## Consequences

- **Once turned on, image turns no longer 400, and never cost Anthropic plan
  traffic.** A pasted screenshot, an image in context, or a tool-returned image
  routes to a local model that can actually see it, and the session model is
  unchanged for the turns that follow. This works on a week with zero Anthropic
  credits. Until turned on, image turns fail exactly as they did before the
  feature existed — with a warning naming the setting.
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
  running, the leg answers a clear 502 naming the base URL, rather than a hard
  upstream 400. This is the visible trade for cutting the plan dependency.

Guarded by `scripts/test-parsing.sh` (pure `hasImageBlock` / `anthropicToOpenAI`
slices) and `scripts/test.sh` mock-upstream cases (redirect on/off, capability
override, negative control, local-model echo). The opt-in default has exactly one
guard, `V6`: every other case sets `redirect: true` explicitly and so passes under
either default. `V6` runs a config with no `vision` block at all and asserts the
image stays on DeepSeek and the warning names the setting. `V2` covers explicit
`false`, a different path through `CFG.vision?.redirect`; neither replaces the other.

## Alternatives rejected

**Let the vision model's id through with no echo** — zero machinery, but a single
image turn permanently flips the resumed session to the local model (not the one
the user picked), violating the session-model contract ADR-0001 exists to protect.

**Keep the Anthropic redirect and make it opt-in** — preserves the old behavior
for people who want plan-traffic vision, but leaves the no-credits failure mode
in place for everyone else, and splits the leg's behavior across two targets.

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
