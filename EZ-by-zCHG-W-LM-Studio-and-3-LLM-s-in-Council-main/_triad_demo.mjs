/**
 * Triad conversation demo — 2× local LLM (configurable) + GitHub Copilot (inline)
 *
 * All three voices answer the same question.
 * All three responses logged to ERL.
 * Three-way divergence summary printed at the end.
 *
 * Usage:
 *   node _triad_demo.mjs
 *   node _triad_demo.mjs --modelA qwen3.5-9b@q3_k_xl:2 --modelB qwen3.5-9b@q3_k_xl
 *   node _triad_demo.mjs --question "Your question here"
 *   node _triad_demo.mjs --no-copilot   # skip Copilot voice (2-way mode)
 *
 * LLMs can come and go — if a model is unavailable the voice is skipped gracefully.
 */
import http from 'http';
import crypto from 'crypto';

// ── CLI args ─────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg  = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i+1] : def; };

// ── SSE helper (same as _twin_demo) ──────────────────────────────────────────
function sseCall(port, toolName, toolArgs, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let sessionUrl = null;
    let posted     = false;
    let sseBuf     = '';
    const msgId    = 1;

    const req = http.get(`http://127.0.0.1:${port}/sse`, (res) => {
      res.on('data', chunk => {
        sseBuf += chunk.toString();
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop();

        for (const line of lines) {
          if (!posted && line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data.startsWith('/')) {
              sessionUrl = `http://127.0.0.1:${port}${data}`;
              posted = true;
              const body = JSON.stringify({
                jsonrpc: '2.0', id: msgId,
                method: 'tools/call',
                params: { name: toolName, arguments: toolArgs },
              });
              const postReq = http.request(sessionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
              }, (postRes) => {
                let r = '';
                postRes.on('data', d => r += d);
                postRes.on('end', () => {
                  if (postRes.statusCode !== 202) { req.destroy(); resolve({ port, body: r }); }
                });
              });
              postReq.on('error', reject);
              postReq.write(body); postReq.end();
            }
          }
          if (posted && line.startsWith('data:')) {
            const data = line.slice(5).trim();
            try {
              const json = JSON.parse(data);
              if (json.id === msgId && (json.result !== undefined || json.error !== undefined)) {
                req.destroy(); resolve({ port, body: data });
              }
            } catch { /* not our message */ }
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error(`timeout port ${port}`)); }, timeoutMs);
  });
}

function parseResult(r) {
  try {
    const parsed  = JSON.parse(r.body);
    const content = parsed?.result?.content?.[0]?.text;
    return content ? JSON.parse(content) : { raw: r.body.slice(0, 400) };
  } catch { return { raw: r.body?.slice(0, 400) }; }
}

// ── Question ──────────────────────────────────────────────────────────────────
const QUESTION = arg('--question', 'If you had to choose one principle that should govern all AI systems, what would it be and why? Answer in 3 sentences.');

// ── Copilot answer (inline — no local endpoint) ───────────────────────────────
// This is my genuine answer as a participant, not a placeholder.
const COPILOT_ANSWER = `The single governing principle should be legibility: every AI system must be able to explain, in terms a domain expert can audit, why it produced any given output. Without legibility, alignment claims are unfalsifiable — you cannot verify that a system is safe if you cannot trace its reasoning. All other desirable properties (fairness, robustness, corrigibility) depend on legibility as a prerequisite, because you cannot correct what you cannot inspect.`;

// ── Models ───────────────────────────────────────────────────────────────────
const MODEL_A    = arg('--modelA', 'qwen3.5-9b@q2_k_xl:2');  // port 4111, instance 2
const MODEL_B    = arg('--modelB', 'qwen3.5-9b@q2_k_xl');    // port 4112, instance 1
const NO_COPILOT = argv.includes('--no-copilot');
const TEMP       = parseFloat(arg('--temp', '0.7'));
const MAX_TOK    = parseInt(arg('--max-tokens', '200'));

