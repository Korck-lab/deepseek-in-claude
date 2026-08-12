/**
 * deepseek-in-claude — DeepSeek models inside Claude Code.
 *
 * A zero-dependency local proxy for Claude Code. It merges the Anthropic model
 * list with the DeepSeek model list so DeepSeek models appear in the Claude
 * Code model picker, then forwards DeepSeek-model traffic to DeepSeek's
 * Anthropic-compatible endpoint (https://api.deepseek.com/anthropic) with the
 * DeepSeek key substituted — no protocol translation needed, the CLI sees
 * native Anthropic SSE either way. Anthropic-model traffic still passes
 * through untouched.
 *
 * Run:   node proxy.mjs [--port N] [--redir] [--fallback] [--config config.yml]
 * Point Claude Code at it:
 *   ANTHROPIC_BASE_URL=http://localhost:8016 claude
 *
 * Config precedence: CLI args > config.yml > .env > defaults.
 * Env vars: DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL,
 *           DEEPSEEK_ANTHROPIC_BASE_URL, PORT
 *
 * Zero runtime dependencies — Node built-ins only. Requires Node 18+.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config: CLI args > config.yml > .env > defaults
// ---------------------------------------------------------------------------

const FALLBACK_STATUS = new Set([404, 429, 500, 501, 502, 503, 504]);

function parseArgs(argv) {
  const out = { port: null, redir: false, fallback: null, config: null, debug: false, help: false, noAuthBridge: false, oauthRefresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = argv[++i] ?? null; // validated by firstPort()
    else if (a === "--redir") out.redir = true;
    else if (a === "--fallback") out.fallback = true;
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--debug") out.debug = true;
    else if (a === "--no-auth-bridge") out.noAuthBridge = true;
    else if (a === "--oauth-refresh") out.oauthRefresh = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/** Minimal YAML subset: comments, scalars (string/number/bool), nested maps by indent. */
function loadYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const key = m[1];
    const val = m[2].split(/\s+#/)[0].trim();
    if (val === "") {
      const next = {};
      stack[stack.length - 1].obj[key] = next;
      stack.push({ indent, obj: next });
    } else {
      stack[stack.length - 1].obj[key] =
        val === "true" ? true : val === "false" ? false : /^\d+$/.test(val) ? Number(val) : val.replace(/^["']|["']$/g, "");
    }
  }
  return root;
}

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log(`deepseek-in-claude proxy

Usage: node proxy.mjs [options]

  --port N          listen port (default 8016)
  --redir           route Anthropic family models (haiku/sonnet/opus/fable) to
                    DeepSeek via the redir map (config.yml or built-in defaults)
  --fallback        on upstream failure retry the other way — DeepSeek <-> Anthropic,
                    same redir relation, both directions
  --config PATH     YAML config file (default ./config.yml)
  --debug           log every request/response to /tmp/deepseek-proxy-payloads.jsonl
  --no-auth-bridge  do not substitute your Claude Code OAuth token for the
                    ANTHROPIC_AUTH_TOKEN sentinel on the Anthropic leg
                    (Anthropic models then answer 401 in sentinel mode)
  --oauth-refresh   allow the proxy to run the OAuth refresh grant and write the
                    rotated token back to your credential store when it expires
                    (off by default; without it an expired token just warns)
  --help            show this help

Config precedence: CLI args > config.yml > .env > defaults.`);
  process.exit(0);
}

/** Parse a `.env` file into a plain object. Defined here rather than beside the
 * DeepSeek settings below because PORT resolution needs it — a `const ENV` read
 * before its initializer throws at import time. */
function loadEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(HERE, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env */
  }
  return out;
}

const ENV = loadEnv();

