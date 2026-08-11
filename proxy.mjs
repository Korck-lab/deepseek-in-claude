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
 * Run:   node proxy.mjs
 * Point Claude Code at it:
 *   ANTHROPIC_BASE_URL=http://localhost:8787 claude
 *
 * Config lives in .env (or real env vars):
 *   DEEPSEEK_API_KEY=...
 *   DEEPSEEK_BASE_URL=https://api.deepseek.com
 *   DEEPSEEK_MODEL=deepseek-v4-flash        # comma-separated fallbacks
 *   DEEPSEEK_ANTHROPIC_BASE_URL=           # optional override, defaults to
 *                                          #   $DEEPSEEK_BASE_URL/anthropic
 *
 * Zero runtime dependencies — Node built-ins only. Requires Node 18+.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = "api.anthropic.com";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config from .env (real env vars win)
// ---------------------------------------------------------------------------

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
// DeepSeek model list — live from the API, cached, fallback to .env
// ---------------------------------------------------------------------------

const MODEL_CACHE_TTL = 10 * 60 * 1000;
let dsModelsCache = { at: 0, models: null };
let deepseekIds = new Set(DEFAULT_MODELS);

function toModelEntry(id, created) {
  return { id, display_name: `DeepSeek ${id}`, created_at: created || Math.floor(Date.now() / 1000), type: "model" };
}

async function deepseekModelList() {
  if (dsModelsCache.models && Date.now() - dsModelsCache.at < MODEL_CACHE_TTL) return dsModelsCache.models;
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
  dsModelsCache = { at: Date.now(), models: list };
  return list;
}

async function refreshDeepseekIds() {
  try {
    deepseekIds = new Set((await deepseekModelList()).map((m) => m.id));
  } catch {
    /* keep fallback */
  }
}
refreshDeepseekIds();

const isDeepSeekModel = (id) => deepseekIds.has(id);

/** Claude Code effort levels: low, medium, high, xhigh, max. DeepSeek
 * documents low/medium/high/max only — fold xhigh into max so effort is
 * actually honored instead of silently ignored upstream. */
const EFFORT_MAP = { xhigh: "max" };

// ---------------------------------------------------------------------------
// DeepSeek routing — transparent passthrough to the Anthropic-compatible API
// ---------------------------------------------------------------------------

function handleDeepSeek(req, res, body, reqPath) {
  if (isTokenCount(reqPath)) {
    const est = estTokens(body.length);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: est }));
    return;
  }

  let forwardedBody = body;
  try {
    const reqJson = JSON.parse(body.toString("utf8"));
    if (reqJson?.output_config?.effort && EFFORT_MAP[reqJson.output_config.effort]) {
      reqJson.output_config.effort = EFFORT_MAP[reqJson.output_config.effort];
      forwardedBody = Buffer.from(JSON.stringify(reqJson));
    }
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
  const upstream = lib.request(
    { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: req.method ?? "POST", headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, cleanResponseHeaders(up.headers));
      up.on("data", (c) => res.write(c));
      up.on("end", () => res.end());
    }
  );
  upstream.on("error", (err) => {
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, 502, "api_error", `deepseek upstream error: ${err.message}`);
  });
  if (forwardedBody.length > 0) upstream.write(forwardedBody);
  upstream.end();
}

// ---------------------------------------------------------------------------
// Merged model list
// ---------------------------------------------------------------------------

async function serveModels(req, res) {
  const anthropicModels = await new Promise((resolve) => {
    const upstream = https.request(
      { hostname: UPSTREAM, port: 443, path: req.url ?? "/v1/models", method: "GET", headers: forwardHeaders(req.headers, Buffer.alloc(0)) },
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
  deepseekIds = new Set(ds.map((m) => m.id));

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

function forwardToAnthropic(req, res, reqPath, body) {
  const upstream = https.request(
    { hostname: UPSTREAM, port: 443, path: reqPath, method: req.method, headers: forwardHeaders(req.headers, body) },
    (up) => {
      res.writeHead(up.statusCode ?? 502, cleanResponseHeaders(up.headers));
      up.on("data", (c) => res.write(c));
      up.on("end", () => res.end());
    }
  );
  upstream.on("error", (err) => {
    if (res.headersSent) { res.destroy(); return; }
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
    try {
      if (req.method === "GET" && reqPath.startsWith("/v1/models")) {
        await serveModels(req, res);
        return;
      }
      let model = null;
      if (body.length > 0) {
        try { model = JSON.parse(body.toString("utf8"))?.model ?? null; } catch { /* not JSON */ }
      }
      if (model && isDeepSeekModel(model)) {
        handleDeepSeek(req, res, body, reqPath);
        return;
      }
      forwardToAnthropic(req, res, reqPath, body);
    } catch (err) {
      sendError(res, 500, "api_error", `proxy handler error: ${err.message}`);
    }
  });
}

http.createServer(handle).listen(PORT);
