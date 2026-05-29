#!/usr/bin/env node
/**
 * install.mjs — zero-to-running installer for Easy by zCHG.org
 *
 * What this does, in order:
 *   1. Checks Node.js ≥ 18 (the only hard prerequisite — this file needs node to run)
 *   2. Runs npm install
 *   3. Detects / installs LM Studio (Windows: silent NSIS installer; macOS: DMG mount + cp; Linux: AppImage)
 *   4. Downloads the GGUF model file directly into the LM Studio models folder
 *   5. Imports the GGUF into LM Studio via `lms import`
 *   6. Starts the LM Studio server via `lms server start`
 *   7. Loads the model via `lms load`
 *   8. Launches the MCP stack via launch.mjs
 *
 * Run:
 *   node install.mjs            — full install + launch
 *   node install.mjs --no-launch  — install only, don't start the stack
 *   node install.mjs --skip-model — skip model download (if you already have one)
 *   node install.mjs --status     — just show current state
 */

import { execSync, spawnSync, spawn } from 'child_process';
import { existsSync, mkdirSync, createWriteStream, readdirSync, statSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { get as httpsGet } from 'https';
import { get as httpGet } from 'http';
import path from 'path';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Node.js version guard ─────────────────────────────────────────────────────
const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 18) {
  process.stderr.write(
    `\n[install] ERROR: Node.js >= 18 is required (found v${process.versions.node}).\n` +
    `          Download the LTS version from: https://nodejs.org\n` +
    `          Then re-run: node install.mjs\n\n`
  );
  process.exit(1);
}

// ── ANSI colours ──────────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY;
const c = {
  reset:  TTY ? '\x1b[0m'  : '', bold:   TTY ? '\x1b[1m'  : '',
  red:    TTY ? '\x1b[31m' : '', green:  TTY ? '\x1b[32m' : '',
  yellow: TTY ? '\x1b[33m' : '', cyan:   TTY ? '\x1b[36m' : '',
  gray:   TTY ? '\x1b[90m' : '',
};
const ok   = (msg) => console.log(`${c.green}  ✓${c.reset}  ${msg}`);
const info = (msg) => console.log(`${c.cyan}  →${c.reset}  ${msg}`);
const warn = (msg) => console.log(`${c.yellow}  ⚠${c.reset}  ${msg}`);
const fail = (msg) => { console.error(`${c.red}  ✗${c.reset}  ${msg}`); };
const head = (msg) => console.log(`\n${c.bold}${msg}${c.reset}`);

// ── CLI flags ─────────────────────────────────────────────────────────────────
const argv       = process.argv.slice(2);
const NO_LAUNCH  = argv.includes('--no-launch');
const SKIP_MODEL = argv.includes('--skip-model');
const STATUS     = argv.includes('--status');
const HELP       = argv.includes('--help') || argv.includes('-h');

if (HELP) {
  console.log(`
  ${c.bold}install.mjs${c.reset} — zero-to-running installer

  ${c.cyan}node install.mjs${c.reset}               full install + start MCP stack
  ${c.cyan}node install.mjs --no-launch${c.reset}   install only, don't start the stack
  ${c.cyan}node install.mjs --skip-model${c.reset}  skip GGUF download (model already present)
  ${c.cyan}node install.mjs --status${c.reset}      show current install state and exit
  `);
  process.exit(0);
}

// ── Platform detection ────────────────────────────────────────────────────────
const IS_WIN   = process.platform === 'win32';
const IS_MAC   = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const HOME     = os.homedir();

// ── LM Studio paths (per-platform) ───────────────────────────────────────────
// lms CLI tool — bundled inside the LM Studio data dir as bin/lms (or lms.exe)
const LMS_DATA = IS_WIN
  ? path.join(HOME, '.lmstudio')
  : IS_MAC
    ? path.join(HOME, '.lmstudio')
    : path.join(HOME, '.lmstudio');

const LMS_BIN = IS_WIN
  ? path.join(LMS_DATA, 'bin', 'lms.exe')
  : path.join(LMS_DATA, 'bin', 'lms');

const LMS_MODELS_DIR = path.join(LMS_DATA, 'models');

// LM Studio app download URLs (official releases)
const LMS_DOWNLOAD = {
  win32:  'https://releases.lmstudio.ai/win32/x64/latest/LM-Studio-Setup.exe',
  darwin: 'https://releases.lmstudio.ai/mac/arm64/latest/LM-Studio.dmg',  // Apple Silicon
  linux:  'https://releases.lmstudio.ai/linux/x86_64/latest/LM-Studio.AppImage',
};

