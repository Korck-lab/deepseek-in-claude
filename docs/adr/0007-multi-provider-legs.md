# ADR-0007 — Provider legs are a table, not a hardcoded pair

Status: accepted (2026-08-22)

## Context

The proxy shipped DeepSeek-only: the DeepSeek base URL, key, model list, display-id
prefix, and forwarding leg were all named globals (`DEEPSEEK_API_KEY`,
`deepseekModelList`, `deepseekRealId`, `handleDeepSeek`). Adding a second provider —
Xiaomi MiMo (`mimo-v2.5`, `mimo-v2.5-pro`) — as a feature touched every one of those
surfaces. Copying the pattern per provider would have produced two parallel
implementations, each of which later diverges; the third provider would then make the
problem worse.

Three properties of the second provider made a straightforward "clone the DeepSeek
branch" unacceptable:

1. **Different display-id contract.** DeepSeek advertises `claude-deepseek-v4-flash`;
   MiMo advertises `claude-mimo-v2.5` — no vendor word, because the model name already
   carries the vendor. The display prefix is per-provider (`claude-deepseek-` vs
   `claude-`), as is the set of accepted real ids and the strip regex used to round-trip
   them.
2. **Different capability reporting.** DeepSeek reports nothing about vision, and its
   window is a known 1M. Xiaomi reports neither capabilities nor a context window, yet
   `mimo-v2.5` can see images. So a per-model capability pin (`capabilities:` in
   `config.yml`) and a window default that can be upgraded by a reported value are both
   required, and both must work per provider.
3. **The window suffix is load-bearing.** Claude Code reads the context window from the
   advertised model id (`[1m]` marker), and from no other field. ADR-0001 established
   that for DeepSeek. A reported `context_window`/`max_context_length` from a provider's
   model list must be able to reach the display id; an unknown window must default
   conservatively rather than over-claim.

## Decision

Replace the DeepSeek-named globals with a `PROVIDERS` table keyed by provider name, one
entry per non-Anthropic leg:

```js
const PROVIDERS = {
  deepseek: { apiKey: DEEPSEEK_API_KEY, anthropicBase: DEEPSEEK_ANTHROPIC_BASE,
              root: DEEPSEEK_BASE_URL, prefix: "claude-deepseek-", windowDefault: 1_000_000,
              name: "DeepSeek", stripRe: /^deepseek-/, exclude: null },
  xiaomi:   { apiKey: XIOMIMIMO_API_KEY, anthropicBase: XIOMIMIMO_ANTHROPIC_BASE,
              root: XIOMIMIMO_ROOT, prefix: "claude-", windowDefault: null,
              name: "Mimo", stripRe: /^/, exclude: /-(asr|tts)(-|$)/i },
};
```

- **Model discovery is per-provider, union-served.** `providerModelList()` fetches each
  provider's `/v1/models` (single in-flight promise, 10-minute cache, `.env` seed
  fallback), filters `exclude`, reads vision capability and context window per model,
  and builds the union — served by both `GET /v1/models` and the `/_proxy/deepseek-models`
  seeding endpoint. Providers without a key contribute nothing; DeepSeek always seeds
  from `DEEPSEEK_MODEL`.
- **Routing is per-provider via `providerOf(id)`.** `providerOf` resolves a client model
  id to `{ provider, real }` by checking each provider's real-id set, then the display
  map (suffixed and bare — the bare form is what Claude Code sends after stripping the
  `[1m]` marker), then the stripped real id. The dispatch in `handle()` uses the
  resolved provider to pick the leg. Anthropic-family models and `--redir` targets stay
  DeepSeek-only in v1.
- **The leg is one shared function.** `forwardToProviderLeg(...)` carries the
  retry/splice machinery, effort map, `advisor_` drop, model-head buffering, and usage
  logging; the per-provider bits (key, base URL, display id, real-id resolver) are read
  from the `PROVIDERS` entry. `handleDeepSeek` and `handleXiaomi` are one-line wrappers.
- **Window: reported wins, default otherwise.** `readContextWindow(entry)` reads
  `context_window`/`max_context_length` when present; the effective window for a model
  is that reported value or the provider's `windowDefault`. `windowSuffixOf` appends
  `[1m]` when the effective window ≥ ~750k. Xiaomi's default is `null` (Claude Code
  assumes 200k for an unrecognized model) until its model list reports a real window —
  conservative, never over-claiming.
- **Vision: pin beats absence.** A model's capability resolves config override >
  provider-reported > id-derived default. Xiaomi reports nothing, so `mimo-v2.5` and
  `mimo-v2.5-pro` are pinned `vision: true` in `config.example.yml` (and the installed
  `config.yml` at deploy). That keeps their image turns on the Xiaomi leg instead of
  sending them to the Anthropic plan leg for a question the model could already answer.
- **Xiaomi audio models are excluded.** MiMo serves `-asr`/`-tts*` ids that are not
  usable in Claude Code; the `exclude` regex keeps them out of the model list and the
  picker.

## Consequences

- Adding a third provider is now a `PROVIDERS` row plus a `displayNameOf`/capability
  check, not a second copy of the forwarding leg. The shared leg is where streaming,
  retry, effort, and usage-log behavior are guaranteed consistent across providers.
- The display-id contract (ADR-0001) extends per provider: every display id keeps its
  provider prefix, and the `[1m]` suffix is only claimed when the effective window
  justifies it. A wrong claim would either truncate the real window (under-claim, safe)
  or promise a window the provider doesn't have (over-claim, the failure mode ADR-0001
  exists to prevent).
- Xiaomi turns are logged in `logs/proxy-usage.jsonl` like DeepSeek turns; the log's
  framing and this file's language shift from "DeepSeek" to "provider". Xiaomi does not
  participate in `--redir` or error-fallback in v1 — those stay DeepSeek-only, and a
  request whose model resolves to Xiaomi is never crossed.
- Vision routing (ADR-0004) now keys off the resolved target regardless of provider. A
  future vision-less Xiaomi model without a pin would be redirected exactly as a
  vision-less DeepSeek model is today — the capability map is provider-agnostic.
- The model-list order is provider-set order (DeepSeek first, then Xiaomi), which
  Claude Code surfaces in the picker; nothing about the union is sorted differently.