const CONFIG_PATH = ARGS.config ?? path.join(HERE, "config.yml");
let CFG = {};
try {
  CFG = loadYaml(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch {
  /* no config.yml — defaults stand */
}

/** First source that yields a usable TCP port. Plain `??` chaining is wrong for
 * this: `--port foo` produces NaN and `PORT=` in .env produces "", both of which
 * are non-nullish and would win over every later source. */
function firstPort(...candidates) {
  for (const c of candidates) {
    if (c == null || c === "") continue;
    const n = Number(c);
    // 0 is a valid listen() argument but means "any free port", which nothing
    // pointed at a fixed base URL could ever reach — reject it like any junk.
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    console.error(`[config] ignoring invalid port value ${JSON.stringify(c)}`);
  }
  return 8016;
}

// Documented precedence: CLI args > config.yml > real env > .env > default.
const PORT = firstPort(ARGS.port, CFG.port, process.env.PORT, ENV.PORT);
// Loopback only. The proxy holds the DeepSeek key and bridges the user's
// Anthropic OAuth token, so a 0.0.0.0 bind would hand both to any LAN host.
const HOST = CFG.host ?? "127.0.0.1";
const UPSTREAM = "api.anthropic.com";

// ---------------------------------------------------------------------------
// Payload debug log — `--debug` writes one JSON line per request/response so the
// exact payloads Claude Code sends and the proxy returns can be inspected.
// ---------------------------------------------------------------------------

const DEBUG = ARGS.debug || Boolean(CFG.debug);
const DEBUG_LOG = "/tmp/deepseek-proxy-payloads.jsonl";
let debugStream = null;
if (DEBUG) {
  try {
    debugStream = fs.createWriteStream(DEBUG_LOG, { flags: "a" });
  } catch {
    debugStream = null;
  }
}

function debugLog(entry) {
  if (!debugStream) return;
  try {
    debugStream.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* ignore */
  }
}

/** Summarize a request body: method, model, first tool name, byte size. Never
 * logs message content or auth headers — only routing-relevant shape. */
function summarizeBody(body, reqHeaders) {
  const out = { bytes: body.length };
  try {
    const j = JSON.parse(body.toString("utf8"));
    if (j.model) out.model = j.model;
    if (Array.isArray(j.tools) && j.tools.length) out.tools = j.tools.map((t) => t?.name ?? t?.type).filter(Boolean).slice(0, 5);
    if (j.stream !== undefined) out.stream = j.stream;
    if (j.max_tokens) out.max_tokens = j.max_tokens;
    if (j.output_config?.effort) out.effort = j.output_config.effort;
    if (j.thinking?.type) out.thinking = j.thinking.type;
  } catch {
    /* non-JSON body */
  }
  if (reqHeaders?.["anthropic-version"]) out.anthropicVersion = reqHeaders["anthropic-version"];
  return out;
}

const normalizeModel = (id) => {
  const s = String(id);
  if (s.includes("deepseek-")) return s;
  if (s === "v4flash" || s === "v4-flash") return "deepseek-v4-flash";
  if (s === "v4pro" || s === "v4-pro") return "deepseek-v4-pro";
  return `deepseek-${s}`;
};

const DEFAULT_REDIR = {
  haiku: "deepseek-v4-flash",
  sonnet: "deepseek-v4-flash",
  opus: "deepseek-v4-flash",
  fable: "deepseek-v4-pro",
};

const redirOn = ARGS.redir === true || Boolean(CFG.redir && typeof CFG.redir === "object");
const FALLBACK = ARGS.fallback != null ? ARGS.fallback : CFG.fallback ?? redirOn;

/** Relation map: family key -> DeepSeek model. Redirects when redirOn, and is
 * the fallback relation (both ways) when FALLBACK is set. */
const REDIR_MAP =
  CFG.redir && typeof CFG.redir === "object"
    ? Object.fromEntries(Object.entries(CFG.redir).map(([k, v]) => [k, normalizeModel(v)]))
    : redirOn || FALLBACK
      ? { ...DEFAULT_REDIR }
      : null;

const FAMILY_KEYS = REDIR_MAP ? Object.keys(REDIR_MAP) : [];

/** First redir key contained in the model id — "claude-sonnet-4-5" -> "sonnet". */
function familyOf(modelId) {
  if (!REDIR_MAP) return null;
  const id = String(modelId ?? "").toLowerCase();
  for (const key of FAMILY_KEYS) if (id.includes(key)) return key;
  return null;
}

// ---------------------------------------------------------------------------
// Config from .env (real env vars win)
// ---------------------------------------------------------------------------

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ENV.DEEPSEEK_API_KEY ?? "";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? ENV.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
const DEEPSEEK_ANTHROPIC_BASE = (process.env.DEEPSEEK_ANTHROPIC_BASE_URL ?? `${DEEPSEEK_BASE_URL}/anthropic`).replace(/\/+$/, "");
const DEEPSEEK_MODEL = (process.env.DEEPSEEK_MODEL ?? ENV.DEEPSEEK_MODEL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FALLBACK_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
const DEFAULT_MODELS = DEEPSEEK_MODEL.length ? DEEPSEEK_MODEL : FALLBACK_MODELS;

/** Rough token estimate for count_tokens. */
const estTokens = (bytes) => Math.round(bytes / 4);

/** count_tokens is a housekeeping call Claude Code fires constantly. DeepSeek's
 * Anthropic endpoint does not document it, so answer locally with an estimate. */
const isTokenCount = (reqPath) => reqPath.includes("count_tokens");

/** Strip hop-by-hop and encoding headers so the captured response is readable,
 * recompute content-length, and pass auth through untouched so the real request
 * still authenticates. */
function forwardHeaders(headers, body) {
  const out = { ...headers };
  delete out["host"];
  delete out["connection"];
  delete out["accept-encoding"]; // force identity so we can read the stream
  delete out["transfer-encoding"];
  delete out["content-length"];
  if (body.length > 0) out["content-length"] = String(body.length);
  return out;
}

/** Strip hop-by-hop/framing headers from an upstream response so Node
 * re-frames the client stream — verbatim passthrough corrupts SSE framing. */
function cleanResponseHeaders(headers) {
  const out = { ...headers };
  delete out["connection"];
  delete out["transfer-encoding"];
  delete out["content-encoding"]; // we forced identity upstream
  return out;
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const headers = { ...(options.headers ?? {}) };
    const body = options.body ? Buffer.from(options.body) : null;
    if (body) headers["content-length"] = String(body.length);
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: options.method ?? "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode ?? 0, json, raw });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sendError(res, status, type, message) {
  if (!res.headersSent) res.writeHead(status ?? 500, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: type ?? "api_error", message } }));
}

