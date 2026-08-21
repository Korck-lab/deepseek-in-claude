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

// Statuses worth retrying the other way. 408 belongs here even though the proxy
// sets its own upstream timeout: an intermediate (corporate proxy, tunnel) can
// answer 408 before that timer fires, and without it that request would surface
// as a hard failure rather than falling back.
const FALLBACK_STATUS = new Set([404, 408, 429, 500, 501, 502, 503, 504]);

function parseArgs(argv) {
  const out = { port: null, redir: false, fallback: null, config: null, debug: false, help: false, noAuthBridge: false, oauthRefresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = argv[++i] ?? null; // validated by firstInt()
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
    // Quoted keys are valid YAML and an editor or formatter may well produce
    // them; unquoted-only would drop `"port": 8016` on the floor and fall back
    // to the default with no diagnostic.
    const m = trimmed.match(/^"([^"]+)":\s*(.*)$/) ?? trimmed.match(/^'([^']+)':\s*(.*)$/) ?? trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      // Sequences and document markers are valid YAML this subset deliberately
      // doesn't support; warning about them would put a line on stderr at every
      // start for a config that is perfectly fine. Anything else reaching here
      // is a line the user meant as a setting and won't get — a missing colon,
      // a block scalar — so it is worth naming.
      if (!trimmed.startsWith("- ") && trimmed !== "-" && trimmed !== "---" && trimmed !== "...") {
        console.error(`[config] ignoring unparsable line in ${CONFIG_PATH}: ${trimmed.slice(0, 60)}`);
      }
      continue;
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const key = m[1];
    const val = m[2].split(/\s+#/)[0].trim();
    if (val === "") {
      const next = {};
      stack[stack.length - 1].obj[key] = next;
      stack.push({ indent, obj: next });
    } else {
      // Zero-padded values stay strings: `Number("007")` is 7, which would
      // silently rewrite an id or token that happens to look numeric.
      const numeric = /^\d+$/.test(val) && !/^0\d/.test(val);
      stack[stack.length - 1].obj[key] =
        val === "true" ? true : val === "false" ? false : numeric ? Number(val) : val.replace(/^["']|["']$/g, "");
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
                    same redir relation, both directions. Off unless asked for:
                    it spends the other provider's quota without saying so
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

/** First source that yields a positive integer. Plain `??` chaining is wrong
 * for these: `--port foo` produces NaN and `PORT=` in .env produces "", both of
 * which are non-nullish and would win over every later source. */
function firstInt(candidates, fallback, label, max = Number.MAX_SAFE_INTEGER) {
  for (const c of candidates) {
    if (c == null || c === "") continue;
    const n = Number(c);
    // 0 is a legal listen() argument but means "any free port", which nothing
    // pointed at a fixed base URL could reach — reject it like any other junk.
    if (Number.isInteger(n) && n > 0 && n <= max) return n;
    console.error(`[config] ignoring invalid ${label} value ${JSON.stringify(c)}`);
  }
  return fallback;
}

// Documented precedence: CLI args > config.yml > real env > .env > default.
const PORT = firstInt([ARGS.port, CFG.port, process.env.PORT, ENV.PORT], 8016, "port", 65535);
// Loopback only. The proxy holds the DeepSeek key and bridges the user's
// Anthropic OAuth token, so a 0.0.0.0 bind would hand both to any LAN host.
const HOST = CFG.host ?? "127.0.0.1";
const UPSTREAM = "api.anthropic.com";
// Idle-socket timeout for every upstream leg. Streaming responses reset it on
// each chunk, so it bounds silence, not total duration. Configurable mainly so
// the fallback-race test can reach the path where an abandoned leg's timer
// fires while the other leg is still streaming.
const UPSTREAM_TIMEOUT = firstInt([CFG.upstreamTimeoutMs, process.env.UPSTREAM_TIMEOUT_MS, ENV.UPSTREAM_TIMEOUT_MS], 60000, "upstream timeout");

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

// Concurrent writes are not serialised. A line over the pipe buffer could in
// principle interleave with another, but --debug is a hand-run diagnostic and a
// write queue is more machinery than a rare cosmetic tear in a debug log
// warrants. Deliberately left as is.
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

/** Accept the shorthand a redir map may be written with (`v4-flash`) and return
 * the real DeepSeek id. Anything that is neither already a DeepSeek id nor a
 * recognised shorthand is returned untouched: blindly prefixing turned a typo
 * like `gpt-4` into the plausible-looking `deepseek-gpt-4`, which then 400s
 * upstream with nothing pointing back at the config line that caused it. */
const normalizeModel = (id) => {
  const s = String(id);
  if (s.includes("deepseek-")) return s;
  if (/^v\d+-?(flash|pro)$/.test(s)) return `deepseek-${s.replace(/^(v\d+)-?/, "$1-")}`;
  console.error(`[config] redir target "${s}" is not a DeepSeek model id — using it as written`);
  return s;
};

const DEFAULT_REDIR = {
  haiku: "deepseek-v4-flash",
  sonnet: "deepseek-v4-flash",
  opus: "deepseek-v4-flash",
  fable: "deepseek-v4-pro",
};

const redirOn = ARGS.redir === true || Boolean(CFG.redir && typeof CFG.redir === "object");

/** Opt-in, never inferred. Fallback crosses legs — an Anthropic 429, which is a
 * routine event on a plan session, would otherwise reroute the turn to DeepSeek
 * and spend metered credits the user never chose to spend. The swap is also
 * invisible: `restoreClientModel` rewrites the response's `model` back to the id
 * the client asked for, so the transcript reports the Anthropic model that never
 * ran. Two silent effects at once is too much to arm by default, and the proxy is
 * pooled across sessions, so whoever starts it arms it for every project at once.
 * See ADR-0005. */
const FALLBACK = ARGS.fallback != null ? ARGS.fallback : CFG.fallback ?? false;

/** Relation map: family key -> DeepSeek model. Redirects when redirOn, and is
 * the fallback relation (both ways) when FALLBACK is set. */
const REDIR_MAP =
  CFG.redir && typeof CFG.redir === "object"
    ? Object.fromEntries(Object.entries(CFG.redir).map(([k, v]) => [k, normalizeModel(v)]))
    : redirOn || FALLBACK
      ? { ...DEFAULT_REDIR }
      : null;

const FAMILY_KEYS = REDIR_MAP ? Object.keys(REDIR_MAP) : [];

/** First redir key appearing as a segment of the model id — "claude-sonnet-4-5"
 * -> "sonnet". Matched on non-alphanumeric boundaries rather than a bare
 * substring test: `includes("opus")` would also claim a hypothetical
 * "opusculum-1", quietly rerouting a model the user never mapped. */
function familyOf(modelId) {
  if (!REDIR_MAP) return null;
  const id = String(modelId ?? "").toLowerCase();
  for (const key of FAMILY_KEYS) {
    if (new RegExp(`(^|[^a-z0-9])${key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(id)) return key;
  }
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
  // A late error can arrive after another leg already finished this response —
  // writing then throws ERR_STREAM_WRITE_AFTER_END and takes down the handler.
  if (res.writableEnded || res.destroyed) return;
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
//
// Substituting the bearer is not sufficient on its own. On a shell that exports
// ANTHROPIC_API_KEY the CLI sends `x-api-key` *alongside* the bearer, and
// api.anthropic.com prefers the key over the Authorization header — measured
// 2026-08-12, the identical request answers 401 with a bogus `x-api-key`
// attached and 200 with it removed. A valid exported key in that slot would
// therefore authenticate and bill every Anthropic request to API credits while
// the bridge looked like it was working, which is precisely the outcome ADR-0002
// forbids. Dropping the caller's `x-api-key` on the Anthropic leg is load-bearing
// rather than hygiene.
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

// ---------------------------------------------------------------------------
// Vision redirect config
//
// DeepSeek V4 models have no vision; a request carrying an image block 400s
// upstream. When the resolved target model lacks vision capability, such a
// request is rerouted to a model that can see it. Two tiers, tried in order:
//
//   1. A local vision model — LM Studio by default, which speaks OpenAI
//      protocol, so that leg translates Anthropic <-> OpenAI rather than reusing
//      the Anthropic upstream. Off unless asked for: it sends the turn — image
//      included — to an endpoint the user has to be running, and nobody has one
//      by default. Firing on capability alone would ship prompt content to a
//      host nobody named. Opt in with `vision.redirect: true`.
//   2. The Anthropic leg the proxy is already talking to, on the plan credential
//      the credential bridge already holds. On by default: unlike the local leg
//      it names no new host, needs nothing running, and spends the plan the user
//      is already on — and the alternative is a confidently wrong answer on
//      every image turn. It does cost plan traffic per image, so
//      `vision.anthropic: false` turns it off and restores the blind answer,
//      with a warning.
//
// With both off, the image turn goes to DeepSeek, which answers 200 without
// having seen the image, and the disabled path says which setting would have
// handled it. Measured 2026-08-21: DeepSeek used to reject `{"type":"image"}`
// with a 400; it now accepts the block and hallucinates instead — asked the
// colour of a solid red pixel it answered "blue". A wrong answer nobody can
// tell is wrong is a worse failure than the error this originally caught.
// ---------------------------------------------------------------------------

const VISION_REDIRECT = CFG.vision?.redirect === true;
const VISION_MODEL = CFG.vision?.model ?? "prism-ml/bonsai-27b";
const VISION_BASE_URL = CFG.vision?.baseUrl ?? "http://127.0.0.1:1234";

// Boolean-or-object, the shape `redir` already uses: `anthropic: false` disables
// the tier, an object configures it, absent takes the defaults.
const VISION_ANTHROPIC_CFG = CFG.vision?.anthropic;
const VISION_ANTHROPIC = VISION_ANTHROPIC_CFG !== false;
const VISION_ANTHROPIC_OPTS =
  VISION_ANTHROPIC_CFG && typeof VISION_ANTHROPIC_CFG === "object" ? VISION_ANTHROPIC_CFG : {};
// Sonnet 5 at medium effort: vision-capable, cheapest of the current tier that
// is, and medium is enough to read a screenshot without paying max-effort
// thinking for it. Both are `vision.anthropic.{model,effort}` overridable — a
// user who wants opus on an image turn says so.
const VISION_ANTHROPIC_MODEL = VISION_ANTHROPIC_OPTS.model ?? "claude-sonnet-5";
const VISION_ANTHROPIC_EFFORT = VISION_ANTHROPIC_OPTS.effort ?? "medium";

// The Anthropic tier answers 401 without the bridge: in sentinel mode the leg
// carries the proxy's own sentinel, not a credential api.anthropic.com accepts.
// Silent otherwise until the first image turn fails, far from the setting that
// caused it.
if (VISION_ANTHROPIC && !AUTH_BRIDGE) {
  warnOnce(
    `vision falls back to ${VISION_ANTHROPIC_MODEL} on the Anthropic leg, but the credential bridge is off — image turns will answer 401. Set \`vision.anthropic: false\` to leave them on DeepSeek instead.`,
    "vision"
  );
}

function warnOnce(message, scope = "auth-bridge") {
  if (credWarned.has(message)) return;
  credWarned.add(message);
  console.error(`[${scope}] ${message}`);
}

/** Run a command. Returns stdout, or null on any non-zero exit — every caller
 * treats failure as "credential store unavailable" and falls back, so the exit
 * code itself carries no extra information.
 *
 * The timeout is the point: `security` can block indefinitely on a keychain
 * that is locked or prompting, and without a bound that hangs the auth bridge
 * for the life of the process rather than for one request. Killed runs are
 * called out by name, since "no credentials found" would be a misleading
 * account of a keychain that is simply waiting on the user. */
const CRED_CMD_TIMEOUT = 10000;

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: CRED_CMD_TIMEOUT, killSignal: "SIGKILL" }, (err, stdout) => {
      if (err?.killed) warnOnce(`\`${cmd}\` did not answer within ${CRED_CMD_TIMEOUT / 1000}s — is the keychain locked or prompting?`);
      resolve(err ? null : stdout);
    });
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
 * other Authorization value, so a real token is never touched — but a
 * client-supplied x-api-key is dropped whenever the bridge is on, whatever the
 * bearer turns out to be. */
async function applyAnthropicAuth(headers) {
  if (!AUTH_BRIDGE) return headers;
  // Below the --no-auth-bridge escape hatch, so someone bringing their own real
  // Anthropic credential still gets a genuine passthrough, and above the sentinel
  // gate, because the paths that return early from it — a real bearer, or a
  // credential lookup that yields nothing — are exactly the ones where a
  // surviving x-api-key would quietly win the request and bill it to API credits.
  delete headers["x-api-key"];
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

// ---------------------------------------------------------------------------
// Vision capability map
//
// Which models can see images. Sources, in precedence order: an explicit
// `capabilities:` config override, a value read from a provider's model list
// (`capabilities.image_input.supported` — Anthropic reports it, DeepSeek does
// not yet), then a per-family default: claude models are vision-capable today,
// everything else is assumed not to be. A future provider that reports the
// field is picked up by the same readers with no rule to add; one that does not
// falls back to its family default, overridable in config. The seam is "read if
// reported, defaulted otherwise" rather than a hardcoded DeepSeek-to-Anthropic
// rule.
//
// Declared above refreshDeepseekIds() on purpose: that call fires at module
// init and its model-list reader writes here, so the binding has to exist by
// then rather than depend on an await to escape the temporal dead zone.
// ---------------------------------------------------------------------------

const visionByModel = new Map();

/** Ids that name vision in themselves. DeepSeek ships `deepseek-v4-flash-vision-exp`
 * and reports no capabilities for it, so the family default below would call it
 * blind and redirect its image turns away — overriding a vision model the user
 * picked on purpose, and spending plan traffic to do it. A provider that bothers
 * to put `vision`/`-vl` in an id is telling us the one thing its model list does
 * not. Still below the config override and below anything actually reported, so a
 * wrong guess here is one line in `capabilities:` to correct. */
const VISION_IN_ID = /(^|[-_])(vision|vl)([-_]|$)/i;

/** Fallback when nobody reported a capability for this id. */
function visionDefaultFor(id) {
  const s = String(id ?? "");
  return /^(claude-|us\.anthropic\.)/.test(s) || VISION_IN_ID.test(s);
}

/** Read `capabilities.image_input.supported` off a provider's model-list entry.
 * Silent when the field is absent — that is the common case, not an error. */
function readVisionCapability(entry) {
  const supported = entry?.capabilities?.image_input?.supported;
  if (typeof supported === "boolean" && typeof entry?.id === "string") visionByModel.set(entry.id, supported);
}

function capabilityOf(id) {
  const override = CFG.capabilities?.[id];
  if (override && typeof override === "object" && typeof override.vision === "boolean") return override.vision;
  const reported = visionByModel.get(id);
  if (reported !== undefined) return reported;
  return visionDefaultFor(id);
}

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

function displayIdOf(id) {
  return `${DISPLAY_PREFIX}${String(id).replace(/^deepseek-/, "")}${DISPLAY_SUFFIX}`;
}

/** Both the suffixed display id and its bare form map to the real id — Claude
 * Code keeps both in play when it resolves a model name. */
function buildDisplayMap(ids) {
  return new Map(
    [...ids].flatMap((id) => {
      const display = displayIdOf(id);
      return [
        [display, id],
        [stripWindowSuffix(display), id],
      ];
    })
  );
}

// Seeded from the fallback list rather than left empty until the first fetch
// lands. Empty, a request arriving during startup could not resolve
// `claude-deepseek-v4-flash[1m]` — the id the picker actually sends — so it fell
// through to Anthropic and came back 401/404 instead of routing to DeepSeek.
let displayToReal = buildDisplayMap(DEFAULT_MODELS);

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
        for (const m of json.data) {
          if (!m?.id) continue;
          models.set(m.id, toModelEntry(m.id, m.created ?? 0));
          // DeepSeek does not report capabilities today, so this reads nothing
          // and the family default (no vision) stands. It exists so that a model
          // list which *does* start reporting image_input needs no code change —
          // the vision redirect stops firing for that model on its own.
          readVisionCapability(m);
        }
      }
    } catch {
      /* models fetch failed — fallback list stands */
    }
  }
  const list = [...models.values()];
  deepseekIds = new Set(models.keys());
  displayToReal = buildDisplayMap(models.keys());
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
 * V4 accepts all five natively, so nothing is bridged by default and this map
 * is empty — an earlier version of this comment claimed medium and xhigh were
 * rewritten, which stopped being true and disagreed with config.example.yml.
 * Set `effort:` in config.yml to remap specific levels for other families. */
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

/** `opts.fallbackFrom` names the leg that gave up on this turn, when the turn
 * only reached DeepSeek because the Anthropic leg failed. It exists for the usage
 * log: a fallback spends DeepSeek credits on a request the user aimed at
 * Anthropic, and without the tag those rows are indistinguishable from deliberate
 * DeepSeek use — which is exactly the question asked after the fact. Same reason
 * the vision redirect threads `opts.redirected`. */
function handleDeepSeek(req, res, body, reqPath, redir, opts = {}) {
  if (isTokenCount(reqPath)) {
    const est = estTokens(body.length);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: est }));
    return;
  }

  let forwardedBody = body;
  // The id the client asked for, kept so the response can be answered in the
  // same vocabulary it was asked in. See restoreClientModel below.
  let clientModel = null;
  try {
    const reqJson = JSON.parse(body.toString("utf8"));
    let changed = false;
    const real = reqJson?.model ? deepseekRealId(reqJson.model) : null;
    // The *canonical* display id, not the string the client happened to send.
    // Claude Code strips `[1m]` before dispatching, so echoing back what it sent
    // would put a suffix-less id in the transcript — and a resumed session reads
    // its window from that id, landing on the assumed 200k instead of DeepSeek's
    // real 1M. Answering with the id the picker itself lists is both truthful
    // and what keeps the window right across a reconnect.
    clientModel = real ? displayIdOf(real) : (typeof reqJson?.model === "string" ? reqJson.model : null);
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

  // One client response, one writer. Once the fallback path hands `res` to
  // forwardToAnthropic this leg must never touch it again: a late socket error
  // on the abandoned DeepSeek request would otherwise either destroy a response
  // the Anthropic leg is midway through streaming, or — if it errored before
  // that leg wrote its head, so `headersSent` is still false — start a *second*
  // fallback on the same response.
  let handedOff = false;

  // The body is a parameter, not a closure variable a retry reassigns: with
  // several attempts in flight the headers, the write and the splice all have to
  // agree on which body this attempt is sending, and reading a shared mutable
  // binding at three different moments is a bug waiting for a scheduling change.
  function issueUpstream(attempts, attemptBody) {
    // Set when a retry replaces this attempt, so the abandoned request's error
    // handler stays out of the way for the same reason.
    let superseded = false;
    function clearUpstreamTimeout() {
      upstream.setTimeout(0);
    }
    // Fresh complete headers per attempt, built BEFORE request() — mutating a
    // shared headers object after request creation loses retry writes (Node 26).
    const attemptHeaders = { ...headers, "content-length": String(attemptBody.length) };
    const upstream = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: req.method ?? "POST", headers: attemptHeaders, ...(attempts > 1 ? { agent: false } : {}) },
      (up) => {
        const status = up.statusCode ?? 502;
        if (FALLBACK && redir && FALLBACK_STATUS.has(status)) {
          up.resume(); // drain so the socket frees
          handedOff = true;
          clearUpstreamTimeout();
          void forwardToAnthropic(req, res, reqPath, body, null, { fallbackFrom: "deepseek" }).catch((err) => sendError(res, 502, "api_error", err.message)); // original model + body
          return;
        }
        if (status === 200) {
          const outHeaders = cleanResponseHeaders(up.headers);
          // Same reason as the Anthropic leg: rewriting the model id changes the
          // byte length, and a declared content-length would truncate a
          // non-streaming answer.
          if (sentModel !== clientModel) delete outHeaders["content-length"];
          res.writeHead(status, outHeaders);
          const respChunks = [];
          // `model` lives in the first SSE event (message_start), so hold bytes
          // only until that event is complete, rewrite it, and stream the rest
          // straight through. Holding the whole response would break streaming;
          // rewriting each chunk blind would miss a field split across a chunk
          // boundary.
          let head = sentModel === clientModel ? null : Buffer.alloc(0);
          up.on("data", (c) => {
            respChunks.push(c);
            if (head === null) { res.write(c); return; }
            head = Buffer.concat([head, c]);
            const text = head.toString("utf8");
            const end = text.indexOf("\n\n");
            // Cap the hold: a stream that never presents a complete event must
            // not be buffered indefinitely waiting for one.
            if (end === -1 && head.length < 65536) return;
            res.write(Buffer.from(restoreClientModel(text, clientModel, sentModel), "utf8"));
            head = null;
          });
          up.on("end", () => {
            // A response that ended before its first event boundary — short,
            // non-SSE, or truncated — still has to reach the client.
            if (head !== null && head.length > 0) {
              res.write(Buffer.from(restoreClientModel(head.toString("utf8"), clientModel, sentModel), "utf8"));
            }
            head = null;
            clearUpstreamTimeout();
            res.end();
            logUsage({ method: req.method, path: reqPath, status, ms: Date.now() - started, model: sentModel, usage: decodeSse(Buffer.concat(respChunks).toString("utf8")), fallbackFrom: opts.fallbackFrom });
          });
          return;
        }
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          // DeepSeek rejects tool types it doesn't know with a 400 naming the
          // offending index; dropping that tool and retrying is what keeps a
          // Claude Code session with newer tools usable. The index is read out
          // of a prose error message, so the shape is DeepSeek's to change —
          // when the marker is there but the index isn't, say so rather than
          // forwarding an opaque 400 the user can do nothing with.
          const unknownVariant = status === 400 && raw.includes("unknown variant");
          const m = unknownVariant ? raw.match(/tools\[(\d+)\]/) : null;
          if (unknownVariant && !m) {
            warnOnce(`DeepSeek rejected an unknown tool variant but the error named no tools[N] index — cannot retry: ${raw.slice(0, 200)}`, "deepseek");
          }
          if (m && attempts < 3) {
            const idx = Number(m[1]);
            try {
              const j = JSON.parse(attemptBody.toString("utf8"));
              if (Array.isArray(j.tools) && j.tools[idx]) {
                j.tools.splice(idx, 1);
                superseded = true;
                clearUpstreamTimeout();
                issueUpstream(attempts + 1, Buffer.from(JSON.stringify(j)));
                return;
              }
            } catch {
              /* fall through to error forward */
            }
          }
          clearUpstreamTimeout();
          res.writeHead(status, cleanResponseHeaders(up.headers));
          res.end(raw);
          logUsage({ method: req.method, path: reqPath, status, ms: Date.now() - started, model: sentModel, usage: null, fallbackFrom: opts.fallbackFrom });
        });
      }
    );
    // Idle-socket timeout, disarmed once the exchange is over. Left armed, it
    // rides the socket back into the keep-alive pool and fires its destroy
    // callback on a connection no longer tied to this request.
    upstream.setTimeout(UPSTREAM_TIMEOUT, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (err) => {
      if (superseded || handedOff) return;
      if (res.headersSent) { res.destroy(); return; }
      if (FALLBACK && redir) {
        handedOff = true;
        void forwardToAnthropic(req, res, reqPath, body, null, { fallbackFrom: "deepseek" }).catch((e) => sendError(res, 502, "api_error", e.message));
        return;
      }
      // Mirror of the same case on the Anthropic leg: a crossing that then failed
      // still belongs in the ledger.
      if (opts.fallbackFrom) {
        logUsage({ method: req.method, path: reqPath, status: 502, ms: Date.now() - started, model: sentModel, usage: null, fallbackFrom: opts.fallbackFrom, error: err.message });
      }
      sendError(res, 502, "api_error", `deepseek upstream error: ${err.message}`);
    });
    if (attemptBody.length > 0) upstream.write(attemptBody);
    upstream.end();
  }
  issueUpstream(1, forwardedBody);
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
    // The model list had no timeout at all: a connection that opened and then
    // went silent would hang /v1/models forever, and with it the picker.
    upstream.setTimeout(UPSTREAM_TIMEOUT, () => upstream.destroy(new Error("models timeout")));
    upstream.on("error", () => resolve({ status: 0, json: null }));
    upstream.end();
  });

  const ds = await deepseekModelList();

  // Never brick the harness on an Anthropic hiccup — serve DeepSeek models only.
  // But say so: an empty or partial picker is the most visible symptom this
  // proxy has, and silently returning half a list sends people hunting through
  // Claude Code's model cache for a fault that is upstream of it.
  if (!Array.isArray(anthropicModels.json?.data)) {
    warnOnce(
      anthropicModels.status === 0
        ? "could not reach api.anthropic.com for the model list — serving DeepSeek models only"
        : `api.anthropic.com returned ${anthropicModels.status} for the model list — serving DeepSeek models only`,
      "models"
    );
  }

  // Vision capability overlay: Anthropic reports image_input support per model,
  // so record it here on the list fetch the picker already makes. `capabilities:`
  // in config.yml still wins over anything read. See ADR-0004.
  if (Array.isArray(anthropicModels.json?.data)) {
    for (const m of anthropicModels.json.data) readVisionCapability(m);
  }

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

