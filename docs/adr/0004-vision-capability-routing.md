# ADR-0004 — Image-bearing requests redirect from vision-less models to a vision-capable Anthropic model

Date: 2026-08-12
Status: Accepted

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
the fix provider-agnostic rather than a hardcoded DeepSeek-to-Anthropic rule.

## Decision

The proxy detects image-bearing requests at route time and, when the resolved
target model is not vision-capable, rewrites the request to a configured
vision-capable Anthropic model (`claude-opus-5`, effort `low`, by default) and
forwards it on the Anthropic leg.

1. **Detection is a recursive walk anchored on the `type` field.** `hasImageBlock`
   walks the parsed JSON body and matches any object whose `type` is `"image"`.
   This catches every placement — `messages[].content`, `context[]`, and
   `tool_result.content` — while prose that merely mentions the word "image" (a
   `type:"text"` block) never matches. `count_tokens` requests are excluded; the
   proxy already answers those locally.
2. **Capabilities come from a map with three sources, in precedence order:**
   explicit `capabilities:` config overrides, values read from a provider's own
   model list, then a per-family default — `true` for `claude-*`, `false` for
   everything else. Both model-list fetches the proxy already makes run the same
   reader: Anthropic's reports `capabilities.image_input.supported` today, and
   DeepSeek's does not, so its models keep the family default. The reader on the
   DeepSeek list is the extensibility point — a list that starts reporting the
   field stops the redirect for that model with no code change.
3. **The check fires before dispatch, independent of the error-fallback
   machinery.** In `handle()`, before the DeepSeek branches, a request that has
   an image, resolves to a DeepSeek-bound target, and is routed to a model whose
   capability is `vision: false` is redirected. This runs whether the target came
   from a direct DeepSeek id or from `--redir` family mapping.
4. **The redirect leg forwards with `fb: null`.** Error-falling back to DeepSeek
   would re-send the image to the vision-less model and fail again. The redirect
   is the fix, not a stage in the fallback chain.
5. **The redirected response answers in the client's vocabulary.** `message_start`
   would otherwise report `claude-opus-5`, and Claude Code restores a resumed
   session's model from the last assistant message's `model` field. Instead the
   Anthropic leg head-buffers to the first SSE event and runs `restoreClientModel`,
   so a resumed session keeps the model the user picked and the next image turn
   re-redirects. The echoed id is exactly the one the normal DeepSeek path would
   have used — the canonical display id (e.g. `claude-deepseek-v4-flash[1m]`) for
   a DeepSeek model, and the client's own string for a family name being
   redir-routed, so a `--redir --model sonnet` turn is not flipped to a DeepSeek
   id by the redirect. This is ADR-0001's display-id contract applied here.
6. **Redirect is on by default.** A hard 400 with no degradation is worse than
   routing an occasional image turn to Opus 5. It only costs Anthropic plan
   traffic when an image actually appears. Startup warns if redirect is on but
   the credential bridge is off — the redirect leg would answer 401.
7. **Redirected legs that answer are logged.** The usage log gains a `redirected:
   {to, reason: "vision", effort}` field; without it those turns bill Anthropic
   plan traffic while staying invisible in the log. A redirect that fails
   upstream (401, 429) logs nothing, matching the rest of the log's contract:
   it records answered turns, and a failed one bills nothing to account for.

## Consequences

- **Image turns no longer 400.** A pasted screenshot, an image in context, or a
  tool-returned image routes to a model that can actually see it, and the session
  model is unchanged for the turns that follow.
- **The routing rule is capability-driven, not family-hardcoded.** Adding a
  vision-capable DeepSeek-class model later is a one-line `capabilities:` override
  or, if upstream starts reporting the field, nothing at all.
- **The cost of images is Anthropic plan traffic.** Deliberate and default-on,
  but visible: the usage log marks every redirected turn.
- **A redirected turn can break the model-restore invariants if the echo is
  wrong** — hence the explicit display-id rewrite rather than letting
  `claude-opus-5` through, which would silently and permanently upgrade a resumed
  session to a pricier model than the user picked.
- **The check adds a body scan per request.** A recursive JSON walk on every
  messages request; negligible next to the upstream round trip it gates.

Guarded by `scripts/test-parsing.sh` (pure `hasImageBlock` / `rewriteVision`
slices) and `scripts/test.sh` mock-upstream cases (redirect on/off, capability
override, negative control).

## Alternatives rejected

**Let `claude-opus-5` through with no rewrite** — zero machinery, but a single
image turn permanently flips the resumed session to Opus 5 (pricier than the
user picked), violating the session-model contract ADR-0001 exists to protect.

**Let the existing error-fallback retry the image on the Anthropic leg** — the
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
