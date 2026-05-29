import http from 'node:http';
import fs from 'node:fs';

const [,, slot, ...words] = process.argv;
const model = slot === '2' ? 'qwen3.5-9b@q2_k_xl:2' : 'qwen3.5-9b@q2_k_xl';
// If first word argument is --file, read from file
let question;
if (words[0] === '--file' && words[1]) {
  question = fs.readFileSync(words[1], 'utf8').trim();
} else {
  question = words.join(' ') || '/no_think Say hello.';
}

const body = JSON.stringify({
  model,
  messages: [{ role: 'user', content: question }],
  temperature: 1,
  max_tokens: 700,
  stream: false,
});

const opts = {
  host: 'localhost', port: 1234,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
};

const req = http.request(opts, res => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      const j = JSON.parse(raw);
      const content = j.choices?.[0]?.message?.content ?? '(empty)';
      // strip think tags
      const clean = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      console.log(`\n=== SLOT ${slot ?? '1'} (${model}) ===\n`);
      console.log(clean);
    } catch (e) {
      console.log('RAW:', raw.slice(0, 3000));
    }
  });
});

req.setTimeout(150_000, () => { console.error('TIMEOUT'); req.destroy(); });
req.on('error', e => { console.error('ERROR:', e.message); process.exit(1); });
req.write(body);
req.end();
