#!/usr/bin/env node
/**
 * COORD PROXY v1.0 — Wu-Wei + HDGL Coordination Layer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sits at port 1618 between clients and LM Studio (port 1234).
 * Routes every chat/completions request through phi-emergent coordination:
 *
 *   phi < 0.618  →  SOLO      (61.8% of requests) — one LLM, phi selects which
 *   phi < 0.854  →  RELAY     (23.6%)  — LLM1 drafts, LLM2 refines
 *   phi >= 0.854 →  CHALLENGE (14.6%)  — LLM1 answers, LLM2 critiques, LLM1 revises
 *
 * The mode is NOT a rule — it emerges from the phi-hash of the request content.
 * Same request geometry → same mode. Different content → naturally distributed.
 *
 * LLM pairing:
 *   LLM1 (qwen3.5-9b@q2_k_xl)    ↔  MCP tools on port 4111  (ctx: 200,000)
 *   LLM2 (qwen3.5-9b@q2_k_xl:2)  ↔  MCP tools on port 4112  (ctx: 199,999)
 *
 * Every coordination event is committed to erl-ledger.json (hash-chained).
 *
 * Endpoints:
 *   POST /v1/chat/completions  — coordinated inference
 *   GET  /v1/models            — passthrough to LM Studio
 *   GET  /status               — live routing + health state
 *   ALL  /*                    — transparent passthrough to LM Studio
 *
 * Start: node coord-proxy.js
 * Or:    $env:COORD_PORT=1618; node coord-proxy.js
 */

import http    from 'http';
import crypto  from 'crypto';
import fs      from 'fs';
import path    from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROXY_PORT  = parseInt(process.env.COORD_PORT  || '1618');
const BIND_HOST   = process.env.COORD_BIND_HOST || '0.0.0.0';
const LLM_HOST    = process.env.LLM_HOST || '127.0.0.1';
const LLM_PORT    = parseInt(process.env.LLM_PORT    || '1234');
const LLM1        = process.env.LLM1 || 'qwen3.5-9b@q2_k_xl';
const LLM2        = process.env.LLM2 || 'qwen3.5-9b@q2_k_xl:2';
const STATE_DIR   = path.join(__dirname, 'wuwei-routing', 'state');
const LEDGER_FILE = path.join(__dirname, 'erl-ledger.json');

// ─── PHI ENGINE ───────────────────────────────────────────────────────────────
//
// The golden ratio φ = 1.618... creates a natural non-uniform distribution
// across the unit interval. We hash the request content and normalize through
// φ so that similar requests cluster in the same mode, and the distribution
// over the full traffic naturally approaches Fibonacci ratios.

const PHI = 1.6180339887;

function phiHash(input) {
  const hash = crypto.createHash('sha256').update(String(input)).digest('hex');
  const num  = parseInt(hash.slice(0, 8), 16);              // 32-bit integer from hash
  return ((num * PHI) % 1000000) / 1000000;                 // normalize to [0, 1)
}

function selectMode(phi) {
  if (phi < 0.618) return 'SOLO';       // major arc  — single LLM
  if (phi < 0.854) return 'RELAY';      // minor arc  — draft → refine
  return 'CHALLENGE';                    // remainder  — answer → critique → revise
}

function selectSoloLlm(phi, hdglActive) {
  // Within SOLO: phi below the reciprocal → LLM1, above → LLM2.
  // HDGL active_server can bias the decision (health-aware pairing).
  if (hdglActive === 'phi-mirror')   return LLM2;
  if (hdglActive === 'phi-primary')  return LLM1;
  return phi < 0.309 ? LLM1 : LLM2;
}

// ─── ERL LEDGER ──────────────────────────────────────────────────────────────

function erlAppend(role, content, tags = [], branch = 'coord') {
  try {
    let ledger = { version: '3.0', entries: {}, branches: {} };
    if (fs.existsSync(LEDGER_FILE)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    }
    const parentId   = ledger.branches[branch] ?? null;
    const timestamp  = new Date().toISOString();
    const parentHash = parentId ? (ledger.entries[parentId]?.id ?? '') : '';
    const id = crypto.createHash('sha256')
      .update(parentHash + timestamp + branch + content)
      .digest('hex');

    ledger.entries[id] = { id, parentId, branch, timestamp, role, content, tags, sessionId: 'coord-proxy' };
    ledger.branches[branch] = id;
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
    return id;
  } catch (e) {
    console.error('[ERL] write failed:', e.message);
    return null;
  }
}

// ─── LLM CALL ────────────────────────────────────────────────────────────────

