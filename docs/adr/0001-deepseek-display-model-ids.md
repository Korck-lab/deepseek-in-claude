# ADR-0001 — DeepSeek models are advertised under `claude-deepseek-*[1m]` display ids

Date: 2026-08-11
Status: Accepted

## Context

The proxy serves a merged model list on `GET /v1/models` so DeepSeek models appear in the
Claude Code `/model` picker. Two Claude Code behaviors constrain what that list may
contain. Neither is documented; both were established empirically.

**Discovery filters on the id string.** Gateway model discovery drops any entry whose id
fails `/(claude|anthropic)/i`. A model advertised as `deepseek-v4-flash` is silently
discarded — it never reaches the picker, with no error anywhere.

**The context window is parsed from the id, not looked up.** For a model it does not
recognise, Claude Code sizes the context window by matching a case-insensitive `[1m]`
suffix on the id: present means 1M, absent falls back to 200k. There is no catalog
lookup and no negotiation with the server. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` cannot
substitute — it is ignored for any id beginning with `claude-`, which the discovery
filter above already forces on us.

The two constraints compose badly: satisfying the first (prefix with `claude-`) disables
the only configuration escape hatch for the second.

## Decision

Advertise each DeepSeek model under a synthesised **display id**:

```
claude-deepseek-v4-flash[1m]      ← display id, what Claude Code sees
deepseek-v4-flash                 ← real id, what DeepSeek accepts
```

The proxy maintains `displayToReal` and strips both the prefix and the `[1m]` suffix
before the request reaches the DeepSeek leg. Both the suffixed display id and its bare
form are registered as keys, because Claude Code keeps both in play when resolving a
model name.

Implemented in `proxy.mjs` as `DISPLAY_PREFIX`, `DISPLAY_SUFFIX`, `displayIdOf()`,
`stripWindowSuffix()`.

## Consequences

The `/model` picker lists DeepSeek models and sizes them at 1M. Subagent spawning
inherits the display id correctly — workflow fan-outs run at 56–78k tokens per agent,
which the 200k default made borderline.

The id shown to the user is not the id DeepSeek knows, so logs and error messages may
mention either form. The usage log records the real id.

**Both affixes are load-bearing.** Dropping the prefix breaks model discovery entirely;
dropping the suffix silently reverts every DeepSeek model to a 200k window. Neither
failure is loud. Tests `T2c` (display ids carry the marker) and `T13` (marker stripped
before DeepSeek) in `scripts/test.sh` guard this — do not delete them as redundant.

This is a workaround for undocumented CLI behavior and may break on a Claude Code
upgrade. If the picker empties or windows revert to 200k after an update, re-derive both
constraints before assuming the proxy is at fault. Note that a correct implementation can
still show the broken symptom when a stale proxy is being served — see the deployment
topology section of `CONTEXT.md`.

## Alternatives rejected

**`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** — ignored for `claude-*` ids, which discovery forces.

**Advertising real DeepSeek ids** — dropped by the discovery filter; models never appear.

**Patching the CLI's model catalog** — brittle across upgrades and outside this project's
zero-dependency, no-build-step constraint.

## Update — 2026-08-12: the constraints are documented, and the filter loosened

Two corrections to the Context above. The decision stands; its stated reasons were partly
wrong.

**"Neither is documented" is false.** Both behaviors are specified:
<https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery> and
<https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id>.
They were established empirically here only because the documentation was not found first.
Read it before inferring CLI behavior from the decompiled binary.

**The filter is `contains`, not `startsWith`.** Since CLI 2.1.223 an entry is kept when its
id contains `claude` or `anthropic` anywhere, case-insensitively; before that it had to
begin with one. Provider-prefixed ids such as `vertex_ai/claude-sonnet-4-6` now pass.

That change matters because the "Alternatives rejected" entry above —
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` being "ignored for `claude-*` ids, which discovery forces"
— is no longer true in its second half. Discovery no longer forces a `claude-` *prefix*, so
an id shaped `deepseek/claude-deepseek-chat` would satisfy the filter while leaving
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` applicable, with proactive compaction intact at a declared
window. That is the correct shape for any served model whose real window is not 1M.

It is not adopted here because both DeepSeek V4 models genuinely have a 1M context window,
so `[1m]` states the truth rather than working around a default, and renaming ids would
break every pinned model string in existing configs. Revisit this if a served model ever has
a smaller window — and note that `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is one value per session,
so declaring DeepSeek's window would misdeclare the Anthropic models alongside it.

Related: [ADR-0003](0003-launcher-seeds-the-model-cache.md) — the ids in this ADR now reach
the picker through a seeded cache rather than a discovery fetch. The filter still applies:
it is the same reader-side code path.
