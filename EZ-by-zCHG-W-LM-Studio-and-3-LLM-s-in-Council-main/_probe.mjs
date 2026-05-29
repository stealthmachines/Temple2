/**
 * Live MCP tool caller — SSE transport handshake + tool invocation
 * Calls phi_route on both servers, logs result to ERL via twin_flame_eval.
 */
import http from 'http';

function sseCall(port, toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    let sessionUrl  = null;
    let posted      = false;
    let sseBuf      = '';
    const msgId     = 1;

    const req = http.get(`http://127.0.0.1:${port}/sse`, (res) => {
      res.on('data', chunk => {
        sseBuf += chunk.toString();
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop();

        for (const line of lines) {
          // Endpoint announcement — fire the POST once
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
                  // 202 = response will arrive on SSE stream; non-202 = error body
                  if (postRes.statusCode !== 202) {
                    req.destroy();
                    resolve({ port, status: postRes.statusCode, body: r });
                  }
                  // else: wait for SSE message event below
                });
              });
              postReq.on('error', reject);
              postReq.write(body);
              postReq.end();
            }
          }

          // JSON-RPC response arrives as an SSE "message" event
          if (posted && line.startsWith('data:')) {
            const data = line.slice(5).trim();
            try {
              const json = JSON.parse(data);
              if (json.id === msgId && (json.result !== undefined || json.error !== undefined)) {
                req.destroy();
                resolve({ port, status: 200, body: data });
              }
            } catch { /* not our message yet */ }
          }
        }
      });

      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error(`timeout port ${port}`)); }, 8000);
  });
}

// ── Test 1: phi_route on both ports ─────────────────────────────────────────
const prompt = 'Can you compare your context to your peer server?';
console.log(`\nPrompt: "${prompt}"\n`);

const [r4111, r4112] = await Promise.all([
  sseCall(4111, 'phi_route', { prompt }),
  sseCall(4112, 'phi_route', { prompt }),
]);

for (const r of [r4111, r4112]) {
  try {
    const parsed = JSON.parse(r.body);
    const content = parsed?.result?.content?.[0]?.text;
    const result  = content ? JSON.parse(content) : r.body;
    console.log(`Port ${r.port} → phi_route:`, JSON.stringify(result, null, 2));
  } catch {
    console.log(`Port ${r.port} → raw:`, r.body.slice(0, 300));
  }
}

// ── Test 2: twin_flame_eval on both ports ────────────────────────────────────
console.log('\n── twin_flame_eval logging ─────────────────────────────────────');
const [e4111, e4112] = await Promise.all([
  sseCall(4111, 'twin_flame_eval', { confidence: 8, response_summary: 'Probe from _probe.mjs', would_do_differently: 'n/a', model: 'copilot' }),
  sseCall(4112, 'twin_flame_eval', { confidence: 8, response_summary: 'Probe from _probe.mjs', would_do_differently: 'n/a', model: 'copilot' }),
]);

for (const r of [e4111, e4112]) {
  try {
    const parsed = JSON.parse(r.body);
    const content = parsed?.result?.content?.[0]?.text;
    const result  = content ? JSON.parse(content) : r.body;
    console.log(`Port ${r.port} → twin_flame_eval:`, JSON.stringify(result));
  } catch {
    console.log(`Port ${r.port} → raw:`, r.body.slice(0, 300));
  }
}

// ── Test 3: twin_flame_divergence (reads eval logs from both ports) ───────────
console.log('\n── twin_flame_divergence ───────────────────────────────────────');
const div = await sseCall(4111, 'twin_flame_divergence', {});
try {
  const parsed = JSON.parse(div.body);
  const content = parsed?.result?.content?.[0]?.text;
  const result  = content ? JSON.parse(content) : div.body;
  console.log('divergence:', JSON.stringify(result, null, 2));
} catch {
  console.log('raw:', div.body.slice(0, 400));
}

// ── Test 4: llm_query — same prompt through both ports ───────────────────────
console.log('\n── llm_query twin-flame demo ───────────────────────────────────');
const llmPrompt = 'In one sentence, what is the golden ratio?';
// model field omitted → LM Studio uses whatever is currently loaded
// To target a specific model: { prompt: llmPrompt, model: 'qwen3-4b', max_tokens: 80 }
const [lq4111, lq4112] = await Promise.allSettled([
  sseCall(4111, 'llm_query', { prompt: llmPrompt, max_tokens: 80, log: true }),
  sseCall(4112, 'llm_query', { prompt: llmPrompt, max_tokens: 80, log: true }),
]);

for (const [port, res] of [[4111, lq4111], [4112, lq4112]]) {
  if (res.status === 'rejected') {
    console.log(`Port ${port} → llm_query error:`, res.reason?.message);
    continue;
  }
  try {
    const parsed  = JSON.parse(res.value.body);
    const content = parsed?.result?.content?.[0]?.text;
    const result  = content ? JSON.parse(content) : res.value.body;
    if (result.error) {
      console.log(`Port ${port} → llm_query (LM Studio offline): ${result.error}`);
    } else {
      console.log(`Port ${port} → llm_query response: "${result.response?.slice(0, 120)}"`);
      console.log(`  logged_to_erl: ${result.logged_to_erl}, lm_port: ${result.lm_port}`);
    }
  } catch {
    console.log(`Port ${port} → raw:`, res.value.body?.slice(0, 300));
  }
}

// If both llm_query calls succeeded, run divergence to see if answers differed
console.log('\n── divergence after llm_query ──────────────────────────────────');
const div2 = await sseCall(4111, 'twin_flame_divergence', { query: 'llm_query' });
try {
  const parsed  = JSON.parse(div2.body);
  const content = parsed?.result?.content?.[0]?.text;
  const result  = content ? JSON.parse(content) : div2.body;
  console.log(`diverged: ${result.diverged}, delta: ${result.confidence_delta}`);
  if (result.query_results?.length) {
    console.log(`query_results (llm_query entries): ${result.query_results.length}`);
    result.query_results.slice(0, 2).forEach(r =>
      console.log('  ', r.timestamp, r.content_preview.slice(0, 80))
    );
  }
} catch {
  console.log('raw:', div2.body.slice(0, 300));
}

console.log('\nDone.');