// ── inference1 preset defaults (applied to every API call) ─────────────────
// Mirrors ~/.lmstudio/config-presets/inference1.preset.json so these values
// are active for both LLM slots regardless of lms load having no --preset flag.
const INFERENCE1 = {
  temperature      : 1,
  top_p            : 0.95,
  top_k            : 20,
  repeat_penalty   : 1,
  presence_penalty : 0,
  min_p            : 0,
  max_tokens       : 2048,
};

function callLlm(model, messages, overrides = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages,
      temperature      : overrides.temperature      ?? INFERENCE1.temperature,
      top_p            : overrides.top_p            ?? INFERENCE1.top_p,
      top_k            : overrides.top_k            ?? INFERENCE1.top_k,
      repeat_penalty   : overrides.repeat_penalty   ?? INFERENCE1.repeat_penalty,
      presence_penalty : overrides.presence_penalty ?? INFERENCE1.presence_penalty,
      min_p            : overrides.min_p            ?? INFERENCE1.min_p,
      max_tokens       : overrides.max_tokens       ?? INFERENCE1.max_tokens,
      stream           : false
    });

    const req = http.request({
      hostname : LLM_HOST,
      port     : LLM_PORT,
      path     : '/v1/chat/completions',
      method   : 'POST',
      headers  : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout  : 180000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`LLM parse error: ${e.message} | raw: ${data.slice(0, 300)}`)); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`LLM timeout (${model})`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function text(response) {
  return response?.choices?.[0]?.message?.content ?? '';
}

// ─── COORDINATION MODES ───────────────────────────────────────────────────────

async function runSolo(messages, chosenLlm, tag) {
  console.log(`${tag} SOLO → ${chosenLlm}`);
  const response = await callLlm(chosenLlm, messages);
  return { mode: 'SOLO', llm: chosenLlm, response };
}

async function runRelay(messages, tag) {
  console.log(`${tag} RELAY → ${LLM1} draft …`);
  const draft        = await callLlm(LLM1, messages);
  const draftContent = text(draft);

  const refineMessages = [
    ...messages,
    { role: 'assistant', content: draftContent },
    { role: 'user',      content: 'Refine and improve the above response. Be more precise, clear, and complete. Output only the improved response.' }
  ];

  console.log(`${tag} RELAY → ${LLM2} refine …`);
  const refined = await callLlm(LLM2, refineMessages);
  return { mode: 'RELAY', llm: `${LLM1}→${LLM2}`, draft: draftContent, response: refined };
}

async function runChallenge(messages, tag) {
  console.log(`${tag} CHALLENGE → ${LLM1} answer …`);
  const answer        = await callLlm(LLM1, messages);
  const answerContent = text(answer);

  const critiqueMessages = [
    ...messages,
    { role: 'assistant', content: answerContent },
    { role: 'user',      content: 'Critique the above response. Identify errors, gaps, or improvements. Be direct and specific. Do not rewrite it yet.' }
  ];

  console.log(`${tag} CHALLENGE → ${LLM2} critique …`);
  const critique        = await callLlm(LLM2, critiqueMessages);
  const critiqueContent = text(critique);

  const reviseMessages = [
    ...messages,
    { role: 'assistant', content: answerContent },
    { role: 'user',      content: `A peer review identified the following issues:\n\n${critiqueContent}\n\nRevise your response addressing every point raised.` }
  ];

  console.log(`${tag} CHALLENGE → ${LLM1} revise …`);
  const revised = await callLlm(LLM1, reviseMessages);
  return { mode: 'CHALLENGE', llm: `${LLM1}↔${LLM2}`, critique: critiqueContent, response: revised };
}

// ─── HDGL STATE READ ─────────────────────────────────────────────────────────

function readHdglActive() {
  try { return fs.readFileSync(path.join(STATE_DIR, 'active_server'), 'utf8').trim(); }
  catch { return 'phi-primary'; }
}

function readHdglHealth() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'health.json'), 'utf8')); }
  catch { return null; }
}

// ─── PASSTHROUGH HELPER ───────────────────────────────────────────────────────

