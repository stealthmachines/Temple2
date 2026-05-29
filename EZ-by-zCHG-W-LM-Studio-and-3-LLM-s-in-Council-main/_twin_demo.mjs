/**
 * Twin-flame LLM demo — dual-instance divergence comparison
 *
 * Strategy:
 *   Port 4111 → qwen3.5-9b@q2_k_xl:2  (instance 2)
 *   Port 4112 → qwen3.5-9b@q2_k_xl    (instance 1, fresh after reboot)
 *   Same architecture, same weights, independent sampling — stochastic divergence
 *   Log both responses to ERL, run twin_flame_divergence
 */
import http from 'http';

function sseCall(port, toolName, toolArgs, timeoutMs = 45000) {
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

// ─────────────────────────────────────────────────────────────────────────────
const QUESTION = 'If you had to choose one principle that should govern all AI systems, what would it be and why? Answer in 3 sentences.';

console.log('═══════════════════════════════════════════════════════════');
console.log(' Twin-Flame LLM Demo');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Question: "${QUESTION}"\n`);

// Models confirmed hot by user — skip probing to avoid evictions
const hot = [
  { model: 'qwen3.5-9b@q3_k_xl:2', ms: 0 },  // instance 2 (persistent)
  { model: 'qwen3.5-9b@q3_k_xl',   ms: 0 },  // instance 1 (reboot target)
];
console.log(`Using confirmed-hot models:`);
for (const m of hot) console.log(`  ✓ ${m.model}`);

if (hot.length === 0) {
  console.log('No models ready — LM Studio may still be loading. Try again in 30s.');
  process.exit(0);
}

let modelA, modelB, tempA, tempB, modeNote;
if (hot.length >= 2) {
  modelA = hot[0].model; tempA = 0.7;
  modelB = hot[1].model; tempB = 0.7;
  modeNote = 'Same model, two instances — stochastic/sampling divergence';
} else {
  modelA = hot[0].model; tempA = 0.3;
  modelB = hot[0].model; tempB = 0.9;
  modeNote = `Single model (${hot[0].model}) — split-personality: temp ${tempA} vs ${tempB}`;
}

console.log(`Mode: ${modeNote}`);
console.log(`Port 4111 → ${modelA} (temp ${tempA})`);
console.log(`Port 4112 → ${modelB} (temp ${tempB})`);
console.log('Querying both in parallel (45s timeout each)...\n');

const [ra, rb] = await Promise.allSettled([
  sseCall(4111, 'llm_query', { prompt: QUESTION, model: modelA, max_tokens: 200, temperature: tempA, log: true }),
  sseCall(4112, 'llm_query', { prompt: QUESTION, model: modelB, max_tokens: 200, temperature: tempB, log: true }),
]);

let confA = null, confB = null;
let wordCount_a_val = 0;

for (const [label, model, temp, settled] of [
  ['4111', modelA, tempA, ra],
  ['4112', modelB, tempB, rb],
]) {
  console.log(`─── Port ${label} (${model}, temp ${temp}) ${'─'.repeat(Math.max(0,44-model.length))}`);
  if (settled.status === 'rejected') {
    console.log(`  ERROR: ${settled.reason?.message}\n`);
    continue;
  }
  const result = parseResult(settled.value);
  if (result.error) {
    console.log(`  LM Studio error: ${JSON.stringify(result.error).slice(0, 200)}\n`);
    continue;
  }
  console.log(`  ${result.response?.replace(/\n/g, '\n  ')}`);
  console.log(`  [logged_to_erl: ${result.logged_to_erl}, prompt_hash: ${result.prompt_hash}]\n`);

  const wordCount = result.response?.split(/\s+/).length ?? 0;
  const conf = Math.min(10, Math.max(4, Math.round(wordCount / 8)));
  if (label === '4111') { confA = conf; wordCount_a_val = wordCount; }
  else confB = conf;
}

// ── Log twin_flame_evals so divergence has data ───────────────────────────────
if (confA !== null || confB !== null) {
  console.log('─── Logging twin_flame_evals ────────────────────────────────');
  const evals = await Promise.allSettled([
    confA !== null ? sseCall(4111, 'twin_flame_eval', {
      confidence: confA,
      response_summary: `llm_query answer to governance question (${wordCount_a_val} words)`,
      model: modelA,
      prompt: QUESTION,
    }) : Promise.resolve(null),
    confB !== null ? sseCall(4112, 'twin_flame_eval', {
      confidence: confB,
      response_summary: `llm_query answer to governance question`,
      model: modelB,
      prompt: QUESTION,
    }) : Promise.resolve(null),
  ]);
  for (const [port, ev] of [[4111, evals[0]], [4112, evals[1]]]) {
    if (ev.status === 'fulfilled' && ev.value) {
      const r = parseResult(ev.value);
      console.log(`  Port ${port}: eval logged, entry_id=${r.entry_id ?? r.id ?? '?'}, confidence=${r.confidence ?? '?'}`);
    }
  }
  console.log();
}

// ── Divergence check ──────────────────────────────────────────────────────────
console.log('─── twin_flame_divergence ───────────────────────────────────');
const div = await sseCall(4111, 'twin_flame_divergence', { query: 'llm_query' });
const dr  = parseResult(div);

console.log(`  diverged:         ${dr.diverged}`);
console.log(`  confidence_delta: ${dr.confidence_delta ?? 'n/a'}`);
console.log(`  port_3333 evals:  ${dr.port_3333?.eval_count ?? '?'} (avg conf: ${dr.port_3333?.avg_confidence ?? '?'})`);
console.log(`  port_3334 evals:  ${dr.port_3334?.eval_count ?? '?'} (avg conf: ${dr.port_3334?.avg_confidence ?? '?'})`);
console.log(`  note:             ${dr.divergence_note}`);
if (dr.query_results?.length) {
  console.log(`\n  ERL query_results (llm_query entries, newest first):`);
  for (const qr of dr.query_results.slice(0, 4)) {
    console.log(`    [${qr.timestamp}] ${qr.content_preview.slice(0, 100)}`);
  }
}
console.log('\n═══════════════════════════════════════════════════════════');
console.log(' Done.');
console.log('═══════════════════════════════════════════════════════════');