// ── Model to download ─────────────────────────────────────────────────────────
// Hugging Face direct GGUF download. ~4.3 GB at Q2_K_XL.
const MODEL_URL      = 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-UD-Q2_K_XL.gguf?download=true';
const MODEL_FILENAME = 'Qwen3.5-9B-UD-Q2_K_XL.gguf';
const MODEL_USER_REPO = 'unsloth/Qwen3.5-9B-GGUF'; // used with `lms import --user-repo`
// The model key lms assigns after import (user/repo/filename without ext → lmstudio key)
const MODEL_KEY      = 'qwen3.5-9b';           // lms ls key after import (no quant suffix)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function lms(...args) {
  if (!existsSync(LMS_BIN)) return { ok: false, out: '', err: 'lms not found' };
  const r = spawnSync(LMS_BIN, args, { encoding: 'utf8', timeout: 30000 });
  return {
    ok:  r.status === 0,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
    status: r.status,
  };
}

function lmsAsync(args, label) {
  return new Promise((resolve) => {
    info(`Running: lms ${args.join(' ')}`);
    const child = spawn(LMS_BIN, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Download a URL to a local file with resume support (Range requests).
 *  If the destination already exists and is smaller than the remote file,
 *  sends a Range: bytes=N- header and appends rather than rewriting.
 *  Transparently follows up to 10 redirects, retries up to 3 times on stall. */
function download(url, destPath, _redirects = 0, _retries = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 10) return reject(new Error('Too many redirects'));
    if (_retries  >  3)  return reject(new Error('Download failed after 3 stall retries'));

    const existing   = existsSync(destPath) ? statSync(destPath).size : 0;
    const reqHeaders = { 'User-Agent': 'Easy-zCHG-Installer/1.0' };
    if (existing > 0) reqHeaders['Range'] = `bytes=${existing}-`;

    let out       = null;
    let idleTimer = null;

    // Retry from current byte offset after a connection stall
    const retryStall = () => {
      clearTimeout(idleTimer);
      if (out) { try { out.destroy(); } catch {} out = null; }
      const saved = existsSync(destPath) ? statSync(destPath).size : 0;
      process.stdout.write(`\n     Stalled at ${(saved / 1e6).toFixed(0)} MB — retrying (${_retries + 1}/3) in 5 s ...\n`);
      setTimeout(() => download(url, destPath, 0, _retries + 1).then(resolve).catch(reject), 5_000);
    };

    const getter = url.startsWith('https') ? httpsGet : httpGet;
    const req = getter(url, { headers: reqHeaders }, (res) => {
      // Follow redirects — carry retry count, reset redirect depth
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, destPath, _redirects + 1, _retries).then(resolve).catch(reject);
      }

      // 416 = Range beyond EOF → file already complete
      if (res.statusCode === 416) {
        res.resume();
        process.stdout.write('\r     (already complete)\n');
        return resolve();
      }

      const resuming  = res.statusCode === 206;
      const totalFull = parseInt(res.headers['content-length'] || '0', 10);

      if (!resuming && res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const startByte  = resuming ? existing : 0;
      const totalBytes = resuming ? existing + totalFull : totalFull;

      let received = startByte;

      mkdirSync(path.dirname(destPath), { recursive: true });
      out = resuming
        ? createWriteStream(destPath, { flags: 'a' })
        : createWriteStream(destPath);

      if (resuming && existing > 0) {
        process.stdout.write(`     Resuming from ${(existing / 1e6).toFixed(1)} MB ...\n`);
      }

      // Idle timeout: 60 s of no data → stall-retry
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(retryStall, 60_000);
      };
      resetIdle();

      res.on('data', (chunk) => {
        resetIdle();
        received += chunk.length;
        if (totalBytes > 0) {
          const pct = ((received / totalBytes) * 100).toFixed(2);
          process.stdout.write(`\r     ${pct}%  (${(received / 1e6).toFixed(3)} / ${(totalBytes / 1e6).toFixed(0)} MB)   `);
        } else {
          process.stdout.write(`\r     ${(received / 1e6).toFixed(3)} MB downloaded...`);
        }
      });

      res.on('error', (err) => { clearTimeout(idleTimer); out.destroy(); reject(err); });
      out.on('error', (err) => { clearTimeout(idleTimer); reject(err); });
      out.on('finish', () => { clearTimeout(idleTimer); process.stdout.write('\n'); resolve(); });
      res.pipe(out);
    });

    req.on('error', (err) => {
      clearTimeout(idleTimer);
      if (out) { try { out.destroy(); } catch {} out = null; }
      const retriable = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND'];
      if (retriable.includes(err.code) && _retries < 3) {
        const saved = existsSync(destPath) ? statSync(destPath).size : 0;
        process.stdout.write(`\n     Network error (${err.code}) at ${(saved / 1e6).toFixed(0)} MB — retrying (${_retries + 1}/3) in 5 s ...\n`);
        setTimeout(() => download(url, destPath, 0, _retries + 1).then(resolve).catch(reject), 5_000);
      } else {
        reject(err);
      }
    });
  });
}

