# deepseek-in-claude

Run [DeepSeek](https://platform.deepseek.com) models inside [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — a zero-dependency local proxy that merges the Anthropic model list with DeepSeek's, so DeepSeek models appear in the Claude Code model picker. DeepSeek-model traffic is forwarded to DeepSeek's Anthropic-compatible endpoint with the DeepSeek key substituted. No protocol translation, no build step, Node built-ins only.

## Quickstart

One-shot install straight from the repo (checkout lives in `~/.deepseek-in-claude`, override with `DEEPSEEK_IN_CLAUDE_HOME`). Fresh installs prompt for your API key — it opens the [key page](https://platform.deepseek.com/api_keys) and reads a hidden paste. Updates keep your existing `.env` untouched:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
```

Prefer reviewing the script first, or hit terminal weirdness (no controlling tty: SSH without `-t`, CI)? Download then run — stdin stays yours, no pipe tricks:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh -o /tmp/deepseek-in-claude-install.sh
bash /tmp/deepseek-in-claude-install.sh
```

Manual clone:

```bash
git clone https://github.com/Korck-lab/deepseek-in-claude
cd deepseek-in-claude
cp .env.example .env        # paste your DEEPSEEK_API_KEY
node proxy.mjs
```

Then point Claude Code at it and pick a DeepSeek model with `/model`:

```bash
ANTHROPIC_BASE_URL=http://localhost:8016 claude
```

Anthropic traffic still works — it passes through untouched with your normal auth.

## Features

- **Zero dependencies** — Node built-ins only (`node:http`, `node:https`, `node:fs`). No `npm install`, no build, no lockfile.
- **Model merge** — DeepSeek models are fetched live from the API (10-minute cache) and merged into Anthropic's list, so they show up natively in the Claude Code model picker.
- **No protocol translation** — DeepSeek exposes an Anthropic-compatible endpoint; the proxy forwards native Anthropic SSE.
- **Key substitution** — `DEEPSEEK_API_KEY` is injected as `x-api-key` only on the DeepSeek leg; `authorization` is dropped there. Anthropic calls use your existing Claude Code auth untouched.
- **Effort mapping** — Claude Code `xhigh` effort folds into DeepSeek's `max` so effort is honored, not silently ignored.
- **`count_tokens` answered locally** — Claude Code's housekeeping call gets a fast local estimate instead of hitting an undocumented endpoint.
- **Lightweight and silent** — no request logging, no audit files, no terminal noise.

## How it works

Claude Code speaks Anthropic SSE. The proxy:

1. Intercepts `/v1/models` and merges the live Anthropic model list with the live DeepSeek list.
2. For every request whose `model` is a DeepSeek id, rewrites `authorization` → `x-api-key` and forwards to `$DEEPSEEK_ANTHROPIC_BASE` (default `https://api.deepseek.com/anthropic`).
3. Everything else streams through to `api.anthropic.com` untouched.

## Configuration

All variables come from `.env` or real env vars (real vars win). Only the key is required — for DeepSeek traffic.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Required. DeepSeek API key. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API base URL. |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro,deepseek-v4-flash` | Comma-separated model fallbacks shown in the picker. |
| `DEEPSEEK_ANTHROPIC_BASE_URL` | `$DEEPSEEK_BASE_URL/anthropic` | DeepSeek's Anthropic-compatible endpoint. |
| `PORT` | `8016` | Proxy listen port. |

Example:

```env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-flash,deepseek-v4-pro
```

## Usage

```bash
node proxy.mjs
```

then

```bash
ANTHROPIC_BASE_URL=http://localhost:8016 claude
```

Select a DeepSeek model with `/model` (e.g. `deepseek-v4-flash`). Everything else behaves like a normal Claude Code session — your Anthropic models and auth are unaffected.

## Redirect & fallback

`--redir` routes Anthropic family models to DeepSeek counterparts, so Claude Code's default models keep working without switching: `haiku`/`sonnet`/`opus` → `deepseek-v4-flash`, `fable` → `deepseek-v4-pro`.

`--fallback` retries the other way when the routed upstream fails (error, timeout, `404`/`429`/`5xx`): a redirected `sonnet` call that DeepSeek fails falls back to real Anthropic `sonnet` — and a direct Anthropic call that fails falls back to its DeepSeek counterpart. Same relation map, both directions, one retry.

```bash
node proxy.mjs --redir --fallback
```

All of it can be configured in a local YAML file instead (`config.yml`, override with `--config`), so `--redir` becomes just the toggle:

```yaml
port: 8016
redir:
  haiku: deepseek-v4-flash
  sonnet: deepseek-v4-flash
  opus: deepseek-v4-flash
  fable: deepseek-v4-pro
fallback: true
```

Precedence: CLI args > `config.yml` > `.env` > defaults. Run `node proxy.mjs --help` for the full flag list.

## Auto-versioning

Local git hooks bump the version and tag releases automatically from [conventional commit](https://www.conventionalcommits.org) messages — no manual version edits, no CI needed.

```bash
git config core.hooksPath .githooks
```

On every commit it reads the commit message and:

| Commit type | Example | Bump |
| --- | --- | --- |
| breaking | `feat!: drop node 18`, or `BREAKING CHANGE` in body | major |
| `feat:` | `feat: add effort mapping` | minor |
| `fix:` / `perf:` | `fix: count_tokens estimate` | patch |
| anything else | `docs:`, `chore:`, `test:`, `refactor:` | none |

The `post-commit` hook reads the real message from `COMMIT_EDITMSG`, bumps `VERSION` (e.g. `0.1.0` → `0.2.0`), amends the commit so the bump lands in it, then creates an annotated tag `vX.Y.Z`. Merge commits never re-bump; amend runs skip (the tag already exists). Override anytime by editing `VERSION` manually.

## Development

```bash
node --check proxy.mjs   # syntax check
bash scripts/test.sh     # feature smoke tests (real claude -p calls + mock upstream)
```

Requires Node.js >= 18. `scripts/test.sh` needs the `claude` CLI and a real `DEEPSEEK_API_KEY` — it makes a handful of tiny real API calls across the config matrix (default, `--port`, `--redir`, `--fallback`, YAML config).

## Security

- The API key lives only in `.env` (gitignored) and is sent only to the DeepSeek API.
- No code is piped from curl straight into a shell — `install.sh` only does a shallow git checkout of `main`, then runs the proxy with `node`.
- Response streams are forwarded in identity encoding, so SSE framing is never corrupted.

## License

[MIT](LICENSE)
