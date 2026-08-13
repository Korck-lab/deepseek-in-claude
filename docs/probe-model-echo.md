# Probe — can the response `model` field announce a routing swap?

Run 2026-08-13, Claude Code 2.1.231. Question left open by ADR-0005: when the
proxy serves a turn on a leg the user did not choose, can it *say so* by
reporting the served model in `message_start.model`, the way an Anthropic
plan fallback surfaces as a model change? That field is currently rewritten back
to the requested id by `restoreClientModel` (ADR-0001), which is what hides the
swap.

## Method

A stub upstream answers every turn with a configurable `message_start.model` and
logs the model each request carried. Turn 1 asks for `claude-sonnet-5` — neither
the machine's default model (`claude-opus-5`) nor any id the stub answers with,
so turn 2 separates three outcomes: the session kept the requested model, the
session adopted the answered model, or the session fell back to the default.
Turn 2 is `claude -p --resume <session_id>`.

Scripts: `probe-model-echo.sh` (three variants) and `probe-seeded.sh` (fourth),
both in the session scratchpad rather than the repo — they mutate
`~/.claude/cache/gateway-models.json` and are not suite material.

## Results

| Stub answers `model` = | Transcript records | Turn 2 requests |
| --- | --- | --- |
| *(echoes the request)* | `claude-sonnet-5` | `claude-sonnet-5` ✅ restored |
| `claude-deepseek-v4-flash[1m]` | `claude-deepseek-v4-flash[1m]` | `claude-opus-5` ❌ default |
| `deepseek-v4-flash` | `deepseek-v4-flash` | `claude-opus-5` ❌ default |
| `claude-deepseek-v4-flash[1m]`, discovery on and the model cache seeded to match | `claude-deepseek-v4-flash[1m]` | `claude-opus-5` ❌ default |

## Conclusion

The field is a restore key, not a notification channel. The control run proves the
restore path is live in headless mode — an echoed id comes back intact on resume.
Every mismatched answer breaks it, and the session lands on the machine's default
model, not on the answered one and not on the requested one. Seeding the cache so
the display id is genuinely resolvable changes nothing; the CLI does not adopt a
model it did not ask for.

So the swap cannot be announced this way, and it would be worse than silence: the
user's session model would quietly move to their default on the next resume.
`restoreClientModel` stays as it is.

What this probe does **not** settle: whether the interactive status line reacts to
the field mid-session. Headless `-p` has no status line. The resume behaviour is
enough to reject the approach either way — a mechanism that corrupts the session
model is not usable regardless of what it renders.

The remaining route to in-CLI visibility is injecting a visible text block into
the stream, which costs context on the following turn and is risky on a tool-use
turn. Not attempted. ADR-0005 removes the reason to need it by default: legs do
not cross unless asked.