/** Find the first .gguf file in the models dir that matches MODEL_FILENAME */
function findModelInLmsDir() {
  if (!existsSync(LMS_MODELS_DIR)) return null;
  // Walk up to 3 levels deep (user/repo/file.gguf)
  const walk = (dir, depth) => {
    if (depth > 3) return null;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          const found = walk(full, depth + 1);
          if (found) return found;
        } else if (entry === MODEL_FILENAME) {
          return full;
        }
      } catch { /* skip permission errors */ }
    }
    return null;
  };
  return walk(LMS_MODELS_DIR, 0);
}

/** Check if a model key is already registered in LM Studio (imported on disk, not necessarily loaded). */
function modelIsImported(keyFragment) {
  const r = lms('ls');
  return r.ok && r.out.toLowerCase().includes(keyFragment.toLowerCase());
}

/** Query LM Studio HTTP API — reliable regardless of how models were loaded (GUI/CLI/API). */
async function lmsHttpCheck() {
  try {
    const res = await fetch('http://127.0.0.1:1234/v1/models', {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { up: true, models: [] };
    const json = await res.json();
    const models = (json.data ?? []).map(m => m.id ?? m.model ?? String(m));
    return { up: true, models };
  } catch {
    return { up: false, models: [] };
  }
}

/** Check if a model key is loaded — uses HTTP API so GUI-loaded models are visible. */
async function modelIsLoaded(keyFragment) {
  const r = await lmsHttpCheck();
  return r.up && r.models.some(id => id.toLowerCase().includes(keyFragment.toLowerCase()));
}

/** Check if lms server is running — HTTP probe, not lms CLI, to avoid parse brittleness. */
async function serverIsRunning() {
  const r = await lmsHttpCheck();
  return r.up;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS mode
// ─────────────────────────────────────────────────────────────────────────────
if (STATUS) {
  head('── Install status ──────────────────────────────────────');
  console.log(`  Node.js        : ${process.version} ${nodeMajor >= 18 ? c.green+'✓'+c.reset : c.red+'✗ (need ≥ 18)'+c.reset}`);

  const lmsExists = existsSync(LMS_BIN);
  console.log(`  LM Studio (lms): ${lmsExists ? c.green+'✓  '+LMS_BIN+c.reset : c.red+'✗  not found'+c.reset}`);

  if (lmsExists) {
    const srv = serverIsRunning();
    console.log(`  LMS server     : ${srv ? c.green+'✓  running'+c.reset : c.yellow+'✗  stopped'+c.reset}`);
    const ps = lms('ps');
    console.log(`  Loaded models  :\n${ps.out || '    (none)'}`);
    const ls = lms('ls');
    console.log(`  On-disk models :\n${ls.out || '    (none)'}`);
  }

  const nm = existsSync(path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk'));
  console.log(`  npm deps       : ${nm ? c.green+'✓  installed'+c.reset : c.yellow+'✗  run install'+c.reset}`);
  console.log();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — npm install
// ─────────────────────────────────────────────────────────────────────────────
head('Step 1/6 — npm dependencies');
const marker = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'sdk');
if (existsSync(marker)) {
  ok('node_modules already present — skipping npm install');
} else {
  info('Running npm install ...');
  try {
    execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
    ok('npm install complete');
  } catch {
    fail('npm install failed. Fix errors above and re-run.');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1b — AnalogContainer1 execution rail
// ─────────────────────────────────────────────────────────────────────────────
head('Step 1b/6 — AnalogContainer1 execution rail');
try {
  const { setupContainer } = await import('./analog-container.mjs');
  await setupContainer();
  ok('AnalogContainer1 execution rail ready');
} catch (err) {
  warn(`AnalogContainer1 setup: ${err.message}`);
  warn('JS container layer active — no functionality lost.');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — LM Studio installation
// LM Studio GUI app candidates (the actual installed application, not the CLI)
const LMS_APP_CANDIDATES = IS_WIN ? [
  'C:\\Program Files\\LM Studio\\LM Studio.exe',
  'C:\\Program Files (x86)\\LM Studio\\LM Studio.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'LM Studio.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'LM Studio', 'LM Studio.exe'),
] : IS_MAC ? [
  '/Applications/LM Studio.app/Contents/MacOS/LM Studio',
] : [
  path.join(HOME, '.local', 'share', 'applications', 'lm-studio.desktop'),
];
const LMS_APP = LMS_APP_CANDIDATES.find(p => existsSync(p)) || null;

// ─────────────────────────────────────────────────────────────────────────────
head('Step 2/6 \u2014 LM Studio');
// LM Studio install is handled by install-bootstrap.ps1 (Start-Process -Wait)
// before node runs, so both paths should exist here.
if (existsSync(LMS_BIN) && LMS_APP) {
  ok(`LM Studio CLI found: ${LMS_BIN}`);
  ok(`LM Studio app found: ${LMS_APP}`);
} else if (!LMS_APP) {
  // Running install.mjs directly (not via INSTALL.bat) — do the install from here
  if (existsSync(LMS_BIN) && !LMS_APP) warn('lms CLI found but LM Studio app is missing \u2014 reinstalling ...');
  // ── Locate installer: bundled first (alongside install.mjs OR in dist/), then download ──
  const bundledExe = (() => {
    if (!IS_WIN) return null;
    for (const dir of [__dirname, path.join(__dirname, 'dist')]) {
      try {
        const match = readdirSync(dir).find(f => /^LM.?Studio.*\.exe$/i.test(f));
        if (match) return path.join(dir, match);
      } catch {}
    }
    return null;
  })();

  let tmpFile;
  if (bundledExe) {
    info(`Using bundled LM Studio installer: ${path.basename(bundledExe)}`);
    tmpFile = bundledExe;
  } else {
    const downloadUrl = LMS_DOWNLOAD[process.platform];
    if (!downloadUrl) {
      fail(`Unsupported platform: ${process.platform}. Install LM Studio manually from https://lmstudio.ai`);
      process.exit(1);
    }
    const ext = path.extname(new URL(downloadUrl.split('?')[0]).pathname);
    tmpFile = path.join(os.tmpdir(), `LMStudio-installer${ext}`);
    info(`Downloading LM Studio installer (~150 MB) ...`);
    info(`Source: ${downloadUrl}`);
    try {
      await download(downloadUrl, tmpFile);
      ok(`Downloaded: ${tmpFile}`);
    } catch (err) {
      fail(`Download failed: ${err.message}`);
      fail(`Manual install: https://lmstudio.ai`);
      process.exit(1);
    }
  }

  info('Installing LM Studio silently ...');
  try {
    if (IS_WIN) {
      // Use PowerShell Start-Process -Wait so the installer window appears correctly
      // regardless of whether we're running from a BAT → PS → node chain.
      // This also triggers UAC elevation if the installer needs it.
      info('Running LM Studio installer — complete the wizard, then this will continue ...');
      execSync(`powershell -NoProfile -Command "Start-Process '${tmpFile.replace(/'/g, "''")}'  -Wait"`, { stdio: 'inherit', timeout: 300_000 });

      // Find the installed app — check both Program Files and LOCALAPPDATA
      const lmsAppCandidates = [
        'C:\\Program Files\\LM Studio\\LM Studio.exe',
        'C:\\Program Files (x86)\\LM Studio\\LM Studio.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'LM Studio.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'LM Studio', 'LM Studio.exe'),
      ];
      const lmsApp = lmsAppCandidates.find(p => existsSync(p));
      if (lmsApp) {
        info(`Running LM Studio once to initialize CLI tools: ${path.basename(lmsApp)}`);
        info('(Polling for ~/.lmstudio/bin/lms.exe — up to 45 s) ...');
        const proc = spawn(lmsApp, [], { stdio: 'ignore', detached: true, shell: false });
        proc.unref();
        const deadline = Date.now() + 45_000;
        while (!existsSync(LMS_BIN) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1500));
          process.stdout.write('.');
        }
        process.stdout.write('\n');
        // Kill LM Studio — only needed to init ~/.lmstudio
        try { execSync('taskkill /F /IM "LM Studio.exe" /T', { stdio: 'ignore' }); } catch {}
        await new Promise(r => setTimeout(r, 1500)); // let it fully exit
      } else {
        warn('LM Studio installed but executable not found in expected locations.');
        warn('Run LM Studio once manually, then re-run install.');
      }
    } else if (IS_MAC) {
      // Mount DMG, copy .app to /Applications
      execSync(`hdiutil attach "${tmpFile}" -nobrowse -quiet`, { stdio: 'inherit' });
      const mountPoint = execSync(`hdiutil info | grep "LM Studio" | awk '{print $1}'`).toString().trim();
      execSync(`cp -R "/Volumes/LM Studio/LM Studio.app" /Applications/`, { stdio: 'inherit' });
      execSync(`hdiutil detach "${mountPoint}" -quiet`, { stdio: 'inherit' });
      // Run LM Studio once briefly to set up ~/.lmstudio
      info('First-run setup (may take a few seconds) ...');
      execSync(`open -a "LM Studio" && sleep 8 && osascript -e 'quit app "LM Studio"'`, { stdio: 'inherit', timeout: 20_000 });
    } else if (IS_LINUX) {
      execSync(`chmod +x "${tmpFile}"`, { stdio: 'inherit' });
      // AppImage: run once with --appimage-extract-and-run to let it set up
      info('LM Studio AppImage — running first-time setup ...');
      execSync(`"${tmpFile}" --no-sandbox &`, { stdio: 'inherit', timeout: 15_000 });
      await new Promise(r => setTimeout(r, 8000));
    }
  } catch (err) {
    fail(`Silent install failed: ${err.message}`);
    fail(`Please install LM Studio manually: https://lmstudio.ai`);
    fail(`Then re-run: node install.mjs`);
    process.exit(1);
  }

  // Verify both CLI and GUI app are now present
  if (!existsSync(LMS_BIN)) {
    fail('LM Studio was not found after install.');
    fail(`Expected CLI at: ${LMS_BIN}`);
    fail('Possible fixes:');
    fail('  1. Run LM Studio once (it creates ~/.lmstudio on first launch), then re-run INSTALL.bat');
    fail('  2. Or install manually from https://lmstudio.ai and re-run INSTALL.bat');
    process.exit(1);
  }
  ok('LM Studio installed successfully');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2b — Configure LM Studio (MCP servers + system prompt + server settings)
// ─────────────────────────────────────────────────────────────────────────────
head('Step 2b/6 — Configure LM Studio');
{
  const LMS_INTERNAL = path.join(LMS_DATA, '.internal');

  // ── 1. MCP server registration ─────────────────────────────────────────────
  // Write ~/.lmstudio/mcp.json so LM Studio knows about both MCP endpoints.
  const mcpFile = path.join(LMS_DATA, 'mcp.json');
  const wantedMcp = {
    mcpServers: {
        'easy-zchg-primary': { url: 'http://localhost:4111/sse' },
        'easy-zchg-mirror':  { url: 'http://localhost:4112/sse' },
    },
  };
  let mcpChanged = false;
  try {
    const existing = existsSync(mcpFile)
      ? JSON.parse(readFileSync(mcpFile, 'utf8'))
      : { mcpServers: {} };
    const servers = existing.mcpServers || {};
    // Merge: add our entries, don't remove existing ones
    let changed = false;
    for (const [key, val] of Object.entries(wantedMcp.mcpServers)) {
      if (!servers[key] || servers[key].url !== val.url) {
        servers[key] = val;
        changed = true;
      }
    }
    if (changed) {
      existing.mcpServers = servers;
      writeFileSync(mcpFile, JSON.stringify(existing, null, 2), 'utf8');
      mcpChanged = true;
    }
  } catch (e) {
    // Write fresh if parse fails
    writeFileSync(mcpFile, JSON.stringify(wantedMcp, null, 2), 'utf8');
    mcpChanged = true;
  }
  mcpChanged
    ok('LM Studio MCP servers registered (easy-zchg-primary :4111, easy-zchg-mirror :4112)');
    : ok('LM Studio MCP servers already configured');

  // ── 2. Server auto-start + CORS ────────────────────────────────────────────
  const srvCfg = path.join(LMS_INTERNAL, 'http-server-config.json');
  try {
    mkdirSync(LMS_INTERNAL, { recursive: true });
    const cfg = existsSync(srvCfg)
      ? JSON.parse(readFileSync(srvCfg, 'utf8'))
      : {};
    let dirty = false;
    if (!cfg.autoStartOnLaunch) { cfg.autoStartOnLaunch = true;  dirty = true; }
    if (cfg.port !== 1234)       { cfg.port = 1234;               dirty = true; }
    if (!cfg.cors)               { cfg.cors = true;               dirty = true; }
    if (dirty) {
      writeFileSync(srvCfg, JSON.stringify(cfg, null, 2), 'utf8');
      ok('LM Studio server: auto-start enabled, CORS enabled, port 1234');
    } else {
      ok('LM Studio server config already correct');
    }
  } catch (e) {
    warn(`Could not update server config: ${e.message}`);
  }

  // ── 3. Model default config for Q2_K_XL ──────────────────────────────────
  // Writes load + preset settings. System prompt is NOT stored here — it is
  // served by server.js and server-dos.js via the MCP tool calls.
  {
    const modelCfgDir = path.join(LMS_INTERNAL, 'user-concrete-model-default-config', 'unsloth', 'Qwen3.5-9B-GGUF');
    const modelCfgFile = path.join(modelCfgDir, 'Qwen3.5-9B-UD-Q2_K_XL.gguf.json');
    mkdirSync(modelCfgDir, { recursive: true });

    let modelCfg = existsSync(modelCfgFile)
      ? JSON.parse(readFileSync(modelCfgFile, 'utf8'))
      : { preset: '', operation: { fields: [] }, load: { fields: [] } };

    // Set/update operation fields directly — this is the reliable path.
    // The 'preset' string reference in model default config only pre-selects the preset
    // in LM Studio's UI; the actual inference parameters must be in operation.fields to
    // be applied at load time.  System prompt is NOT stored here.
    const opFields = (modelCfg.operation?.fields || []).filter(
      f => f.key !== 'llm.prediction.systemPrompt'  // strip any stale system prompt
    );
    const setOpField = (key, value) => {
      const i = opFields.findIndex(f => f.key === key);
      if (i >= 0) opFields[i].value = value;
      else opFields.push({ key, value });
    };
    setOpField('llm.prediction.temperature',          1);
    setOpField('llm.prediction.llama.cpuThreads',     3);
    setOpField('llm.prediction.topKSampling',         20);
    setOpField('llm.prediction.topPSampling',         0.95);
    setOpField('llm.prediction.repeatPenalty',        { checked: true, value: 1 });
    setOpField('llm.prediction.llama.presencePenalty',{ checked: true, value: 0 });
    setOpField('llm.prediction.minPSampling',         { checked: true, value: 0 });
    modelCfg.operation = { ...modelCfg.operation, fields: opFields };

    // Also wire inference1 as the named preset (for UI display)
    modelCfg.preset = '@local:inference1';

    // Set/update load fields (upsert: replace if exists, push if new)
    const loadFields = (modelCfg.load?.fields || []);
    const setLoadField = (key, value) => {
      const i = loadFields.findIndex(f => f.key === key);
      if (i >= 0) loadFields[i].value = value;
      else loadFields.push({ key, value });
    };
    setLoadField('llm.load.contextLength',                    200000);
    setLoadField('llm.load.llama.acceleration.offloadRatio',  32);     // 32 GPU layers
    setLoadField('llm.load.llama.flashAttention',             true);   // required for K/V cache quant
    // Checkbox-pattern fields: { checked, value } — bare string is ignored by LM Studio
    setLoadField('llm.load.llama.kCacheQuantizationType',     { checked: true, value: 'q4_0' });
    setLoadField('llm.load.llama.vCacheQuantizationType',     { checked: true, value: 'q4_0' });
    modelCfg.load = { ...modelCfg.load, fields: loadFields };

    writeFileSync(modelCfgFile, JSON.stringify(modelCfg, null, 2), 'utf8');
    ok('Load config + preset written to LM Studio model config (Qwen3.5-9B-UD-Q2_K_XL)');
  }

  // ── 4. inference1 preset ──────────────────────────────────────────────────
  // Install the inference1 preset so it appears in LM Studio's preset picker.
  {
    const presetDir  = path.join(LMS_DATA, 'config-presets');
    const presetFile = path.join(presetDir, 'inference1.preset.json');
    mkdirSync(presetDir, { recursive: true });
    const preset = {
      identifier: '@local:inference1',
      name: 'inference1',
      changed: false,
      operation: {
        fields: [
          { key: 'llm.prediction.temperature',          value: 1 },
          { key: 'llm.prediction.llama.cpuThreads',     value: 3 },
          { key: 'llm.prediction.topKSampling',         value: 20 },
          { key: 'llm.prediction.topPSampling',         value: 0.95 },
          { key: 'llm.prediction.repeatPenalty',        value: { checked: true, value: 1 } },
          { key: 'llm.prediction.llama.presencePenalty',value: { checked: true, value: 0 } },
          { key: 'llm.prediction.minPSampling',         value: { checked: true, value: 0 } },
        ],
      },
      load: { fields: [] },
    };
    // Always write — keeps preset in sync with the installer's intended config
    writeFileSync(presetFile, JSON.stringify(preset, null, 2), 'utf8');
    ok('inference1 preset written to LM Studio config-presets');
  }

  // ── 5. Enable MCP plugins + inference1 preset in existing conversations ──────
  // LM Studio stores per-conversation plugin state as an array of identifier
  // strings.  The identifier format (from renderer source) is:
  //   createPluginIdentifier(owner, name, {isDevelopment:false}) → `${owner}/${name}`
  // So our MCP bridge plugins are: 'mcp/easy-zchg-primary' and 'mcp/easy-zchg-mirror'.
  // We also stamp the active preset so inference1 settings apply immediately.
  {
    const wantedPlugins = ['mcp/easy-zchg-primary', 'mcp/easy-zchg-mirror'];
    const wantedPreset  = '@local:inference1';
    const convDir = path.join(LMS_DATA, 'conversations');
    let patchedCount = 0;
    if (existsSync(convDir)) {
      try {
        const convFiles = readdirSync(convDir).filter(f => f.endsWith('.conversation.json'));
        for (const file of convFiles) {
          const filePath = path.join(convDir, file);
          try {
            const conv = JSON.parse(readFileSync(filePath, 'utf8'));
            let changed = false;
            // Plugins
            if (!Array.isArray(conv.plugins)) { conv.plugins = []; }
            const before = conv.plugins.length;
            for (const p of wantedPlugins) {
              if (!conv.plugins.includes(p)) conv.plugins.push(p);
            }
            if (conv.plugins.length !== before) changed = true;
            // Preset
            if (conv.preset !== wantedPreset) { conv.preset = wantedPreset; changed = true; }
            if (changed) {
              writeFileSync(filePath, JSON.stringify(conv, null, 2), 'utf8');
              patchedCount++;
            }
          } catch { /* skip malformed files */ }
        }
      } catch { /* convDir inaccessible */ }
    }
    patchedCount > 0
      ? ok(`MCP plugins + inference1 preset applied to ${patchedCount} existing LM Studio conversation(s)`)
      : ok('Conversations already up-to-date (plugins + preset)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Download the GGUF model
// ─────────────────────────────────────────────────────────────────────────────
head('Step 3/6 — Model download');
if (SKIP_MODEL) {
  info('--skip-model set — skipping download');
} else {
  // Check if the model is already on disk in the LM Studio models folder
  const existing = findModelInLmsDir();
  if (existing) {
    ok(`Model already present: ${existing}`);
  } else {
    // Check for bundled GGUF alongside install.mjs (packed into the zip by package.mjs)
    const bundledGguf = (() => {
      for (const dir of [__dirname, path.join(__dirname, 'models')]) {
        try {
          const match = readdirSync(dir).find(f => f.toLowerCase().endsWith('.gguf'));
          if (match) return path.join(dir, match);
        } catch {}
      }
      return null;
    })();

    const tmpGguf = path.join(os.tmpdir(), MODEL_FILENAME);

    if (bundledGguf) {
      info(`Using bundled model: ${path.basename(bundledGguf)}`);
      // Copy to temp so lms import path is consistent
      if (bundledGguf !== tmpGguf) {
        info('Copying to temp location for import ...');
        copyFileSync(bundledGguf, tmpGguf);
      }
      ok(`Model ready: ${tmpGguf}`);
    } else {
      const inPlace = existsSync(tmpGguf);
      if (inPlace) {
        const partialMB = (statSync(tmpGguf).size / 1e6).toFixed(0);
        info(`Resuming partial download (${partialMB} MB already on disk) ...`);
        info(`Source: ${MODEL_URL.split('?')[0]}`);
      } else {
        info(`Downloading model (this is ~4 GB \u2014 go get a coffee) ...`);
        info(`Source: ${MODEL_URL.split('?')[0]}`);
      }
      try {
        await download(MODEL_URL, tmpGguf);
        ok(`Downloaded: ${tmpGguf}`);
      } catch (err) {
      fail(`Model download failed: ${err.message}`);
      fail(`You can manually download the GGUF from:`);
      fail(`  ${MODEL_URL.split('?')[0]}`);
      fail(`Then import it via:  lms import "<path>" --user-repo "${MODEL_USER_REPO}" -y`);
      process.exit(1);
    }
    } // end download else (bundledGguf not present)

    // ── Step 3b: Import into LM Studio ──────────────────────────────────────
    head('Step 3b/6 — Import model into LM Studio');
    if (modelIsImported('q2_k_xl')) {
      ok('Model already registered in LM Studio — skipping import');
    } else {
      const imported = await lmsAsync(
        ['import', tmpGguf, '--user-repo', MODEL_USER_REPO, '-y', '--copy'],
        'lms import'
      );
      if (imported) {
        ok('Model imported into LM Studio');
      } else {
        // Re-check: lms import may return non-zero when file already exists in Ollama-compat dir.
        if (modelIsImported('q2_k_xl')) {
          ok('Model already registered in LM Studio');
        } else {
          warn('lms import returned non-zero. Run `lms ls` to check if model is registered.');
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Start LM Studio server
// ─────────────────────────────────────────────────────────────────────────────
head('Step 4/6 — LM Studio server');
if (await serverIsRunning()) {
  ok('Server already running on :1234');
} else {
  info('Starting LM Studio server (lms server start) ...');
  const started = await lmsAsync(['server', 'start'], 'lms server start');
  if (started) {
    ok('Server started on :1234');
  } else {
    fail('lms server start failed.');
    fail('Start LM Studio manually, enable the server in Settings → Server, then re-run.');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Load the model
// ─────────────────────────────────────────────────────────────────────────────
head('Step 5/6 — Load model');

// Find the actual model key from lms ls output
function findModelKey() {
  const r = lms('ls');
  if (!r.ok) return null;
  // Look for a line containing the filename or a recognizable part of it
  const lines = r.out.split('\n');
  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.includes('q2_k_xl') || l.includes('qwen3.5-9b-ud-q2') || l.startsWith('qwen3.5-9b')) {
      // Extract first token (the model key)
      const key = line.trim().split(/\s+/)[0];
      if (key && key.length > 3) return key;
    }
  }
  return null;
}

const modelKey = findModelKey() || MODEL_KEY;

// ── context slot 1 ──────────────────────────────────────────────────────────
// Always unload first so updated load settings (K/V cache, flash attn, GPU
// offload) from the model config are picked up on every install run.
if (await modelIsLoaded('q2_k_xl')) {
  info('Unloading slot 1 to apply updated load settings…');
  await lmsAsync(['unload', 'qwen3.5-9b@q2_k_xl'], 'lms unload slot 1');
}
info(`Loading model context slot 1: ${modelKey} → qwen3.5-9b@q2_k_xl`);
info('(This may take 30–90 seconds)');
const loaded = await lmsAsync(
  ['load', modelKey, '-y', '--identifier', 'qwen3.5-9b@q2_k_xl'],
  'lms load'
);
if (loaded) {
  ok(`Model context slot 1 loaded: ${modelKey}`);
} else {
  const confirm = await lmsHttpCheck();
  const alreadyUp = confirm.models.some(id => id.toLowerCase().includes('q2_k_xl'));
  if (alreadyUp) {
    ok(`Context slot 1 in memory (HTTP confirms)`);
  } else {
    warn('lms load returned non-zero. Context slot 1 may still be loading.');
    warn(`Loaded models: ${confirm.models.join(', ') || '(none visible yet)'}`);
  }
}

// ── context slot 2 (dual-context architecture) ──────────────────────────────
if (await modelIsLoaded('q2_k_xl:2')) {
  info('Unloading slot 2 to apply updated load settings…');
  await lmsAsync(['unload', 'qwen3.5-9b@q2_k_xl:2'], 'lms unload slot 2');
}
info(`Loading model context slot 2: ${modelKey} → qwen3.5-9b@q2_k_xl:2`);
const loaded2 = await lmsAsync(
  ['load', modelKey, '-y', '--identifier', 'qwen3.5-9b@q2_k_xl:2'],
  'lms load (slot 2)'
);
if (loaded2) {
  ok(`Model context slot 2 loaded (dual-context architecture)`);
} else {
  const confirm2 = await lmsHttpCheck();
  const slot2Up = confirm2.models.some(id => id.toLowerCase().includes('q2_k_xl:2'));
  if (slot2Up) {
    ok('Context slot 2 in memory (HTTP confirms)');
  } else {
    warn('lms load (slot 2) returned non-zero. Second slot may still be loading.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5b — Desktop shortcut
// ─────────────────────────────────────────────────────────────────────────────
{
  const desktopDir = path.join(HOME, 'Desktop');
  if (existsSync(desktopDir)) {
    try {
      if (IS_WIN) {
        // .bat double-click shortcut — Windows opens a console window and launches the stack
        const bat = path.join(desktopDir, 'Easy.bat');
        writeFileSync(bat,
          `@echo off\r\ntitle Easy — Local AI\r\ncd /d "${__dirname}"\r\nnode launch.mjs\r\npause\r\n`
        );
        ok(`Desktop shortcut created: ${bat}`);
      } else if (IS_MAC) {
        // .command file — double-click in Finder opens Terminal and runs it
        const cmd = path.join(desktopDir, 'Easy.command');
        writeFileSync(cmd,
          `#!/bin/bash\ncd "${__dirname}"\nnode launch.mjs\n`
        );
        try { execSync(`chmod +x "${cmd}"`, { stdio: 'ignore' }); } catch {}
        ok(`Desktop shortcut created: ${cmd}`);
      } else {
        // Linux .desktop launcher
        const desktop = path.join(desktopDir, 'easy-local-ai.desktop');
        writeFileSync(desktop,
          `[Desktop Entry]\nVersion=1.0\nType=Application\nName=Easy — Local AI\n` +
          `Comment=One-click local AI stack\n` +
          `Exec=bash -c 'cd "${__dirname}" && node launch.mjs; read'\n` +
          `Path=${__dirname}\nTerminal=true\nCategories=Utility;\n`
        );
        try { execSync(`chmod +x "${desktop}"`, { stdio: 'ignore' }); } catch {}
        ok(`Desktop shortcut created: ${desktop}`);
      }
    } catch (e) {
      warn(`Could not create desktop shortcut: ${e.message}`);
    }
  } else {
    info('No ~/Desktop found — skipping shortcut');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — Launch MCP stack
// ─────────────────────────────────────────────────────────────────────────────
head('Step 6/6 — MCP stack');
if (NO_LAUNCH) {
  info('--no-launch set — skipping stack start');
  console.log(`\n${c.green}${c.bold}Installation complete.${c.reset}`);
  console.log(`  Start the stack:  node launch.mjs`);
  console.log(`  Run a demo:       node _twin_demo.mjs`);
  console.log(`  Triad demo:       node _triad_demo.mjs\n`);
} else {
  info('Starting MCP stack (node launch.mjs) ...');
  console.log(`  ${c.gray}Press Ctrl+C to stop.${c.reset}\n`);

  const stack = spawn(process.execPath, [path.join(__dirname, 'launch.mjs')], {
    cwd: __dirname,
    stdio: 'inherit',
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stack.kill(sig);
      process.exit(0);
    });
  }

  stack.on('exit', (code) => process.exit(code ?? 0));
}
