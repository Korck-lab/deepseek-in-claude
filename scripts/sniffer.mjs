/**
 * sniffer.mjs — a transparent tap between Claude Code and api.anthropic.com. Zero deps.
 *
 * Unlike proxy.mjs this rewrites nothing: no model mapping, no credential bridge, no
 * fallback. Every byte the CLI sends is forwarded as-is and every byte Anthropic returns
 * is streamed back untouched. The point is to see what the CLI *actually* does when it is
 * talking to Anthropic on its own terms, so anything this process changed would be a lie
 * in the capture.
 *
 * The one unavoidable exception is `accept-encoding`: it is forced to identity so the
 * bodies are readable. That is visible to the upstream, so it is recorded in each capture
 * rather than hidden.
 *
 * Run:   node scripts/sniffer.mjs --port 8015 [--keep-secrets]
 *        ANTHROPIC_BASE_URL=http://localhost:8015 claude
 *
 * Writes logs/sniff/<seq>_<method>_<path>.json — one file per exchange, request and
 * response together — plus logs/sniff/index.jsonl, one line per exchange for scanning.
 *
 * Credentials are fingerprinted, not stored: an `authorization` or `x-api-key` header is
 * replaced by its scheme, length and a short sha256 prefix, which is enough to tell OAuth
 * from an API key and to tell two tokens apart across runs without putting either on disk.
 * `--keep-secrets` disables that, and logs/ is gitignored, but a capture is still a file
 * someone can paste into a bug report.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "..", "logs", "sniff");
const UPSTREAM = "api.anthropic.com";

const ARGV = process.argv.slice(2);
const PORT = Number(ARGV[ARGV.indexOf("--port") + 1] ?? 8015);
const KEEP_SECRETS = ARGV.includes("--keep-secrets");

fs.mkdirSync(LOG_DIR, { recursive: true });
const INDEX = path.join(LOG_DIR, "index.jsonl");

let seq = 0;

// The tap shares a terminal with Claude Code's full-screen TUI, and anything written to
// stdout lands in the middle of it and corrupts the display. Progress goes to a file
// instead; follow it from another terminal with `tail -f logs/sniff/sniffer.log`.
const RUN_LOG = path.join(LOG_DIR, "sniffer.log");
function note(line) {
  fs.appendFileSync(RUN_LOG, `${new Date().toISOString()} ${line}\n`);
}

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);

/** Enough to identify a credential across captures, not enough to use one. */
function fingerprint(value) {
  const raw = String(value);
  const sha = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const scheme = raw.startsWith("Bearer sk-ant-oat") ? "Bearer <oauth>"
    : raw.startsWith("Bearer sk-ant-") ? "Bearer <anthropic-key>"
    : raw.startsWith("Bearer ") ? "Bearer <opaque>"
    : raw.startsWith("sk-ant-") ? "<anthropic-key>"
    : "<opaque>";
  return `${scheme} len=${raw.length} sha256:${sha}`;
}

function safeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = !KEEP_SECRETS && SECRET_HEADERS.has(k.toLowerCase()) ? fingerprint(v) : v;
  }
  return out;
}

function parseBody(buf) {
  const text = buf.toString("utf8");
  if (!text) return { raw: "" };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { raw: text };
  }
}

/** SSE is the interesting case: keep the raw stream, but also give a decoded view so a
 *  capture can be read without replaying the framing by eye. */
function decodeSse(text) {
  if (!text.startsWith("event:") && !text.includes("\ndata:")) return null;
  const events = [];
  for (const block of text.split(/\n\n/)) {
    const ev = block.match(/^event:\s*(.+)$/m)?.[1];
    const data = block.match(/^data:\s*(.+)$/m)?.[1];
    if (!ev && !data) continue;
    let parsed = null;
    try { parsed = data ? JSON.parse(data) : null; } catch { /* keep raw */ }
    events.push({ event: ev ?? null, data: parsed ?? data ?? null });
  }
  const usage = events.map((e) => e.data?.usage ?? e.data?.message?.usage).filter(Boolean).at(-1) ?? null;
  const model = events.map((e) => e.data?.message?.model).filter(Boolean).at(-1) ?? null;
  const stop = events.map((e) => e.data?.delta?.stop_reason).filter(Boolean).at(-1) ?? null;
  return { events, usage, model, stop_reason: stop };
}

function slug(url) {
  return url.replace(/^\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "root";
}

function write(record) {
  const n = String(record.seq).padStart(4, "0");
  const file = path.join(LOG_DIR, `${n}_${record.request.method}_${slug(record.request.path)}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  fs.appendFileSync(INDEX, JSON.stringify({
    seq: record.seq,
    at: record.at,
    method: record.request.method,
    path: record.request.path,
    status: record.response?.status ?? null,
    ms: record.ms,
    model: record.response?.sse?.model ?? record.request.body?.json?.model ?? null,
    usage: record.response?.sse?.usage ?? record.response?.body?.json?.usage ?? null,
    auth: record.request.headers.authorization ?? record.request.headers["x-api-key"] ?? null,
    file: path.basename(file),
  }) + "\n");
  return file;
}

const server = http.createServer((req, res) => {
  const id = ++seq;
  const started = Date.now();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    // Hop-by-hop headers are per-connection and meaningless to the upstream; identity
    // encoding is forced so the capture holds readable bytes. Everything else, including
    // whatever credential the CLI chose, goes up exactly as it arrived.
    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["connection"];
    delete headers["accept-encoding"];
    delete headers["transfer-encoding"];
    delete headers["content-length"];
    if (body.length > 0) headers["content-length"] = String(body.length);

    const record = {
      seq: id,
      at: new Date(started).toISOString(),
      note: KEEP_SECRETS ? "credentials logged verbatim (--keep-secrets)" : "credentials fingerprinted, not stored",
      rewrites: ["accept-encoding forced to identity"],
      request: {
        method: req.method,
        path: req.url,
        headers: safeHeaders(headers),
        body: parseBody(body),
      },
    };

    const upstream = https.request(
      { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
      (up) => {
        const outHeaders = { ...up.headers };
        delete outHeaders["connection"];
        delete outHeaders["transfer-encoding"];
        delete outHeaders["content-encoding"];
        res.writeHead(up.statusCode ?? 502, outHeaders);
        const respChunks = [];
        up.on("data", (c) => { respChunks.push(c); res.write(c); });
        up.on("end", () => {
          res.end();
          const raw = Buffer.concat(respChunks).toString("utf8");
          record.ms = Date.now() - started;
          record.response = {
            status: up.statusCode ?? 0,
            headers: safeHeaders(up.headers),
            sse: decodeSse(raw),
            body: raw.startsWith("event:") || raw.includes("\ndata:") ? { raw } : parseBody(Buffer.from(raw)),
          };
          const file = write(record);
          note(`#${id} ${req.method} ${req.url} -> ${record.response.status} ${record.ms}ms  ${path.basename(file)}`);
        });
      }
    );
    upstream.on("error", (err) => {
      record.ms = Date.now() - started;
      record.response = { status: 0, error: err.message };
      write(record);
      note(`#${id} ${req.method} ${req.url} -> upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
      } else {
        res.destroy();
      }
    });
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
});

// Loopback only: this process handles the user's live credentials, so a 0.0.0.0 bind
// would hand them to anything on the LAN.
server.listen(PORT, "127.0.0.1", () => {
  note(`[sniffer] http://127.0.0.1:${PORT} -> https://${UPSTREAM}`);
  note(`[sniffer] captures: ${LOG_DIR}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    note(`[sniffer] ${sig} — ${seq} exchange(s) captured in ${LOG_DIR}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