/** Answer in the vocabulary the client asked in: put the display id back into the
 * response's `model` field, replacing the real DeepSeek id the upstream echoes.
 *
 * Not cosmetic. Claude Code restores a resumed session's model by reading the
 * `model` of the last *assistant message in the transcript* — what the response
 * reported — not what the picker had selected. An unrewritten `deepseek-v4-flash`
 * is an id it cannot resolve, so it declines the restore and falls back to an id
 * without the `[1m]` marker, silently dropping the session from a 1M window to
 * the assumed 200k. The symptom is "Session model deepseek-v4-flash could not be
 * restored", one reconnect later and far from this line.
 *
 * Only the first `message_start` event carries the field, so the stream is
 * buffered no further than the end of that event, then written through untouched.
 */
function restoreClientModel(text, clientModel, realModel) {
  if (!clientModel || !realModel || clientModel === realModel) return text;
  // Anchored on the JSON field so a model name appearing in prose — a user asking
  // about "deepseek-v4-flash", say — is never rewritten.
  return text.replace(
    new RegExp(`("model"\\s*:\\s*)"${realModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"),
    `$1${JSON.stringify(clientModel)}`
  );
}

/** The same contract as `restoreClientModel`, for a leg where the id upstream
 * echoes is not the id we sent. Anthropic resolves an alias to a dated snapshot
 * — a request for `claude-haiku-4-5` answers `claude-haiku-4-5-20251001` — so an
 * equality-anchored rewrite finds nothing, silently no-ops, and the client
 * restores its session to a model the user never picked. That is the exact
 * failure ADR-0001 exists to prevent, and it fails quietly: the turn answers
 * fine and the damage shows up one reconnect later.
 *
 * So this rewrites the first `"model"` field it finds rather than a named one.
 * Safe because the caller only ever hands it the buffered head — the
 * `message_start` event, or a short non-SSE body — whose first model field is
 * the message's own. Prose in later events is never in scope; it has already
 * been streamed through untouched. */
function restoreRedirectedModel(text, clientModel) {
  if (!clientModel) return text;
  return text.replace(/("model"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(clientModel)}`);
}

/** The `model` a forwarded body actually carries, for the usage log. */
function sentModelOf(body) {
  try {
    return JSON.parse(body.toString("utf8"))?.model ?? null;
  } catch {
    return null;
  }
}

function rewriteModel(body, model) {
  try {
    const j = JSON.parse(body.toString("utf8"));
    j.model = model;
    return Buffer.from(JSON.stringify(j));
  } catch {
    return body;
  }
}

async function forwardToAnthropic(req, res, reqPath, body, fb, opts = {}) {
  const headers = await applyAnthropicAuth(forwardHeaders(req.headers, body));
  // Mirror image of the guard in handleDeepSeek: once this leg falls back, the
  // DeepSeek leg owns the response and a late error here must not touch it.
  let handedOff = false;
  const started = Date.now();
  const clearUpstreamTimeout = () => upstream.setTimeout(0);
  const upstream = https.request(
    { hostname: UPSTREAM, port: 443, path: reqPath, method: req.method, headers },
    (up) => {
      const status = up.statusCode ?? 502;
      if (FALLBACK && fb && FALLBACK_STATUS.has(status)) {
        up.resume(); // drain so the socket frees
        handedOff = true;
        clearUpstreamTimeout();
        handleDeepSeek(req, res, rewriteModel(body, fb.mapped), reqPath, null, { fallbackFrom: "anthropic" });
        return;
      }
      const rewriting = status === 200 && Boolean(opts.restoreModel);
      const outHeaders = cleanResponseHeaders(up.headers);
      // The rewrite changes the body's byte length. A declared content-length
      // from upstream would then truncate a non-streaming answer mid-JSON, so
      // drop it and let Node frame the response itself.
      if (rewriting) delete outHeaders["content-length"];
      res.writeHead(status, outHeaders);
      if (rewriting) {
        // Answer in the client's vocabulary: `message_start` reports the model
        // actually sent upstream, and a resumed session restores its model from
        // that field — so a redirected turn must echo the client's display id,
        // not the vision model. Hold bytes only until the first SSE event is
        // complete, rewrite the `model` field, stream the rest. Mirror of the
        // head-buffering in handleDeepSeek; only the redirect leg needs it, a
        // plain Anthropic passthrough streams straight through.
        const respChunks = [];
        let head = Buffer.alloc(0);
        up.on("data", (c) => {
          respChunks.push(c);
          if (head === null) { res.write(c); return; }
          head = Buffer.concat([head, c]);
          const text = head.toString("utf8");
          const end = text.indexOf("\n\n");
          if (end === -1 && head.length < 65536) return;
          res.write(Buffer.from(restoreRedirectedModel(text, opts.restoreModel), "utf8"));
          head = null;
        });
        up.on("end", () => {
          // A response that ended before its first event boundary — short,
          // non-SSE, or truncated — still has to reach the client.
          if (head !== null && head.length > 0) {
            res.write(Buffer.from(restoreRedirectedModel(head.toString("utf8"), opts.restoreModel), "utf8"));
          }
          head = null;
          clearUpstreamTimeout();
          res.end();
          // Redirected turns bill Anthropic plan traffic; make them visible in
          // the usage log or they read as missing.
          if (opts.redirected) {
            logUsage({ method: req.method, path: reqPath, status, ms: Date.now() - started, model: opts.realModel, usage: decodeSse(Buffer.concat(respChunks).toString("utf8")), redirected: opts.redirected });
          }
        });
        return;
      }
      // A plain Anthropic turn is the user's own plan traffic and stays out of
      // the usage log — that log is the DeepSeek spend ledger. A turn that got
      // here because the DeepSeek leg gave up is the exception: it is the
      // counterpart of the rows tagged `fallbackFrom: "anthropic"`, and reading
      // the ledger without it shows crossings in one direction only.
      const fallbackChunks = opts.fallbackFrom ? [] : null;
      up.on("data", (c) => {
        fallbackChunks?.push(c);
        res.write(c);
      });
      up.on("end", () => {
        clearUpstreamTimeout();
        res.end();
        if (fallbackChunks) {
          logUsage({
            method: req.method, path: reqPath, status,
            ms: Date.now() - started,
            model: sentModelOf(body),
            usage: status === 200 ? decodeSse(Buffer.concat(fallbackChunks).toString("utf8")) : null,
            fallbackFrom: opts.fallbackFrom,
          });
        }
      });
    }
  );
  upstream.setTimeout(UPSTREAM_TIMEOUT, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    if (handedOff) return;
    if (res.headersSent) { res.destroy(); return; }
    if (FALLBACK && fb) {
      handedOff = true;
      handleDeepSeek(req, res, rewriteModel(body, fb.mapped), reqPath, null, { fallbackFrom: "anthropic" });
      return;
    }
    // A crossing that then failed is still a crossing, and the ledger is where
    // the user goes to find out what happened to a turn. Without this row the
    // record shows only the crossings that worked.
    if (opts.fallbackFrom || opts.redirected) {
      logUsage({ method: req.method, path: reqPath, status: 502, ms: Date.now() - started, model: sentModelOf(body), usage: null, ...(opts.fallbackFrom ? { fallbackFrom: opts.fallbackFrom } : {}), ...(opts.redirected ? { redirected: opts.redirected } : {}), error: err.message });
    }
    sendError(res, 502, "api_error", `agent-proxy upstream error: ${err.message}`);
  });
  if (body.length > 0) upstream.write(body);
  upstream.end();
}

