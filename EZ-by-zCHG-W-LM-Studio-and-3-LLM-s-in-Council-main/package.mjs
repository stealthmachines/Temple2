#!/usr/bin/env node
/**
 * package.mjs — build OS-specific distribution zips for Easy by zCHG.org
 *
 * Produces:
 *   dist/easy-zchg-win.zip     Windows (INSTALL.bat + all sources)
 *   dist/easy-zchg-mac.zip     macOS   (install.sh + all sources)
 *   dist/easy-zchg-linux.zip   Linux   (install.sh + all sources)
 *
 * Run:
 *   node package.mjs             — build all three
 *   node package.mjs --win       — only Windows zip
 *   node package.mjs --mac       — only macOS zip
 *   node package.mjs --linux     — only Linux zip
 *   node package.mjs --clean     — delete dist/ and exit
 */

import { execSync }                           from 'node:child_process';
import { existsSync, mkdirSync, rmSync,
         readdirSync, statSync, copyFileSync,
         writeFileSync }                       from 'node:fs';
import path                                   from 'node:path';
import { fileURLToPath }                      from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv      = process.argv.slice(2);
const IS_WIN    = process.platform === 'win32';

const TTY = process.stdout.isTTY;
const c = {
  reset:  TTY ? '\x1b[0m'  : '', bold:   TTY ? '\x1b[1m'  : '',
  green:  TTY ? '\x1b[32m' : '', cyan:   TTY ? '\x1b[36m' : '',
  yellow: TTY ? '\x1b[33m' : '', gray:   TTY ? '\x1b[90m' : '',
};

const ok   = (msg) => console.log(`${c.green}  ✓${c.reset}  ${msg}`);
const info = (msg) => console.log(`${c.cyan}  →${c.reset}  ${msg}`);
const head = (msg) => console.log(`\n${c.bold}${msg}${c.reset}`);

// ── What to include / exclude ─────────────────────────────────────────────────
// Relative paths from the project root. Directories are included recursively
// unless they appear in EXCLUDE_DIRS.

// Source files always included in every platform ZIP.
// No large binaries — the installer downloads LM Studio and the model.
const ALWAYS_INCLUDE = [
  'server.js',
  'server-dos.js',
  'coord-proxy.js',
  'start-server.js',
  'launch.mjs',
  'install.mjs',
  'analog-container.mjs',
  'tools_erl.js',
  'tools_cleanup.js',
  'chat.html',
  'package.json',
  'package-lock.json',
  'mcp.json',
  'README.md',
  'LICENSE',
  'SYSTEM_CONTEXT.md',
  'SYSTEM_PROMPT.md',
  'context_clearing_protocol.md',
  '.gitignore',
  '.gitmodules',
  '_ask.mjs',
  '_council.mjs',
];

// Directories included recursively
const ALWAYS_DIRS = ['notes', 'wuwei-routing'];

// Platform-specific launchers
const PLATFORM_FILES = {
  win:   ['INSTALL.bat', 'install-bootstrap.ps1', 'start.bat'],
  mac:   ['install.sh', 'start.sh'],
  linux: ['install.sh', 'start.sh'],
};

// Directories to exclude from recursive copies
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'Write-Host',
  'analog-container',  // contains the cloned AnalogContainer1 source — large
]);

// Files to exclude from recursive copies
const EXCLUDE_FILES = new Set([
  '$null',
  'package.mjs',
  'erl-ledger.json',          // runtime state — auto-created by coord-proxy
  'erl-ledger.json.lock',
  'mcp-data.db',              // runtime SQLite
  'mcp-audit.log',
  'SYSTEM_CONTEXT.json',      // runtime — generated at server start
  '_question.txt',
  '_synthesis.txt',
  '_probe.mjs',               // dev-only
  '_triad_demo.mjs',
  '_twin_demo.mjs',
  'find-keys.mjs',
  'start-all.ps1',
]);

// ── Staging helpers ───────────────────────────────────────────────────────────

function copyTree(src, dest) {
  if (!existsSync(src)) return;
  if (statSync(src).isFile()) {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (EXCLUDE_DIRS.has(entry) || EXCLUDE_FILES.has(entry)) continue;
    copyTree(path.join(src, entry), path.join(dest, entry));
  }
}

