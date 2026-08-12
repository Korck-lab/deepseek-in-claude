/**
 * observe.mjs — sniff proxy for probe.mjs. Zero deps.
 *
 * Sits between Claude Code and an upstream (Anthropic or DeepSeek), forwards
 * every request, streams the response back, and writes full request/response
 * captures to logs/probe/. Target auth handling matches proxy.mjs:
 *   --target anthropic  — headers pass through untouched (CLI keychain auth).
 *                         Raw passthrough on purpose: this harness exists to
 *                         capture what the CLI really sends, so unlike the proxy
 *                         it does NOT enforce ADR-0002 and will forward an
 *                         x-api-key you have exported straight to Anthropic.
 *   --target deepseek   — x-api-key substituted from .env DEEPSEEK_API_KEY,
 *                         authorization dropped (proxy.mjs:813-814)
 *
 * Run:   node scripts/observe.mjs --port 8788 --target anthropic
 *
 * One capture file per request: logs/probe/<ts>_<tag>.jsonl (request+response
 * in one record, response SSE kept raw + decoded events + usage).
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "..", "logs", "probe");

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1] ?? 8788);
const TARGET = args[args.indexOf("--target") + 1] ?? "anthropic";

// DeepSeek upstream + key, read like proxy.mjs does.
function loadEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(HERE, "..", ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env */ }
  return out;
}
const ENV = loadEnv();
const UPSTREAM = TARGET === "deepseek"
  ? (process.env.DEEPSEEK_ANTHROPIC_BASE_URL ?? ENV.DEEPSEEK_ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic")
  : "https://api.anthropic.com";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ENV.DEEPSEEK_API_KEY ?? "";

/** probe.mjs drops the case tag here before each claude run; observe picks it up. */
const TAG_FILE = "/tmp/probe-tag";
const readTag = () => { try { return fs.readFileSync(TAG_FILE, "utf8").trim(); } catch { return "untagged"; } };

function forwardHeaders(headers, body, upstreamUrl) {
  const out = { ...headers };
  delete out["host"];
  delete out["connection"];
  delete out["accept-encoding"]; // force identity so we can read the stream
  delete out["transfer-encoding"];
  delete out["content-length"];
  if (body.length > 0) out["content-length"] = String(body.length);
  if (TARGET === "deepseek") {
    out["x-api-key"] = DEEPSEEK_API_KEY;
    delete out["authorization"];
  }
  return out;
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
  return { events, usage };
}

fs.mkdirSync(LOG_DIR, { recursive: true });

http.createServer((req, res) => {
  const reqPath = req.url ?? "/";
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const started = Date.now();
    const tag = readTag();
    let u;
    try { u = new URL(UPSTREAM + reqPath); } catch { res.writeHead(500); res.end(); return; }
    const lib = u.protocol === "https:" ? https : http;
    const upstream = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: req.method ?? "POST", headers: forwardHeaders(req.headers, body, u) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const respChunks = [];
        up.on("data", (c) => { respChunks.push(c); res.write(c); });
        up.on("end", () => {
          res.end();
          const rawResp = Buffer.concat(respChunks).toString("utf8");
          const { events, usage } = reqPath.includes("/messages") ? decodeSse(rawResp) : { events: null, usage: null };
          const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
          const record = {
            ts: new Date().toISOString(),
            tag,
            target: TARGET,
            method: req.method ?? "POST",
            path: reqPath,
            status: up.statusCode ?? 0,
            ms: Date.now() - started,
            requestHeaders: { ...req.headers, authorization: req.headers.authorization ? "[REDACTED]" : undefined, "x-api-key": req.headers["x-api-key"] ? "[REDACTED]" : undefined },
            requestBody: body.toString("utf8"),
            responseBody: rawResp,
            responseEvents: events,
            usage,
          };
          fs.mkdirSync(LOG_DIR, { recursive: true });
          fs.writeFileSync(path.join(LOG_DIR, `${ts}_${tag.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`), JSON.stringify(record) + "\n");
          const s = record.status;
          const uu = usage ? `usage_in=${usage.input_tokens ?? "?"}+cc=${usage.cache_creation_input_tokens ?? 0}+cr=${usage.cache_read_input_tokens ?? 0}` : "";
          console.log(`[observe] ${tag} ${req.method} ${reqPath} -> ${s} ${Date.now() - started}ms ${uu}`);
        });
      }
    );
    upstream.on("error", (err) => {
      console.error(`[observe] upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `observe upstream error: ${err.message}` }));
    });
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
}).listen(PORT, () => console.log(`[observe] listening :${PORT} target=${TARGET} -> ${UPSTREAM}`));