// ---------------------------------------------------------------------------
// Image routing helpers
// ---------------------------------------------------------------------------

/** Image-bearing request? Recursive walk anchored on the `type` field — matches
 * any object whose type is "image", wherever it sits (messages[].content,
 * context[], tool_result.content), while prose mentioning the word never
 * matches. Non-JSON bodies cannot carry an image block. */
function hasImageBlock(bodyBuf) {
  let root;
  try {
    root = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    return false;
  }
  const walk = (node) => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(walk);
    if (node.type === "image") return true;
    for (const key of Object.keys(node)) if (walk(node[key])) return true;
    return false;
  };
  return walk(root);
}

/** Rewrite an image-bearing request for the Anthropic vision tier: swap the
 * model, set the configured effort, keep every other field as the client sent
 * it. Both legs already speak Anthropic, so this is a two-field edit rather than
 * the protocol translation the local leg needs.
 *
 * `effort` rides in `output_config`, merged rather than replaced — a client that
 * set other output_config keys keeps them. Sonnet 5 accepts the same five levels
 * Claude Code uses, so no level needs bridging. The response still has to echo
 * the client's own id, which is `restoreClientModel`'s job at the other end. */
function rewriteVision(bodyBuf, model, effort) {
  const j = JSON.parse(bodyBuf.toString("utf8"));
  j.model = model;
  if (effort) j.output_config = { ...(j.output_config ?? {}), effort };
  return Buffer.from(JSON.stringify(j));
}

