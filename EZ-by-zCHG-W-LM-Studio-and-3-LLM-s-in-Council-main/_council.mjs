#!/usr/bin/env node
/**
 * _council.mjs — consult both model slots about the inference preset problem
 * Usage: node _council.mjs
 */
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';

const API = 'http://localhost:1234/v1/chat/completions';

// Read the actual on-disk files so the models have full context
const cfgPath = path.join(os.homedir(), '.lmstudio', '.internal',
  'user-concrete-model-default-config', 'unsloth', 'Qwen3.5-9B-GGUF',
  'Qwen3.5-9B-UD-Q2_K_XL.gguf.json');
const presetPath = path.join(os.homedir(), '.lmstudio', 'config-presets', 'inference1.preset.json');

const modelCfg  = readFileSync(cfgPath, 'utf8');
const presetCfg = readFileSync(presetPath, 'utf8');

const SYSTEM = `You are an expert reverse-engineer of LM Studio 0.4.12 internals.
You have deep knowledge of how LM Studio stores and applies model configuration.
Be concise and specific. Focus on mechanisms, file paths, and actionable fixes.`;

const QUESTION = `
PROBLEM: We need an inference preset to apply reliably every time a model loads via the CLI command:
  lms load qwen3.5-9b -y --identifier qwen3.5-9b@q2_k_xl

WHAT WE KNOW:
- load.fields (contextLength=200000, flashAttention=true, K/V cache q4_0, offloadRatio=32) DO apply correctly — confirmed by llama.cpp server logs showing the right values.
- operation.fields in the model default config do NOT visibly apply in the LM Studio UI after CLI load. The model shows default temperature etc, not our values.
- The "preset" string in model default config appears to be only a UI hint.

MODEL DEFAULT CONFIG (current on-disk):
${modelCfg}

PRESET FILE:
${presetCfg}

QUESTIONS:
1. Is there a fundamental architectural reason why operation.fields in model default config are ignored at CLI load time but load.fields work?
2. Does LM Studio use a different path to apply operation settings to a running instance (e.g., a WebSocket RPC call, a separate in-memory store, a different JSON file)?
3. Is there any way — config file, CLI flag, API call, or file write — to force the inference parameters onto a running loaded instance?
4. Would writing the parameters directly in any OTHER file path make them stick?

Think step by step. Be specific.`;

async function ask(slot, label) {
  const c = '\x1b[' + (slot === 1 ? '36' : '33') + 'm'; // cyan / yellow
  const r = '\x1b[0m';
  console.log(`\n${c}${'═'.repeat(60)}${r}`);
  console.log(`${c}  CONSULTING ${label} (${slot === 1 ? 'qwen3.5-9b@q2_k_xl' : 'qwen3.5-9b@q2_k_xl:2'})${r}`);
  console.log(`${c}${'═'.repeat(60)}${r}\n`);

  const model = slot === 1 ? 'qwen3.5-9b@q2_k_xl' : 'qwen3.5-9b@q2_k_xl:2';
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: QUESTION },
    ],
    temperature: 1,
    top_p: 0.95,
    top_k: 20,
    max_tokens: 800,
    stream: false,
  });

  const resp = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${await resp.text()}`);
    return null;
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content ?? '(no content)';
  console.log(text);
  return text;
}

console.log('\x1b[32m╔══════════════════════════════════════════════════════════╗\x1b[0m');
console.log('\x1b[32m║  COUNCIL SESSION — inference1 preset auto-load problem   ║\x1b[0m');
console.log('\x1b[32m╚══════════════════════════════════════════════════════════╝\x1b[0m');

const [r1, r2] = await Promise.all([
  ask(1, 'SLOT-1 (primary)'),
  ask(2, 'SLOT-2 (peer)'),
]);

// Synthesis round: show each model the other's answer
if (r1 && r2) {
  console.log('\n\x1b[35m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[35m  SYNTHESIS — asking slot 1 to evaluate slot 2\'s answer\x1b[0m');
  console.log('\x1b[35m' + '═'.repeat(60) + '\x1b[0m\n');

  const synthBody = JSON.stringify({
    model: 'qwen3.5-9b@q2_k_xl',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: QUESTION },
      { role: 'assistant', content: r1 },
      { role: 'user', content: `Another instance gave this answer:\n\n${r2}\n\nConsidering both answers, what is the single most actionable fix we should try? Be specific — which file, which key, which call.` },
    ],
    temperature: 0.7,
    max_tokens: 400,
    stream: false,
  });

  const synthResp = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: synthBody,
    signal: AbortSignal.timeout(90_000),
  });
  const synthData = await synthResp.json();
  console.log(synthData.choices?.[0]?.message?.content ?? '(no synthesis)');
}

console.log('\n\x1b[32m══ Council session complete ══\x1b[0m\n');
