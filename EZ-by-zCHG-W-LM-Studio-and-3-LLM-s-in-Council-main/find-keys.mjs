import { readFileSync } from 'fs';
const text = readFileSync('C:/Program Files/LM Studio/resources/app/.webpack/main/index.js', 'utf8');

// Find how @local:inference1 or preset identifier is resolved and applied to loaded model
// Look for the apply/merge logic for preset on model load
for (const term of ['@local:', 'applyPreset', 'resolvePreset', 'applyConfigPreset', 'mergePreset', 'presetIdentifier']) {
  const rx = new RegExp(term.replace(':', '\\:'), 'g');
  let m, count = 0;
  while ((m = rx.exec(text)) !== null && count < 3) {
    console.log(`\n=== "${term}" at ${m.index} ===`);
    console.log(JSON.stringify(text.slice(m.index-100, m.index+300)));
    count++;
  }
}

// Also look for where preset string is used near 'load' in the load pipeline
const preset_rx = /getPreset|fetchPreset|loadPreset|preset.*load|load.*preset/gi;
let m2, c2 = 0;
while ((m2 = preset_rx.exec(text)) !== null && c2 < 10) {
  console.log(`\n=== "${m2[0]}" at ${m2.index} ===`);
  console.log(JSON.stringify(text.slice(m2.index-80, m2.index+200)));
  c2++;
}