function passthrough(req, res, body) {
  const opts = {
    hostname : LLM_HOST,
    port     : LLM_PORT,
    path     : req.url,
    method   : req.method,
    headers  : { ...req.headers, host: `${LLM_HOST}:${LLM_PORT}` },
    timeout  : 120000
  };
  const upstream = http.request(opts, upRes => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
  if (body) upstream.write(body);
  upstream.end();
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── / and /chat — serve the chat UI ──────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/chat')) {
    const chatFile = path.join(__dirname, 'chat.html');
    try {
      const html = fs.readFileSync(chatFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('chat.html not found — run install again.');
    }
    return;
  }

  // ── /status ───────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      proxy      : 'coord-proxy v1.0',
      mode       : 'wu-wei + HDGL',
      port       : PROXY_PORT,
      llm1       : LLM1,
      llm2       : LLM2,
      lm_studio  : `http://${LLM_HOST}:${LLM_PORT}`,
      distribution: { SOLO: '61.8%', RELAY: '23.6%', CHALLENGE: '14.6%' },
      hdgl_active : readHdglActive(),
      hdgl_health : readHdglHealth()
    }, null, 2));
    return;
  }

  // ── collect body, then route ───────────────────────────────────────────────
  let rawBody = '';
  req.on('data', chunk => rawBody += chunk);
  req.on('end', async () => {

    // ── /v1/chat/completions — coordination entry point ─────────────────────
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON body' })); return; }

      const messages    = parsed.messages ?? [];
      const contentStr  = messages.map(m => m.content).join(' ');
      const phi         = phiHash(contentStr);
      const hdglActive  = readHdglActive();
      const tag         = `[${new Date().toISOString().slice(11,19)}][φ=${phi.toFixed(4)}]`;

      // x-hdgl-mode header (or ?mode= query param) overrides phi-selection.
      // Use 'relay' or 'challenge' to force both LLMs on every request.
      const modeOverride = (req.headers['x-hdgl-mode'] ||
        new URL(req.url, 'http://localhost').searchParams.get('mode') || '').toUpperCase();
      const VALID_MODES  = ['SOLO', 'RELAY', 'CHALLENGE'];
      const mode         = VALID_MODES.includes(modeOverride) ? modeOverride : selectMode(phi);

      console.log(`${tag} "${contentStr.slice(0, 70).replace(/\n/g,' ')}…" → ${mode}${modeOverride ? ' (forced)' : ''}`);

      const start = Date.now();
      try {
        let result;
        if (mode === 'SOLO') {
          result = await runSolo(messages, selectSoloLlm(phi, hdglActive), tag);
        } else if (mode === 'RELAY') {
          result = await runRelay(messages, tag);
        } else {
          result = await runChallenge(messages, tag);
        }

        const duration = Date.now() - start;
        erlAppend('result', JSON.stringify({
          mode         : result.mode,
          llm          : result.llm,
          phi          : phi.toFixed(6),
          hdgl_active  : hdglActive,
          duration_ms  : duration,
          prompt       : contentStr.slice(0, 120),
          ...(result.draft     ? { draft_preview    : result.draft.slice(0, 120)     } : {}),
          ...(result.critique  ? { critique_preview : result.critique.slice(0, 120)  } : {})
        }), ['coord', mode.toLowerCase()], 'coord');

        console.log(`${tag} ✓ ${mode} done in ${duration}ms`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.response));

      } catch (e) {
        console.error(`[COORD ERROR] ${e.message}`);
        erlAppend('error', e.message, ['coord', 'error'], 'coord');
        res.writeHead(502);
        res.end(JSON.stringify({ error: { message: e.message, type: 'coord_proxy_error' } }));
      }
      return;
    }

    // ── everything else — transparent passthrough to LM Studio ──────────────
    passthrough(req, res, rawBody || null);
  });
});

server.listen(PROXY_PORT, BIND_HOST, () => {
  console.log('════════════════════════════════════════════════════');
  console.log('  COORD PROXY v1.0  —  Wu-Wei + HDGL');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Proxy     →  http://${BIND_HOST}:${PROXY_PORT}`);
  console.log(`  LM Studio →  http://${LLM_HOST}:${LLM_PORT}`);
  console.log(`  LLM1      →  ${LLM1}  (ctx 200,000 / MCP :4111)`);
  console.log(`  LLM2      →  ${LLM2}  (ctx 199,999 / MCP :4112)`);
  console.log(`  Modes     →  SOLO 61.8% | RELAY 23.6% | CHALLENGE 14.6%`);
  console.log(`  Force     →  header x-hdgl-mode: relay|challenge  (uses both LLMs)`);
  console.log(`  Preset    →  inference1  (temp=1, top_k=20, rep=1, pres=0, min_p=0)`);
  console.log(`  ERL       →  ${LEDGER_FILE}`);
  console.log(`  Status    →  http://${BIND_HOST}:${PROXY_PORT}/status`);
  console.log('════════════════════════════════════════════════════');
});
