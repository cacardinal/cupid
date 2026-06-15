#!/usr/bin/env node
// Local HTTP bridge: Anthropic-shaped requests -> `claude -p` (subscription/Agent SDK).
// POST /complete {model, system, messages:[{role,content}], max_tokens} -> {content:[{type:"text",text}], usage}
// Concurrency-pooled, retried, usage logged to sim/state/usage.jsonl.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE = path.join(DIR, "state", "usage.jsonl");
const PORT = parseInt(process.env.BRIDGE_PORT ?? "5599", 10);
// DEMO throughput: default 12 concurrent `claude -p` workers (was 6). Env
// BRIDGE_POOL dials it back if Anthropic returns 429s on the shared Max sub.
const POOL = parseInt(process.env.BRIDGE_POOL ?? "12", 10);
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

const MODEL_MAP = { /* SDK ids -> CLI aliases */
  "claude-sonnet-4-5": "sonnet", "claude-haiku-4-5-20251001": "haiku",
  sonnet: "sonnet", haiku: "haiku", opus: "opus",
};

let active = 0; const queue = [];
function acquire() { return new Promise((r) => (active < POOL ? (active++, r()) : queue.push(r))); }
function release() { active--; const n = queue.shift(); if (n) { active++; n(); } }

function runClaude(model, system, prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--model", model, "--output-format", "json"];
    if (system) args.push("--system-prompt", system);
    const child = spawn(CLAUDE, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("bridge timeout 180s")); }, 180_000);
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error("bad json from claude: " + out.slice(0, 200))); }
    });
    child.stdin.write(prompt); child.stdin.end();
  });
}

function flatten(messages) {
  // Serialize a conversation into a single prompt the CLI can complete.
  return messages.map((m) => (m.role === "user" ? `[USER]: ${m.content}` : `[ASSISTANT]: ${m.content}`)).join("\n\n")
    + "\n\nReply with ONLY the next assistant message (no role tag, no commentary).";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET") { res.end(JSON.stringify({ ok: true, active, queued: queue.length })); return; }
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", async () => {
    await acquire();
    const t0 = Date.now();
    try {
      const { model, system, messages, _job } = JSON.parse(body);
      const cli = MODEL_MAP[model] ?? "haiku";
      let env, lastErr;
      for (let i = 0; i < 3; i++) {
        try { env = await runClaude(cli, system, flatten(messages)); break; }
        catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
      }
      if (!env) throw lastErr;
      const text = env.result ?? "";
      const u = env.usage ?? {};
      fs.appendFileSync(USAGE, JSON.stringify({ kind: "usage", ts: new Date().toISOString(), job: _job ?? "cupid-sim", model: cli, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, total_cost_usd: env.total_cost_usd, duration_ms: Date.now() - t0 }) + "\n");
      res.end(JSON.stringify({ content: [{ type: "text", text }], usage: u, model }));
    } catch (e) {
      res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message ?? e) }));
    } finally { release(); }
  });
});
server.listen(PORT, () => console.log(`bridge on :${PORT} pool=${POOL} claude=${CLAUDE}`));