// ---------------------------------------------------------------------------
// Anthropic credential bridge
//
// Claude Code only performs gateway model discovery — the thing that puts
// DeepSeek in the `/model` picker — when ANTHROPIC_AUTH_TOKEN (or an API key)
// is set. But that same credential then takes precedence over the claude.ai
// login for *every* request, so a placeholder value makes real Anthropic models
// answer 401.
//
// The bridge resolves that: Claude Code is given a sentinel token, and requests
// arriving with exactly that sentinel get the user's real Claude Code OAuth
// access token substituted on the Anthropic leg (plus the `oauth-2025-04-20`
// beta the OAuth path requires). Any other Authorization value is passed
// through untouched. Credentials are read from the same store the CLI uses —
// the macOS keychain, or ~/.claude/.credentials.json elsewhere — read-only
// unless --oauth-refresh is passed, in which case an expired token is renewed
// through the OAuth refresh grant and written back.
// ---------------------------------------------------------------------------

const AUTH_BRIDGE = ARGS.noAuthBridge ? false : CFG.authBridge !== false;
const AUTH_SENTINEL = CFG.sentinel ?? process.env.ANTHROPIC_AUTH_SENTINEL ?? "local-deepseek-proxy";
// Refreshing is the only thing here that *writes* to the credential store the
// real CLI depends on, so it is opt-in: a botched rotation would force the user
// to `/login` again. Left off, an expired token simply warns and 401s, and any
// normal `claude` session refreshes the store for us within CRED_CACHE_TTL.
const OAUTH_REFRESH = ARGS.oauthRefresh === true || CFG.oauthRefresh === true;
const OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const CRED_CACHE_TTL = 30 * 1000;
// Refresh a little before the deadline so an in-flight request can't age out.
const CRED_EXPIRY_MARGIN = 60 * 1000;

let credCache = { at: 0, token: null };
let credInFlight = null;
// Keyed per message: a single flag would let the first warning ever printed
// swallow every later one, including the "run `claude` to re-authenticate" hint.
const credWarned = new Set();
let refreshInFlight = null;

