# ADR-0006 — Development tests never bind or stop the live proxy

Status: accepted (2026-08-16; amended — also covers stopping the live proxy by process pattern)

## Context

`claudei.sh` runs the proxy as a pooled singleton: one listener on the default
port 8016 serves every Claude Code session on the machine (see ADR-0005). The
developer's own working session — the one running this very proxy — depends on
that listener. Anything that starts, stops, or mistakes a process on 8016 puts
that session at risk.

The test suite was not hermetic against that port. In `scripts/test.sh`, the
T2/T3/T4 block calls `start_proxy 8016` with no `--port` argument, so the test
proxy inherits the proxy's default port — 8016 itself. The other blocks pass
explicit ports (8002–8013, 8017); only the default-config case omitted the flag,
because the default-config test wanted the default port. That is exactly the
wrong port to want in a dev run.

Two failure modes follow, both measured:

1. **The suite adopts a proxy it did not start.** When no live proxy is running,
   the test proxy binds 8016 and passes the launcher's ownership check — the
   launcher's `proxy_pid` falls back to `lsof -ti :8016` when the pid file is
   stale, and `pid_is_proxy` accepts any `proxy.mjs` process on that port. A
   `claudei` launch during the suite then treats the test artifact as the live
   proxy. When the suite's `cleanup` kills that pid, the developer's session dies
   with it — out of work, from a test they only ran to change something.
2. **The suite silently tests the live proxy.** When a live proxy is already on
   8016, the test proxy dies on `EADDRINUSE`, but `start_proxy`'s readiness wait
   still succeeds — `curl localhost:8016/v1/models` answers from the live
   process. T2–T4 then run real `claude -p` traffic through the developer's own
   proxy and report green for a proxy that was never under test.
3. **The suite stops the live proxy by process pattern.** `test-session-pool.sh`
   cleaned up with `pkill -f "proxy\.mjs"` — intended for the stub proxy it
   started, but the pattern matches every process whose command line contains
   `proxy.mjs`, including the live pooled proxy under `$PROXY_HOME`. Running the
   suite killed the developer's own proxy mid-session, which then had to be
   restarted by hand. Same root defect as the port cases, on the process name
   rather than the port: the suite identified its own artifact too broadly.

All three are the same root defect: the live proxy is a load-bearing singleton,
and the suite identified its own artifacts by default — the default port, or the
process name — instead of by what it actually started.

## Decision

Development tests never bind port 8016, and no test start relies on the proxy's
default port. Every proxy the suite starts passes an explicit `--port` on a
scratch port outside the live range; 8016 is reserved for the pooled live proxy
and is never started, stopped, or readiness-probed by the suite. Nor does a test
stop a proxy by a pattern broader than the artifact it started: any kill in the
suite is scoped to the process under test — `test-session-pool.sh` pkills the
stub proxy's path under its own scratch dir, never a bare `proxy\.mjs`.

Concretely, the default-config block in `scripts/test.sh` becomes an explicit
scratch port (e.g. `--port 8015`), like every other block. The readiness wait in
`start_proxy` then answers only when the proxy under test is actually up, because
no unrelated process owns that scratch port.

## Consequences

- The suite can run while a live session is active, without risking that session.
  That is the point: development happens against a running proxy, not instead of
  one.
- The `EADDRINUSE`-then-green trap is gone. A test that fails to bind now fails
  loudly, as `start_proxy` does for any other unavailable port.
- The launcher can no longer adopt a test proxy as the live one: nothing the
  suite starts can be found on 8016.
- Guard: `scripts/test.sh` must contain no `start_proxy` call without `--port`,
  and `test-session-pool.sh` case `P7` asserts a foreign `proxy.mjs` outside the
  suite's scratch dir survives the cleanup. Both are the suite's own guards — a
  regression reintroduces the failure modes above, so the checks belong in the
  suite, not in the launcher.
- The 8016 exclusion is a convention, enforced by review; the launcher itself
  does not change. A future test that binds 8016 for a legitimate reason would
  need to revisit this ADR.
