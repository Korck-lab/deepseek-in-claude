# Audit disposition — August 2026

A six-lens bug hunt over `proxy.mjs`, `claudei.sh` and `scripts/` produced 38
findings. Every one has a disposition below. Fixes landed in six commits,
`v0.6.9`–`v0.6.14`, each verified before it shipped.

Two findings were declined and two were wrong. Those four are the interesting
rows; the rest were fixed as reported.

## Not fixed

| # | Finding | Why |
|---|---------|-----|
| 2 | OAuth credentials visible in `ps` during a keychain write | **The premise was wrong.** Both argv-free routes the `security` CLI offers truncate a real payload. `-w` with no value reads through getpass and caps at exactly 128 bytes; `security -i` caps its command line near 4KB and reports the overflow as an unknown command. The credential blob measured 22467 bytes. A truncated write costs the user a `/login`, which is worse than the exposure. Shipped and reverted in `4e7ff3f`/`391e373`; the measurements are recorded at the call site and in the README. |
| 8 | `tools[N]` retry regex is brittle to DeepSeek error-format changes | **Declined as stated.** The index appears nowhere but that prose message, so there is no more robust source to read it from. Instead, an "unknown variant" 400 carrying no parsable index now logs the upstream text rather than forwarding an opaque 400. |
| 24 | `debugStream` concurrent writes can interleave past `PIPE_BUF` | **Declined.** Reachable only under `--debug` with concurrent requests whose log lines exceed the pipe buffer. A write queue is more machinery than a cosmetic tear in a hand-run diagnostic log warrants. Noted at the call site. |
| 26 | `refreshDeepseekIds()` fire-and-forget races the first request | **Real, but not for the stated reason** — and worse. The duplicate-fetch half was already resolved by the in-flight guard in `0b5472c`. What remained was that `displayToReal` stayed empty until the first fetch landed, so `claude-deepseek-v4-flash[1m]` — the id the picker actually sends — did not resolve during startup and fell through to Anthropic. Fixed in `d9aca77` by seeding the map synchronously. |

## Fixed

| # | Area | Commit |
|---|------|--------|
| 1 | Bind to loopback; per-install random sentinel | `44704ed`, `1db74bc` |
| 3 | `server.on('error')` for EADDRINUSE | `44704ed` |
| 4 | PORT chain consults `.env`; validates instead of `??`-chaining | `44704ed` |
| 5, 14 | In-flight guards on the model-list and credential caches | `0b5472c` |
| 6 | 408 added to `FALLBACK_STATUS` | `469dd6c` |
| 7 | `loadYaml` accepts quoted keys; names unparsable settings | `469dd6c`, `f2b59e0` |
| 9 | `serveModels` warns when it serves a DeepSeek-only list | `469dd6c` |
| 10 | `familyOf` matches segments, not substrings | `469dd6c` |
| 11 | `normalizeModel` expands shorthand only, never blind-prefixes | `469dd6c` |
| 12, 13 | Upstream timers disarmed at handoff; explicit response ownership | `30c48d3` |
| 15 | 10s timeout on `security` calls | `30c48d3` |
| 16 | `autoversion` rejects a malformed VERSION file | `fe3bd67` |
| 17 | Failed `claude update` warns instead of aborting | `fe3bd67` |
| 18 | Only ever signal a process that is still our proxy | `fe3bd67` |
| 19 | EXIT trap stops the proxy on interruption | `fe3bd67` |
| 20 | Clear error for a non-git destination directory | `fe3bd67` |
| 21 | `seq` replaced with a counted loop | `fe3bd67` |
| 22 | Pre-flight checks in `test.sh` | `fe3bd67` |
| 23 | Zero-padded YAML values stay strings | `d9aca77` |
| 25 | Both error paths emit the same Anthropic-shaped body | `30c48d3` |
| 27 | Effort-map comment corrected | `d9aca77` |
| 28 | Retry body passed as a parameter, not closure-mutated | `d9aca77` |
| 29 | Graceful shutdown on SIGTERM/SIGINT | `d9aca77` |
| 30–36 | `claudei.sh`: printf for VERSION, per-user 0700 state dir, SHA-256, kill escalation, 0600 log, `--fallback` respects config, permissions flag configurable | `fe3bd67` |
| 37, 38 | `.env` written atomically; pasted key trimmed | `fe3bd67` |

## Tests added

Nothing covered `proxy.mjs` before this. Three suites now do, and each was
confirmed to fail on the commit before its fix:

- `scripts/test-parsing.sh` — 30 cases over `loadYaml`, `familyOf`,
  `normalizeModel`. Slices the functions out of the real file, so a failed
  extraction errors rather than passing vacuously.
- `scripts/test-model-race.sh` — counting stub in place of DeepSeek; asserts N
  concurrent `/v1/models` cause at most one upstream fetch.
- `scripts/test-fallback-race.sh` — stub answers 503 and goes silent while the
  real Anthropic leg streams, with a short `UPSTREAM_TIMEOUT_MS` so the
  abandoned leg's timer fires mid-stream. Needs credentials and spends ~2.5k
  output tokens; skips itself if the auth bridge cannot authenticate.

`scripts/test.sh` runs the first two suites itself and gates the third behind
`RUN_SLOW_TESTS=1`, so none of them depends on someone knowing its name. It
passes 21/21, or 22/22 with the slow suite included.

## Known limits

- A `SIGKILL` to `claudei.sh` still orphans the proxy — uncatchable by
  definition. The next launch reclaims it by port.
- A `SIGTERM` aimed at `claudei.sh` alone is deferred by bash until `claude`
  exits. Cleanup still runs; it is not immediate.
- `/v1/models` merges the Anthropic catalog only when the request carries both
  the sentinel and an `anthropic-version` header. Without them the proxy serves
  DeepSeek models alone and now says so on stderr.