function warnOnce(message) {
  if (credWarned.has(message)) return;
  credWarned.add(message);
  console.error(`[auth-bridge] ${message}`);
}

/** Run a command. Returns stdout, or null on any non-zero exit — every caller
 * treats failure as "credential store unavailable" and falls back, so the exit
 * code itself carries no extra information. */
const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });

/** Read the CLI's credential store. Returns { creds, store } or null. */
async function readCredentials() {
  if (process.platform === "darwin") {
    const raw = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    if (raw) {
      try {
        return { creds: JSON.parse(raw), store: "keychain" };
      } catch {
        /* corrupt keychain item — try the file next */
      }
    }
  }
  try {
    return { creds: JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8")), store: "file" };
  } catch {
    return null;
  }
}

/** Persist rotated tokens so normal `claude` sessions keep working. Never
 * throws: a token we hold is still usable in memory even if the store rejects
 * it, and losing it over a failed write would 401 a request that could succeed. */
async function writeCredentials(store, creds) {
  try {
    const raw = JSON.stringify(creds);
    if (store === "keychain") {
      // The payload goes in as an argv element, so it is visible to `ps` for
      // the lifetime of the call — one more reason refreshing is opt-in. Both
      // argv-free routes the `security` CLI offers were measured and silently
      // truncate a real credential blob (~22KB here): `-w` with no value reads
      // through getpass and caps at 128 bytes, and `security -i` caps its
      // command line near 4KB, storing a prefix and reporting the rest as an
      // unknown command. A partial write costs the user a `/login`, which is
      // worse than the exposure, so argv stands until there is a route that
      // does not truncate.
      await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", os.userInfo().username, "-w", raw]);
      return;
    }
    fs.writeFileSync(CREDENTIALS_FILE, raw, { mode: 0o600 });
  } catch (err) {
    warnOnce(`could not persist the refreshed token: ${err.message}`);
  }
}

/** Exchange the refresh token for a fresh access token. Serialised through a
 * single in-flight promise: refresh tokens rotate, so two concurrent grants
 * would spend the same one twice and race to write the loser's result back. */
function refreshOauth(creds, store) {
  if (!refreshInFlight) {
    refreshInFlight = refreshOauthOnce(creds, store).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function refreshOauthOnce(creds, store) {
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.refreshToken) return null;
  const grant = { grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID };
  // The token endpoint is documented for both encodings; try JSON, then form.
  const encodings = [
    { "content-type": "application/json", body: JSON.stringify(grant) },
    { "content-type": "application/x-www-form-urlencoded", body: new URLSearchParams(grant).toString() },
  ];
  let json = null;
  for (const enc of encodings) {
    const res = await fetchJson(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": enc["content-type"], accept: "application/json" },
      body: enc.body,
    }).catch(() => ({ status: 0, json: null }));
    if (res.status === 200 && res.json?.access_token) {
      json = res.json;
      break;
    }
  }
  if (!json) return null;
  creds.claudeAiOauth = {
    ...oauth,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? oauth.refreshToken,
    expiresAt: Date.now() + Number(json.expires_in ?? 0) * 1000,
  };
  await writeCredentials(store, creds);
  return creds.claudeAiOauth.accessToken;
}

/** The user's current Claude Code OAuth access token, or null.
 *
 * Serialised the same way as the model list, and for a sharper reason: a cache
 * miss shells out to `security`, so a burst of requests would spawn one
 * keychain process each. Worse, each of those can decide the token is expired
 * and enter the refresh path — refreshOauth() already collapses the grant
 * itself, but only after the work of getting there has been duplicated. */
async function anthropicAccessToken() {
  if (credCache.token && Date.now() - credCache.at < CRED_CACHE_TTL) return credCache.token;
  if (!credInFlight) {
    credInFlight = anthropicAccessTokenOnce().finally(() => {
      credInFlight = null;
    });
  }
  return credInFlight;
}

async function anthropicAccessTokenOnce() {
  const found = await readCredentials();
  if (!found) {
    warnOnce("no Claude Code credentials found — Anthropic models will not authenticate");
    return null;
  }
  const oauth = found.creds?.claudeAiOauth;
  if (!oauth?.accessToken) {
    warnOnce("credential store has no claude.ai OAuth token — run `claude` and log in");
    return null;
  }
  let token = oauth.accessToken;
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt - CRED_EXPIRY_MARGIN <= Date.now()) {
    if (!OAUTH_REFRESH) {
      warnOnce("OAuth token expired — run `claude` once to refresh it, or start the proxy with --oauth-refresh");
      return null;
    }
    token = await refreshOauth(found.creds, found.store);
    if (!token) {
      warnOnce("OAuth token expired and refresh failed — run `claude` once to re-authenticate");
      return null;
    }
  }
  credCache = { at: Date.now(), token };
  return token;
}