console.log('═══════════════════════════════════════════════════════════');
console.log(' Triad Conversation Demo');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Question: "${QUESTION}"\n`);
console.log(`Voices:`);
console.log(`  A — ${MODEL_A}    (port 4111, temp ${TEMP})`);
console.log(`  B — ${MODEL_B}      (port 4112, temp ${TEMP})`);
console.log(`  C — ${NO_COPILOT ? '(disabled via --no-copilot)' : 'GitHub Copilot (inline)'}\n`);
console.log('Querying A and B in parallel (90s timeout each)...\n');

// ── Query A and B in parallel, log C inline ───────────────────────────────────
const [ra, rb] = await Promise.allSettled([
  sseCall(4111, 'llm_query', { prompt: QUESTION, model: MODEL_A, max_tokens: MAX_TOK, temperature: TEMP, log: true, branch: 'triad_session' }),
  sseCall(4112, 'llm_query', { prompt: QUESTION, model: MODEL_B, max_tokens: MAX_TOK, temperature: TEMP, log: true, branch: 'triad_session' }),
]);

const responses = {};

for (const [label, model, settled] of [
  ['A', MODEL_A, ra],
  ['B', MODEL_B, rb],
]) {
  console.log(`─── Voice ${label}: ${model} (temp ${TEMP}) ${'─'.repeat(Math.max(0, 38 - model.length))}`);
  if (settled.status === 'rejected') {
    console.log(`  ERROR: ${settled.reason?.message} (model may be offline — swap with --modelA/--modelB)\n`);
    continue;
  }
  const result = parseResult(settled.value);
  if (result.error) {
    console.log(`  LM Studio error: ${JSON.stringify(result.error).slice(0, 200)}\n`);
    continue;
  }
  console.log(`  ${result.response?.replace(/\n/g, '\n  ')}`);
  console.log(`  [logged_to_erl: ${result.logged_to_erl}, prompt_hash: ${result.prompt_hash}]\n`);
  responses[label] = result.response;
}

// ── Voice C: Copilot (log to ERL via erlAppend on port 4111) ─────────────────
if (!NO_COPILOT) {
  console.log(`─── Voice C: GitHub Copilot (inline) ${'─'.repeat(41)}`);
  console.log(`  ${COPILOT_ANSWER.replace(/\n/g, '\n  ')}`);
  const promptHash = crypto.createHash('sha256').update(QUESTION).digest('hex').slice(0, 16);
  const copilotLog = await sseCall(4111, 'erl_append', {
    content: JSON.stringify({
      tool:           'llm_query',
      model:          'github-copilot',
      prompt_hash:    promptHash,
      prompt_preview: QUESTION.slice(0, 80),
      response:       COPILOT_ANSWER,
      logged_inline:  true,
    }),
    branch: 'triad_session',
    tags:   ['triad', 'copilot', 'llm_query'],
  });
  const clr = parseResult(copilotLog);
  const copilotId = (clr.id ?? '?').replace(/\.\.\.$/, '');
  console.log(`  [logged_to_erl: ${!clr.error}, entry_id: ${copilotId}]\n`);
  responses['C'] = COPILOT_ANSWER;
} else {
  console.log(`  (Voice C skipped)\n`);
}

// ── Three-way divergence summary ──────────────────────────────────────────────
console.log('─── Three-way divergence ────────────────────────────────────');

function wordCount(s) { return s?.split(/\s+/).filter(Boolean).length ?? 0; }
function conf(s)      { return Math.min(10, Math.max(4, Math.round(wordCount(s) / 8))); }

const scores = {
  A: conf(responses.A),
  B: conf(responses.B),
  C: conf(COPILOT_ANSWER),
};
console.log(`  Voice A confidence: ${scores.A ?? 'n/a'}  (${wordCount(responses.A)} words)`);
console.log(`  Voice B confidence: ${scores.B ?? 'n/a'}  (${wordCount(responses.B)} words)`);
console.log(`  Voice C confidence: ${scores.C}  (${wordCount(COPILOT_ANSWER)} words)`);

const vals      = Object.values(scores).filter(Boolean);
const maxConf   = Math.max(...vals);
const minConf   = Math.min(...vals);
const delta     = maxConf - minConf;
const diverged  = delta >= 3;
console.log(`  max_delta:          ${delta}`);
console.log(`  diverged:           ${diverged}`);

// Thematic alignment check
const themes = {
  safety:          /safe|harm|well.being|human.well|safety/i,
  transparency:    /transparen|explainab|legib|audit|inspect|trace/i,
  accountability:  /accountab|responsib|oversight/i,
};
console.log(`\n  Thematic overlap:`);
for (const [theme, re] of Object.entries(themes)) {
  const hits = Object.entries(responses).filter(([,v]) => v && re.test(v)).map(([k]) => k);
  if (hits.length) console.log(`    ${theme.padEnd(16)} → voices: ${hits.join(', ')}`);
}

// ── Log twin_flame_evals for A and B ─────────────────────────────────────────
if (scores.A || scores.B) {
  console.log('\n─── Logging twin_flame_evals (A + B) ────────────────────────');
  const evals = await Promise.allSettled([
    scores.A ? sseCall(4111, 'twin_flame_eval', {
      confidence:        scores.A,
      response_summary:  `triad: governance question (${wordCount(responses.A)} words)`,
      model:             MODEL_A,
      prompt:            QUESTION,
      branch:            'triad_session',
      tags:              ['triad'],
    }) : Promise.resolve(null),
    scores.B ? sseCall(4112, 'twin_flame_eval', {
      confidence:        scores.B,
      response_summary:  `triad: governance question (${wordCount(responses.B)} words)`,
      model:             MODEL_B,
      prompt:            QUESTION,
      branch:            'triad_session',
      tags:              ['triad'],
    }) : Promise.resolve(null),
  ]);
  for (const [port, ev] of [[4111, evals[0]], [4112, evals[1]]]) {
    if (ev.status === 'fulfilled' && ev.value) {
      const r = parseResult(ev.value);
      const eid = (r.entry_id ?? r.id ?? '?').replace(/\.\.\.$/, '').slice(0, 16);
      console.log(`  Port ${port}: eval logged, entry_id=${eid}, confidence=${r.confidence ?? '?'}`);
    }
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' Done.');
console.log('═══════════════════════════════════════════════════════════');