/** Translate an Anthropic-format request body into OpenAI chat.completions
 * format for the local vision leg (LM Studio). The two schemas differ in the
 * message shape, the image encoding, the tool schema and the effort field:
 *
 * - `system` (string or array of text blocks) becomes a leading system message.
 * - `messages[].content` blocks map per type: text stays text; an image block
 *   becomes OpenAI's `image_url` (base64 data URI, or passthrough URL); a
 *   `tool_result` becomes an OpenAI tool-role message keyed by `tool_use_id`;
 *   a `tool_use` becomes an OpenAI assistant `tool_calls` entry.
 * - `tools` become OpenAI function tools; advisor_* variants are dropped, the
 *   same rule the DeepSeek leg applies, because a local model cannot know them.
 * - `output_config.effort` is dropped — OpenAI has no effort concept, and the
 *   local model's own temperature comes from its LM Studio model.yaml.
 * - `stream`, `max_tokens`, `temperature`, `top_p`, `stop_sequences` survive.
 *
 * Only image-bearing requests reach this path (the redirect gate runs first),
 * so the image_url mapping is the load-bearing piece; everything else is
 * fidelity for the surrounding conversation. */
function anthropicToOpenAI(bodyBuf, model) {
  const j = JSON.parse(bodyBuf.toString("utf8"));
  const messages = [];
  if (j.system) {
    const sysText = Array.isArray(j.system)
      ? j.system.map((b) => (b?.type === "text" ? b.text : "")).join("")
      : String(j.system);
    if (sysText) messages.push({ role: "system", content: sysText });
  }
  for (const m of j.messages ?? []) {
    const role = m.role ?? "user";
    const content = m.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts = [];
    let toolCalls = null;
    const tools = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "text":
          parts.push({ type: "text", text: b.text ?? "" });
          break;
        case "image": {
          const src = b.source ?? {};
          if (src.type === "base64") {
            parts.push({ type: "image_url", image_url: { url: `data:${src.media_type ?? "image/png"};base64,${src.data ?? ""}` } });
          } else if (src.type === "url" && src.url) {
            parts.push({ type: "image_url", image_url: { url: src.url } });
          }
          break;
        }
        case "tool_use":
          (toolCalls ??= []).push({
            id: b.id,
            type: "function",
            function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
          });
          break;
        case "tool_result": {
          const r = b.content;
          const text = typeof r === "string" ? r : Array.isArray(r) ? r.map((x) => (x?.type === "text" ? x.text : "")).join("") : "";
          tools.push({ role: "tool", tool_call_id: b.tool_use_id ?? "", content: text });
          break;
        }
        default:
          break;
      }
    }
    if (role === "assistant") {
      messages.push({ role, ...(parts.length ? { content: parts } : {}), ...(toolCalls ? { tool_calls: toolCalls } : {}) });
    } else if (role === "user") {
      if (parts.length) messages.push({ role, content: parts });
      messages.push(...tools);
    } else {
      messages.push({ role, content: parts.length ? parts : "" });
    }
  }
  const out = { model, messages, stream: j.stream ?? true };
  if (j.max_tokens) out.max_tokens = j.max_tokens;
  if (j.temperature !== undefined) out.temperature = j.temperature;
  if (j.top_p !== undefined) out.top_p = j.top_p;
  if (Array.isArray(j.stop_sequences)) out.stop = j.stop_sequences;
  if (Array.isArray(j.tools)) {
    const fnTools = j.tools
      .filter((t) => !(t && typeof t.type === "string" && /^advisor_/.test(t.type)))
      .map((t) => ({ type: "function", function: { name: t.name ?? "", description: t.description ?? "", parameters: t.input_schema ?? {} } }));
    if (fnTools.length) out.tools = fnTools;
  }
  return out;
}