/** Swap the sentinel for real credentials on the Anthropic leg. No-op for any
 * other Authorization value, so a real token is never touched. */
async function applyAnthropicAuth(headers) {
  if (!AUTH_BRIDGE) return headers;
  if (headers.authorization !== `Bearer ${AUTH_SENTINEL}`) return headers;
  let token = null;
  try {
    token = await anthropicAccessToken();
  } catch (err) {
    warnOnce(`credential lookup failed: ${err.message}`);
  }
  if (!token) return headers;
  headers.authorization = `Bearer ${token}`;
  const betas = String(headers["anthropic-beta"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  headers["anthropic-beta"] = betas.join(",");
  return headers;
}

// ---------------------------------------------------------------------------
// DeepSeek model list — live from the API, cached, fallback to .env
// ---------------------------------------------------------------------------

const MODEL_CACHE_TTL = 10 * 60 * 1000;
let dsModelsCache = { at: 0, models: null };
let dsModelsInFlight = null;

// Real DeepSeek model ids this proxy will route to upstream.
let deepseekIds = new Set(DEFAULT_MODELS);
// Display id -> real id. Claude Code's gateway model discovery drops any model
// whose id fails /(claude|anthropic)/i, so we serve DeepSeek models under a
// `claude-deepseek-*` display id and rewrite it back to the real id on request.
const DISPLAY_PREFIX = "claude-deepseek-";
// Claude Code sizes the context window of a model it doesn't know from the id
// itself: a `[1m]` suffix (case-insensitive, matched by regex, no catalog
// lookup) means a 1M window; anything else falls back to 200k. The
// `CLAUDE_CODE_MAX_CONTEXT_TOKENS` env var can't substitute here — it is
// ignored for any id starting with `claude-`, which the discovery filter forces
// on us. The suffix is stripped again before the request reaches DeepSeek.
const DISPLAY_SUFFIX = "[1m]";
const stripWindowSuffix = (id) => String(id).replace(/\[1m\]$/i, "");
let displayToReal = new Map();

function displayIdOf(id) {
  return `${DISPLAY_PREFIX}${String(id).replace(/^deepseek-/, "")}${DISPLAY_SUFFIX}`;
}

function displayNameOf(id) {
  const pretty = String(id)
    .replace(/^deepseek-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `DeepSeek ${pretty}`;
}

function toModelEntry(id, created) {
  return {
    id: displayIdOf(id),
    display_name: displayNameOf(id),
    created_at: created || Math.floor(Date.now() / 1000),
    type: "model",
  };
}

/** The DeepSeek model list, cached for MODEL_CACHE_TTL.
 *
 * Serialised through a single in-flight promise: the TTL check and the cache
 * write are far apart (a network round trip), so concurrent callers would all
 * see an empty cache, all fetch, and all clobber `deepseekIds` /
 * `displayToReal` in whatever order they happened to finish. Claude Code opens
 * several /v1/models requests at once at startup, so this is the common path,
 * not an edge case. */
async function deepseekModelList() {
  if (dsModelsCache.models && Date.now() - dsModelsCache.at < MODEL_CACHE_TTL) return dsModelsCache.models;
  if (!dsModelsInFlight) {
    dsModelsInFlight = fetchDeepseekModelList().finally(() => {
      dsModelsInFlight = null;
    });
  }
  return dsModelsInFlight;
}

async function fetchDeepseekModelList() {
  const models = new Map();
  for (const id of DEFAULT_MODELS) models.set(id, toModelEntry(id, 0));
  if (DEEPSEEK_API_KEY) {
    try {
      const { status, json } = await fetchJson(`${DEEPSEEK_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      });
      if (status === 200 && json?.data) {
        for (const m of json.data) if (m?.id) models.set(m.id, toModelEntry(m.id, m.created ?? 0));
      }
    } catch {
      /* models fetch failed — fallback list stands */
    }
  }
  const list = [...models.values()];
  deepseekIds = new Set(models.keys());
  // Key both the suffixed display id and its bare form — Claude Code keeps both
  // in play when it resolves a model name.
  displayToReal = new Map(
    [...models.keys()].flatMap((id) => {
      const display = displayIdOf(id);
      return [
        [display, id],
        [stripWindowSuffix(display), id],
      ];
    })
  );
  dsModelsCache = { at: Date.now(), models: list };
  return list;
}

async function refreshDeepseekIds() {
  try {
    await deepseekModelList();
  } catch {
    /* keep fallback */
  }
}
refreshDeepseekIds();

/** Real DeepSeek id for a request model id, or null if not a DeepSeek model.
 * Accepts both the display id (`claude-deepseek-v4-flash`) and the real id. */
const deepseekRealId = (id) => {
  if (typeof id !== "string") return null;
  if (deepseekIds.has(id)) return id;
  if (displayToReal.has(id)) return displayToReal.get(id);
  // `deepseek-v4-flash[1m]` would 400 upstream — the window suffix is a Claude
  // Code convention, never part of a real model id.
  const bare = stripWindowSuffix(id);
  if (deepseekIds.has(bare)) return bare;
  return displayToReal.get(bare) ?? null;
};

/** Claude Code / Opus 5 effort levels: low, medium, high, xhigh, max. DeepSeek
 * V4 documents low/high/max only — medium and xhigh don't exist upstream, so
 * bridge them to the nearest supported level instead of letting the API
 * silently ignore the request. Overridable per level via `effort:` in
 * config.yml (merged over these defaults). */
const EFFORT_DEFAULT = {};
const EFFORT_MAP =
  CFG.effort && typeof CFG.effort === "object"
    ? { ...EFFORT_DEFAULT, ...Object.fromEntries(Object.entries(CFG.effort)) }
    : { ...EFFORT_DEFAULT };

// ---------------------------------------------------------------------------
// Usage log — one JSON line per DeepSeek request, always on (not DEBUG-gated)
// ---------------------------------------------------------------------------

const USAGE_LOG = path.join(HERE, "logs", "proxy-usage.jsonl");
let usageStream = null;
try {
  fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
  usageStream = fs.createWriteStream(USAGE_LOG, { flags: "a" });
} catch {
  usageStream = null;
}

function logUsage(entry) {
  if (!usageStream) return;
  try {
    usageStream.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* ignore */
  }
}

/** Pull usage out of streamed SSE: message_start usage + message_delta usage. */
function decodeSse(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m || m[1] === "[DONE]" || m[1].trim() === "") continue;
    try { events.push(JSON.parse(m[1])); } catch { /* skip */ }
  }
  let usage = null;
  for (const ev of events) {
    if (ev.type === "message_start" && ev.message?.usage) usage = { ...(usage ?? {}), ...ev.message.usage };
    else if (ev.type === "message_delta" && ev.usage) usage = { ...(usage ?? {}), ...ev.usage };
  }
  return usage;
}

// ---------------------------------------------------------------------------
// DeepSeek routing — transparent passthrough to the Anthropic-compatible API
// ---------------------------------------------------------------------------

function handleDeepSeek(req, res, body, reqPath, redir) {
  if (isTokenCount(reqPath)) {
    const est = estTokens(body.length);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: est }));
    return;
  }

  let forwardedBody = body;
  try {
    const reqJson = JSON.parse(body.toString("utf8"));
    let changed = false;
    const real = reqJson?.model ? deepseekRealId(reqJson.model) : null;
    if (real && reqJson.model !== real) {
      reqJson.model = real;
      changed = true;
    } else if (redir && reqJson.model !== redir.mapped) {
      reqJson.model = redir.mapped;
      changed = true;
    }
    if (reqJson?.output_config?.effort && EFFORT_MAP[reqJson.output_config.effort]) {
      reqJson.output_config.effort = EFFORT_MAP[reqJson.output_config.effort];
      changed = true;
    }
    if (Array.isArray(reqJson?.tools)) {
      const kept = reqJson.tools.filter((t) => !(t && typeof t.type === "string" && /^advisor_/.test(t.type)));
      if (kept.length !== reqJson.tools.length) {
        reqJson.tools = kept;
        changed = true;
      }
    }
    if (changed) forwardedBody = Buffer.from(JSON.stringify(reqJson));
  } catch {
    /* leave body untouched */
  }

  const headers = forwardHeaders(req.headers, forwardedBody);
  headers["x-api-key"] = DEEPSEEK_API_KEY;
  delete headers["authorization"]; // DeepSeek wants the key as x-api-key only
  // anthropic-version / anthropic-beta pass through; DeepSeek ignores them.

  let u;
  try {
    u = new URL(DEEPSEEK_ANTHROPIC_BASE + reqPath);
  } catch (err) {
    sendError(res, 500, "api_error", `deepseek route error: ${err.message}`);
    return;
  }

  const lib = u.protocol === "https:" ? https : http;
  const started = Date.now();
  let sentModel = null;
  try { sentModel = JSON.parse(forwardedBody.toString("utf8"))?.model ?? null; } catch { /* non-JSON */ }

  function issueUpstream(attempts) {
    // Fresh complete headers per attempt, built BEFORE request() — mutating a
    // shared headers object after request creation loses retry writes (Node 26).
    const attemptHeaders = { ...headers, "content-length": String(forwardedBody.length) };
    const upstream = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: req.method ?? "POST", headers: attemptHeaders, ...(attempts > 1 ? { agent: false } : {}) },
      (up) => {
        const status = up.statusCode ?? 502;
        if (FALLBACK && redir && FALLBACK_STATUS.has(status)) {
          up.resume(); // drain so the socket frees
          void forwardToAnthropic(req, res, reqPath, body, null).catch((err) => sendError(res, 502, "api_error", err.message)); // original model + body
          return;
        }
        if (status === 200) {
          res.writeHead(status, cleanResponseHeaders(up.headers));
          const respChunks = [];
          up.on("data", (c) => { respChunks.push(c); res.write(c); });
          up.on("end", () => {
            res.end();
            logUsage({ method: req.method, path: reqPath, status, ms: Date.now() - started, model: sentModel, usage: decodeSse(Buffer.concat(respChunks).toString("utf8")) });
          });
          return;
        }
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const m = status === 400 && raw.includes("unknown variant") ? raw.match(/tools\[(\d+)\]/) : null;
          if (m && attempts < 3) {
            const idx = Number(m[1]);
            try {
              const j = JSON.parse(forwardedBody.toString("utf8"));
              if (Array.isArray(j.tools) && j.tools[idx]) {
                j.tools.splice(idx, 1);
                forwardedBody = Buffer.from(JSON.stringify(j));
                issueUpstream(attempts + 1);
                return;
              }
            } catch {
              /* fall through to error forward */
            }
          }
          res.writeHead(status, cleanResponseHeaders(up.headers));
          res.end(raw);
          logUsage({ method: req.method, path: reqPath, status, ms: Date.now() - started, model: sentModel, usage: null });
        });
      }
    );
    upstream.setTimeout(60000, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (err) => {
      if (res.headersSent) { res.destroy(); return; }
      if (FALLBACK && redir) {
        void forwardToAnthropic(req, res, reqPath, body, null).catch((e) => sendError(res, 502, "api_error", e.message));
        return;
      }
      sendError(res, 502, "api_error", `deepseek upstream error: ${err.message}`);
    });
    if (forwardedBody.length > 0) upstream.write(forwardedBody);
    upstream.end();
  }
  issueUpstream(1);
}

// ---------------------------------------------------------------------------
// Merged model list
// ---------------------------------------------------------------------------

async function serveModels(req, res) {
  const modelHeaders = await applyAnthropicAuth(forwardHeaders(req.headers, Buffer.alloc(0)));
  const anthropicModels = await new Promise((resolve) => {
    const upstream = https.request(
      { hostname: UPSTREAM, port: 443, path: req.url ?? "/v1/models", method: "GET", headers: modelHeaders },
      (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* non-JSON body */
          }
          resolve({ status: up.statusCode ?? 0, json });
        });
      }
    );
    upstream.on("error", () => resolve({ status: 0, json: null }));
    upstream.end();
  });

  const ds = await deepseekModelList();

  // Never brick the harness on an Anthropic hiccup — serve DeepSeek models only.

  const data = Array.isArray(anthropicModels.json?.data) ? [...anthropicModels.json.data] : [];
  const seen = new Set(data.map((m) => m.id));
  for (const m of ds) if (!seen.has(m.id)) data.push(m);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    })
  );
}

// ---------------------------------------------------------------------------
// Anthropic forward
// ---------------------------------------------------------------------------

function rewriteModel(body, model) {
  try {
    const j = JSON.parse(body.toString("utf8"));
    j.model = model;
    return Buffer.from(JSON.stringify(j));
  } catch {
    return body;
  }
}

async function forwardToAnthropic(req, res, reqPath, body, fb) {
  const headers = await applyAnthropicAuth(forwardHeaders(req.headers, body));
  const upstream = https.request(
    { hostname: UPSTREAM, port: 443, path: reqPath, method: req.method, headers },
    (up) => {
      const status = up.statusCode ?? 502;
      if (FALLBACK && fb && FALLBACK_STATUS.has(status)) {
        up.resume(); // drain so the socket frees
        handleDeepSeek(req, res, rewriteModel(body, fb.mapped), reqPath, null);
        return;
      }
      res.writeHead(status, cleanResponseHeaders(up.headers));
      up.on("data", (c) => res.write(c));
      up.on("end", () => res.end());
    }
  );
  upstream.setTimeout(60000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    if (res.headersSent) { res.destroy(); return; }
    if (FALLBACK && fb) {
      handleDeepSeek(req, res, rewriteModel(body, fb.mapped), reqPath, null);
      return;
    }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `agent-proxy upstream error: ${err.message}` }));
  });
  if (body.length > 0) upstream.write(body);
  upstream.end();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function handle(req, res) {
  const reqPath = req.url ?? "/";
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const started = Date.now();
    res.on("finish", () => {
      if (DEBUG) {
        debugLog({ method: req.method, path: reqPath, status: res.statusCode, ms: Date.now() - started, ...summarizeBody(body, req.headers) });
      }
    });
    try {
      if (req.method === "GET" && reqPath.startsWith("/v1/models")) {
        await serveModels(req, res);
        return;
      }
      let model = null;
      if (body.length > 0) {
        try { model = JSON.parse(body.toString("utf8"))?.model ?? null; } catch { /* not JSON */ }
      }
      if (model && deepseekRealId(model)) {
        handleDeepSeek(req, res, body, reqPath, null);
        return;
      }
      const fam = model ? familyOf(model) : null;
      if (fam && redirOn) {
        handleDeepSeek(req, res, body, reqPath, { mapped: REDIR_MAP[fam] });
        return;
      }
      void forwardToAnthropic(req, res, reqPath, body, fam && FALLBACK ? { mapped: REDIR_MAP[fam] } : null).catch((err) => sendError(res, 502, "api_error", err.message));
    } catch (err) {
      sendError(res, 500, "api_error", `proxy handler error: ${err.message}`);
    }
  });
}

const server = http.createServer(handle);

// Without this, EADDRINUSE (a proxy already on the port) surfaces as an unhandled
// 'error' event and a stack trace in the log. Exit non-zero with one readable
// line instead; restarting is the launcher's job, not ours.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") console.error(`[proxy] port ${PORT} is already in use — is another proxy running?`);
  else console.error(`[proxy] server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.error(`[proxy] listening on http://${HOST}:${PORT}`);
});
