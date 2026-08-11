<div align="center">

# deepseek-in-claude

**Run DeepSeek models in Claude Code — zero dependencies, zero protocol translation.**

DeepSeek models appear right in Claude Code's model picker. A small local proxy merges the Anthropic model list with DeepSeek's live model list, then forwards DeepSeek traffic to DeepSeek's Anthropic-compatible endpoint. Native Anthropic SSE in, native Anthropic SSE out.

Your Anthropic account is untouched: only DeepSeek-model traffic goes to DeepSeek, authenticated with your DeepSeek key. Everything else streams through to Anthropic exactly as before.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](#requirements)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-orange.svg)](#features)
[![GitHub stars](https://img.shields.io/github/stars/Korck-lab/deepseek-in-claude)](https://github.com/Korck-lab/deepseek-in-claude)

---

**Install in 30 seconds**

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
```

Then start Claude Code and pick a model with `/model`.

</div>

## Features

- **Zero dependencies** — Node built-ins only (`node:http`, `node:https`, `node:fs`). No `npm install`, no build step, no lockfile, no supply chain.
- **DeepSeek in the model picker** — models are fetched live from the DeepSeek API (10-minute cache) and merged into Anthropic's model list, so `deepseek-v4-flash` and `deepseek-v4-pro` show up natively and you select them with `/model` like any other model.
- **No protocol translation** — DeepSeek exposes an Anthropic-compatible endpoint, so the proxy forwards native Anthropic SSE. There is no adapter layer to break or debug.
- **Key isolation** — `DEEPSEEK_API_KEY` is injected as `x-api-key` only on the DeepSeek leg, and `authorization` is dropped there. Anthropic calls keep your normal Claude Code auth untouched.
- **Effort mapping** — Claude Code's `xhigh` effort folds into DeepSeek's `max`, so your effort preference is honored instead of silently ignored.
- **Instant `count_tokens`** — Claude Code's housekeeping call is answered locally with a fast estimate instead of hitting an undocumented endpoint.
- **Model aliases** — short names (`v4flash`, `v4-flash`, `v4pro`, `v4-pro`) are normalized to their `deepseek-*` ids wherever you configure models.
- **Silent by design** — no request logging, no audit files, no terminal noise.
- **Resilient** — if Anthropic's model list hiccups, the proxy still serves DeepSeek models. Your session is never bricked.

## Quickstart

One command installs the proxy into `~/.deepseek-in-claude`. A fresh install prompts for your API key — it opens the [key page](https://platform.deepseek.com/api_keys) and reads a hidden paste. Updates keep your existing `.env` untouched:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
```

Install somewhere else with `DEEPSEEK_IN_CLAUDE_HOME` — use an absolute path and `export` it first, or the variable won't reach the installer:

```bash
export DEEPSEEK_IN_CLAUDE_HOME="$HOME/.deepseek-in-claude"
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh | bash
```

Prefer to review the script first, or hit a terminal without a TTY (SSH without `-t`, CI)? Download it and run it — stdin stays yours, no pipe tricks:

```bash
curl -fsSL https://raw.githubusercontent.com/Korck-lab/deepseek-in-claude/main/scripts/install.sh -o /tmp/deepseek-in-claude-install.sh
bash /tmp/deepseek-in-claude-install.sh
```

Manual setup, three commands:

```bash
git clone https://github.com/Korck-lab/deepseek-in-claude
cd deepseek-in-claude
cp .env.example .env        # paste your DEEPSEEK_API_KEY
node proxy.mjs
```

## Use it in Claude Code

```bash
ANTHROPIC_BASE_URL=http://localhost:8016 claude
```

Then run `/model` and pick `deepseek-v4-flash` (or `deepseek-v4-pro`). Anthropic models still work — they pass through with your normal auth.

## How it works

Claude Code speaks Anthropic SSE. The proxy:

1. Intercepts `/v1/models` and merges the live Anthropic model list with the live DeepSeek list.
2. For every request whose `model` is a DeepSeek id, rewrites `authorization` → `x-api-key` and forwards to `$DEEPSEEK_ANTHROPIC_BASE_URL` (default `https://api.deepseek.com/anthropic`).
3. Streams everything else through to `api.anthropic.com` untouched.

## Redirect & fallback

`--redir` routes Claude Code's default models to DeepSeek counterparts, so the built-in models keep working without you switching anything: `haiku` / `sonnet` / `opus` → `deepseek-v4-flash`, `fable` → `deepseek-v4-pro`.

`--fallback` retries the other way when the routed upstream fails — error, timeout, or `404` / `429` / `5xx`. A redirected `sonnet` call that DeepSeek fails falls back to real Anthropic `sonnet`; a direct Anthropic call that fails falls back to its DeepSeek counterpart. Same relation map, both directions, one retry.

```bash
node proxy.mjs --redir --fallback
```

Configure the whole thing in a local YAML file instead (`config.yml`, override with `--config`) — `--redir` becomes just the toggle:

```yaml
port: 8016
redir:
  haiku: deepseek-v4-flash
  sonnet: deepseek-v4-flash
  opus: deepseek-v4-flash
  fable: deepseek-v4-pro
fallback: true
```

## Configuration

All variables come from `.env` or real environment variables (real vars win). Only the key is required — for DeepSeek traffic.

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

Precedence: CLI args > `config.yml` > `.env` > defaults. Run `node proxy.mjs --help` for the full flag list.

## Security

- The API key lives only in `.env` (gitignored) and is sent only to the DeepSeek API.
- No code is piped from curl straight into a shell — `install.sh` only does a shallow git checkout of `main`, then runs the proxy with `node`.
- Response streams are forwarded in identity encoding, so SSE framing is never corrupted.

## Requirements

- Node.js 18 or newer.
- A [DeepSeek API key](https://platform.deepseek.com/api_keys).
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — your existing Anthropic auth stays in charge of Anthropic traffic.

## Development

```bash
node --check proxy.mjs   # syntax check
bash scripts/test.sh     # feature smoke tests (real claude -p calls + mock upstream)
```

`scripts/test.sh` needs the `claude` CLI and a real `DEEPSEEK_API_KEY` — it makes a handful of tiny real API calls across the config matrix (default, `--port`, `--redir`, `--fallback`, YAML config).

## License

[MIT](LICENSE)