function buildStaging(platform, stagingDir) {
  mkdirSync(stagingDir, { recursive: true });

  // Always-include flat files
  for (const file of ALWAYS_INCLUDE) {
    const src = path.join(__dirname, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(stagingDir, file));
    }
  }

  // Always-include dirs
  for (const dir of ALWAYS_DIRS) {
    copyTree(path.join(__dirname, dir), path.join(stagingDir, dir));
  }

  // Platform launchers
  for (const file of PLATFORM_FILES[platform] ?? []) {
    const src = path.join(__dirname, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(stagingDir, file));
    }
  }

  // Write a PLATFORM.txt so users know which zip they have
  writeFileSync(
    path.join(stagingDir, 'PLATFORM.txt'),
    `Easy by zCHG.org — ${platform} distribution\n` +
    `Built: ${new Date().toISOString()}\n` +
    `\nTo install: see README.md\n`
  );
}

// ── Zip builders ──────────────────────────────────────────────────────────────

function zipWithPowerShell(stagingDir, outZip) {
  // PowerShell Compress-Archive — available on Windows 10/11 and Server 2019+
  const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${outZip}' -Force"`;
  execSync(cmd, { stdio: 'inherit' });
}

function zipWithZipCmd(stagingDir, outZip) {
  // zip command — available on macOS and most Linux distros
  execSync(`zip -r "${outZip}" .`, { cwd: stagingDir, stdio: 'inherit' });
}

function zipWithPython(stagingDir, outZip) {
  // Python 3 fallback — available almost everywhere
  const py = `
import zipfile, os, sys
staging = sys.argv[1]
out     = sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(staging):
        for file in files:
            fp = os.path.join(root, file)
            zf.write(fp, os.path.relpath(fp, staging))
print("  zip written:", out)
`;
  const pyScript = path.join(__dirname, 'dist', '_pack_tmp.py');
  writeFileSync(pyScript, py);
  try {
    execSync(`python3 "${pyScript}" "${stagingDir}" "${outZip}"`, { stdio: 'inherit' });
  } catch {
    execSync(`python "${pyScript}" "${stagingDir}" "${outZip}"`, { stdio: 'inherit' });
  } finally {
    try { rmSync(pyScript); } catch {}
  }
}

function createZip(stagingDir, outZip) {
  if (IS_WIN) {
    try {
      zipWithPowerShell(stagingDir, outZip);
      return;
    } catch {
      info('PowerShell Compress-Archive failed, trying Python fallback...');
    }
  } else {
    // macOS / Linux — try zip first
    try {
      execSync('which zip', { stdio: 'ignore' });
      zipWithZipCmd(stagingDir, outZip);
      return;
    } catch {
      info('zip not found, trying Python fallback...');
    }
  }
  zipWithPython(stagingDir, outZip);
}

// ── Build a single platform package ──────────────────────────────────────────

async function buildPlatform(platform) {
  head(`Building ${platform} package...`);
  const distDir    = path.join(__dirname, 'dist');
  const stagingDir = path.join(distDir, `easy-zchg-${platform}-staging`);
  const outZip     = path.join(distDir, `easy-zchg-${platform}.zip`);

  mkdirSync(distDir, { recursive: true });

  // Clean stale staging
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });

  info(`Staging files → ${path.relative(__dirname, stagingDir)}`);
  buildStaging(platform, stagingDir);

  info(`Compressing → ${path.relative(__dirname, outZip)}`);
  if (existsSync(outZip)) rmSync(outZip);
  createZip(stagingDir, outZip);

  // Clean up staging dir
  rmSync(stagingDir, { recursive: true, force: true });

  const sizeKB = Math.round(statSync(outZip).size / 1024);
  ok(`dist/easy-zchg-${platform}.zip  (${sizeKB} KB)`);
  return outZip;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (argv.includes('--clean')) {
  const distDir = path.join(__dirname, 'dist');
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true });
    console.log('  dist/ removed.');
  } else {
    console.log('  dist/ not found — nothing to clean.');
  }
  process.exit(0);
}

console.log(`\n${c.bold}${c.cyan}Easy by zCHG.org${c.reset} — distribution packager\n`);

const targets = [];
if (argv.includes('--win'))   targets.push('win');
if (argv.includes('--mac'))   targets.push('mac');
if (argv.includes('--linux')) targets.push('linux');
if (targets.length === 0)     targets.push('win', 'mac', 'linux');

const results = [];
for (const platform of targets) {
  const zip = await buildPlatform(platform);
  results.push(zip);
}

console.log(`\n${c.bold}Done.${c.reset}  ${results.length} package(s) in ${c.cyan}dist/${c.reset}\n`);
for (const zip of results) {
  const rel = path.relative(__dirname, zip);
  console.log(`  ${c.gray}→${c.reset}  ${rel}  (${Math.round(statSync(zip).size / 1024)} KB)`);
}
console.log();