/** Forward an image-bearing request to the local vision model (LM Studio).
 *
 * The leg speaks OpenAI chat.completions, so it translates twice: the request
 * body through anthropicToOpenAI, and the streamed response back into the
 * Anthropic SSE events Claude Code expects. The response answers in the client's
 * vocabulary — message_start carries the display id the normal DeepSeek path
 * would have echoed, not the local model's id — so a resumed session keeps its
 * display model (ADR-0001, applied here exactly as the Anthropic redirect did).
 *
 * The redirect is the fix, not a stage in the fallback chain: `fb` stays null,
 * so a failure on this leg surfaces as an error rather than re-sending the image
 * to the vision-less model. */
function forwardToLocalVision(req, res, reqPath, body, clientModel) {
  let openaiBody;
  try {
    openaiBody = Buffer.from(JSON.stringify(anthropicToOpenAI(body, VISION_MODEL)));
  } catch (err) {
    sendError(res, 400, "api_error", `vision request could not be translated: ${err.message}`);
    return;
  }
  let u;
  try {
    u = new URL(VISION_BASE_URL);
  } catch (err) {
    sendError(res, 500, "api_error", `vision baseUrl is invalid: ${err.message}`);
    return;
  }
  const started = Date.now();
  const lib = u.protocol === "https:" ? https : http;
  const path = `${u.pathname.replace(/\/+$/, "")}/v1/chat/completions`;
  const headers = {
    "content-type": "application/json",
    "content-length": String(openaiBody.length),
    accept: "text/event-stream",
  };
  const upstream = lib.request(
    { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path, method: "POST", headers },
    (up) => {
      const status = up.statusCode ?? 502;
      if (status !== 200) {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          sendError(res, status >= 500 ? 502 : status, "api_error", `local vision model error (${status}): ${raw.slice(0, 200)}`);
          logUsage({ method: req.method, path: reqPath, status, ms: Date.now() - started, model: VISION_MODEL, usage: null, redirected: { to: VISION_MODEL, reason: "vision" }, error: raw.slice(0, 200) });
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // Synthesize the Anthropic envelope. message_start carries the client's
      // display id so the restore contract holds; usage is estimated, since
      // OpenAI's stream does not carry Anthropic-shaped usage unless asked.
      const estIn = estTokens(body.length);
      const msgId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: clientModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estIn, output_tokens: 0 } } })}\n\n`);
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');

      let buf = "";
      let outChars = 0;
      let wroteDelta = false;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearUpstreamTimeout();
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.round(outChars / 4) } })}\n\n`);
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        logUsage({ method: req.method, path: reqPath, status, ms: Date.now() - started, model: VISION_MODEL, usage: { input_tokens: estIn, output_tokens: Math.round(outChars / 4) }, redirected: { to: VISION_MODEL, reason: "vision" } });
      };
      up.setEncoding("utf8");
      up.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          const m = line.match(/^data:\s?(.*)$/);
          if (!m || m[1] === "[DONE]") continue;
          let evt;
          try {
            evt = JSON.parse(m[1]);
          } catch {
            continue;
          }
          const delta = evt.choices?.[0]?.delta;
          const text = delta && typeof delta.content === "string" ? delta.content : null;
          if (text) {
            outChars += text.length;
            wroteDelta = true;
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
          }
          const fr = evt.choices?.[0]?.finish_reason;
          if (fr) finish();
        }
      });
      up.on("end", () => {
        // A response that ended before emitting finish_reason — short, truncated,
        // or non-SSE — still has to reach the client as a complete message. A
        // non-streaming upstream answers a plain chat.completion JSON body:
        // extract its content instead of leaking the raw envelope as the answer.
        if (!wroteDelta && buf.trim()) {
          let text = buf.trim();
          try {
            const o = JSON.parse(text);
            const content = o?.choices?.[0]?.message?.content;
            if (typeof content === "string") text = content;
          } catch { /* not JSON — keep the raw text */ }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
        }
        finish();
      });
    }
  );
  const clearUpstreamTimeout = () => upstream.setTimeout(0);
  upstream.setTimeout(UPSTREAM_TIMEOUT, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, 502, "api_error", `local vision model unreachable (${VISION_BASE_URL}): ${err.message}`);
  });
  upstream.write(openaiBody);
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
      // Seeding endpoint for claudei.sh, which writes Claude Code's own
      // gateway-models.json rather than letting the CLI discover the list.
      // Deliberately not /v1/models: that path merges Anthropic's catalog, which
      // costs an authenticated round trip the launcher cannot make and would not
      // use anyway — the picker already carries Anthropic's models as built-in
      // rows, so only the DeepSeek entries have to be seeded. Named outside /v1
      // so it can never collide with a real Anthropic route.
      if (req.method === "GET" && reqPath === "/_proxy/deepseek-models") {
        const ds = await deepseekModelList();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: ds, has_more: false }));
        return;
      }
      if (req.method === "GET" && reqPath.startsWith("/v1/models")) {
        await serveModels(req, res);
        return;
      }
      let model = null;
      if (body.length > 0) {
        try { model = JSON.parse(body.toString("utf8"))?.model ?? null; } catch { /* not JSON */ }
      }
      const fam = model ? familyOf(model) : null;
      // The resolved DeepSeek-bound target, whether the model was a DeepSeek id
      // outright or a family name being redir-routed. The vision check keys off
      // it: a request carrying an image to a vision-less model is rerouted at
      // route time, not left to 400 upstream. Independent of the retry-on-error
      // fallback — and the redirect leg forwards with fb null on purpose, so a
      // later failure cannot re-send the image to the vision-less model.
      const dsReal = model ? deepseekRealId(model) : null;
      const dsTarget = dsReal ?? (fam && redirOn ? REDIR_MAP[fam] : null);
      const needsVision = !isTokenCount(reqPath) && dsTarget && capabilityOf(dsTarget) === false && hasImageBlock(body);
      if (needsVision) {
        // Echo exactly what the normal DeepSeek path would have echoed: the
        // canonical display id for a DeepSeek model, and the client's own string
        // for a family name being redir-routed. Answering a `--redir --model
        // sonnet` turn with a DeepSeek display id would flip the session model
        // on the user — the same failure ADR-0004 redirects to avoid, pointed
        // the other way. Both tiers echo the same id, for the same reason.
        const echo = dsReal ? displayIdOf(dsReal) : model;
        // Local first: it is opt-in, so a user who configured it asked for it by
        // name, and it costs no plan traffic. The Anthropic tier is the default
        // catch, not the preference.
        if (VISION_REDIRECT) {
          forwardToLocalVision(req, res, reqPath, body, echo);
          return;
        }
        if (VISION_ANTHROPIC) {
          // `fb` is null on purpose, exactly as on the local leg: error-falling
          // back would re-send the image to the vision-less model and fail
          // again. The redirect is the fix, not a stage in the fallback chain.
          let visionBody;
          try {
            visionBody = rewriteVision(body, VISION_ANTHROPIC_MODEL, VISION_ANTHROPIC_EFFORT);
          } catch (err) {
            sendError(res, 400, "api_error", `vision request could not be rewritten: ${err.message}`);
            return;
          }
          void forwardToAnthropic(req, res, reqPath, visionBody, null, {
            restoreModel: echo,
            realModel: VISION_ANTHROPIC_MODEL,
            redirected: { to: VISION_ANTHROPIC_MODEL, reason: "vision" },
          }).catch((err) => sendError(res, 502, "api_error", err.message));
          return;
        }
        // Both tiers off: the turn is about to 400 upstream on a body the model
        // cannot read. That failure reads like a CLI or model-support problem,
        // so name the settings that change it rather than letting the 400 speak.
        warnOnce(`image sent to ${dsTarget}, which cannot see it — the turn will answer anyway, without the image. Set \`vision.anthropic\` back on to answer it on the Anthropic leg, or \`vision.redirect: true\` to route image turns to a local vision model.`, "vision");
      }
      if (model && deepseekRealId(model)) {
        handleDeepSeek(req, res, body, reqPath, null);
        return;
      }
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

// Answers in flight are long-lived SSE streams, so the default response to a
// signal — drop everything the instant the process dies — truncates whatever
// the user was reading. Stop accepting new connections, let the open ones
// finish, and keep a hard deadline so a stuck stream can't block the shutdown
// the launcher is waiting on.
const SHUTDOWN_GRACE = 5000;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[proxy] ${signal} — finishing in-flight responses`);
  const deadline = setTimeout(() => {
    console.error(`[proxy] still busy after ${SHUTDOWN_GRACE / 1000}s — exiting anyway`);
    process.exit(0);
  }, SHUTDOWN_GRACE);
  deadline.unref(); // don't hold the loop open once everything has closed
  server.close(() => {
    for (const stream of [usageStream, debugStream]) stream?.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
