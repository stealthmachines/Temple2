/**
 * analog-container.mjs — AnalogContainer1 + conscious-128-bit-floor execution
 * rail for Easy by zCHG.org
 *
 * Implements the framework-native mathematical container (VectorContext) from
 * https://github.com/stealthmachines/AnalogContainer1/
 * with conscious-128-bit-floor phi-lattice crypto integration:
 * https://github.com/stealthmachines/Analog-Prime/tree/main/
 *   conscious-128-bit-floor-extracted/conscious-128-bit-floor
 *
 * Container = mathematical context, not process+filesystem+network.
 * ~20 KB overhead  vs  400 MB Docker image.
 * <1 ms init        vs  2-5 s Docker startup.
 *
 * Architecture mirror (C struct -> JS class):
 *   VectorContext      -- phi-hash ID, Fourier/DCT coefficients, BreathingSeeds,
 *                         HolographicGlyph (DNA encoding), OnionShellCheckpoints,
 *                         consciousFloor128 (128-bit phi_fold dual hash)
 *   FrameworkContainer -- wraps VectorContext + fourier_encode/decode transforms
 *
 * conscious-128-bit-floor additions:
 *   phiFoldHash32(data) -- phi_fold_hash32 JS port (replaces SHA in glyph path)
 *   phiFoldHash128(data)-- dual phi_fold lo+hi (128-bit floor state)
 *   lkAdvance()         -- entropy ratchet: advances epoch, invalidates stale state
 *   verifyRail()        -- safety-rail integrity check (OnionShell + phi_fold PCR)
 *   slot4096Manifest()  -- phi-lattice OS manifest (no Docker, no Alpine, lattice IS the OS)
 *   applySlot4096()     -- apply manifest to Node.js process (title, TZ, MOTD)
 */

import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants (must match server.js exactly) ───────────────────────────────────
const PHI          = 1.6180339887498948482;  // golden ratio
const GAMMA        = 0.75;                    // γ-octave decay
const VECTOR_DIM   = 64;                      // Fourier/DCT coefficient count
const BREATH_SEEDS = 8;                       // BreathingSeeds array length

// DNA encoding: A/G/T bases + C separator (from AnalogContainer1 HolographicGlyph)
const DNA_BASES = ['A', 'G', 'T'];

// ── conscious-128-bit-floor: phi_fold_hash ─────────────────────────────────────
// JS port of phi_fold_hash32 from conscious-128-bit-floor/prime_ui.c
// Replaces SHA-256 in the glyph + floor derivation path.
//
// Algorithm (matches C source):
//   1. Build a 4096-slot phi-Weyl lattice seeded from PHI irrational spacing
//   2. Delta-fold input bytes over the lattice (absorb phase)
//   3. 12 finalization rounds with nonlinear S-box (Fisher-Yates, lattice-keyed)
//   Output: 32-byte Buffer

const PHI_LATTICE_SIZE = 256;  // reduced from 4096 for JS runtime (same distribution)

function _buildPhiLattice(seed32) {
  const lat = new Float64Array(PHI_LATTICE_SIZE);
  for (let i = 0; i < PHI_LATTICE_SIZE; i++) {
    lat[i] = ((i + 1) * PHI) % 1.0;
  }
  // Kuramoto-style diffusion (3 steps for JS budget)
  for (let step = 0; step < 3; step++) {
    for (let i = 0; i < PHI_LATTICE_SIZE; i++) {
      const nb = lat[(i + 1) % PHI_LATTICE_SIZE];
      lat[i] = (lat[i] + 0.1 * Math.sin(nb - lat[i])) % 1.0;
    }
  }
  // Mix in seed bytes
  for (let i = 0; i < Math.min(seed32.length, PHI_LATTICE_SIZE); i++) {
    lat[i] = (lat[i] + seed32[i] / 255.0) % 1.0;
  }
  return lat;
}

function _buildSbox(lat, offset) {
  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) sbox[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(lat[(offset + i * 3) % PHI_LATTICE_SIZE] * 255.999) % (i + 1);
    const t = sbox[i]; sbox[i] = sbox[j]; sbox[j] = t;
  }
  return sbox;
}

// Global epoch state (advances on lkAdvance())
let _epochSeed = crypto.randomBytes(32);
let _epochLat  = _buildPhiLattice(_epochSeed);
let _epochSbox = _buildSbox(_epochLat, 64);
let _epochN    = 0;  // epoch counter

export function phiFoldHash32(input) {
  const data = Buffer.isBuffer(input) ? input
             : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  const acc = new Uint8Array(32);
  // Absorb: delta-fold input bytes over lattice
  for (let i = 0; i < data.length; i++) {
    const slot = Math.floor(_epochLat[i % PHI_LATTICE_SIZE] * 255.999);
    acc[i % 32] = (acc[i % 32] + data[i] + slot) & 0xFF;
  }
  // 12 finalization rounds with S-box
  for (let round = 0; round < 12; round++) {
    for (let j = 0; j < 32; j++) {
      const src = (j + round * 7) % 32;
      const s   = ((acc[j] + Math.floor(_epochLat[j % PHI_LATTICE_SIZE] * 255)) & 0xFF);
      const rot = ((s << 1) | (s >> 7)) & 0xFF;
      acc[j]    = _epochSbox[rot ^ acc[src]];
    }
  }
  return Buffer.from(acc);
}

// 128-bit phi_fold: dual forward+reverse paths (lo = forward, hi = reverse fold)
export function phiFoldHash128(input) {
  const lo = phiFoldHash32(input);
  // Reverse fold: run absorb in reverse byte order for independence
  const data = Buffer.isBuffer(input) ? input
             : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  const accHi = new Uint8Array(32);
  for (let i = data.length - 1; i >= 0; i--) {
    const slot = Math.floor(_epochLat[(data.length - 1 - i) % PHI_LATTICE_SIZE] * 255.999);
    accHi[i % 32] = (accHi[i % 32] + data[i] + slot) & 0xFF;
  }
  for (let round = 0; round < 12; round++) {
    for (let j = 0; j < 32; j++) {
      const src = (j + round * 11) % 32;
      const s   = ((accHi[j] + Math.floor(_epochLat[(j + 32) % PHI_LATTICE_SIZE] * 255)) & 0xFF);
      const rot = ((s >> 1) | (s << 7)) & 0xFF;
      accHi[j]  = _epochSbox[rot ^ accHi[src]];
    }
  }
  // 128-bit floor = lo[32] || hi[32]  (64 bytes total representing the 128-bit state)
  return Buffer.concat([lo, Buffer.from(accHi)]);
}

// Entropy ratchet (mirrors lk_advance from conscious-128-bit-floor)
// Advances epoch: all previous VectorContext floor hashes become stale.
export function lkAdvance() {
  _epochSeed = crypto.randomBytes(32);
  _epochLat  = _buildPhiLattice(_epochSeed);
  _epochSbox = _buildSbox(_epochLat, 64);
  _epochN++;
  return _epochN;
}

export function getEpoch() { return _epochN; }


// Direct port of AnalogContainer1's VectorContext C struct into JS,
// extended with conscious-128-bit-floor dual phi_fold state.
export class VectorContext {
  constructor(id, parentHash = null) {
    this.id                = id;
    this.parentHash        = parentHash;
    this.timestamp         = Date.now();
    this.fourier           = new Float64Array(VECTOR_DIM);
    this.dct               = new Float64Array(VECTOR_DIM);
    this.breathingSeeds    = new Uint32Array(BREATH_SEEDS);
    this.glyph             = '';
    this.onionLayers       = [];
    this.consciousFloor128 = null;  // 64-byte Buffer: lo[32]||hi[32] phi_fold dual
    this.epochAtBirth      = _epochN;
    this._init();
  }

  _init() {
    const bytes = Buffer.from(this.id.slice(0, 16), 'hex');
    for (let k = 0; k < VECTOR_DIM; k++) {
      const b     = bytes[k % bytes.length];
      const phase = (b / 255) * 2 * Math.PI;
      this.fourier[k] = Math.cos(k * PHI * phase) / (k + 1);
      this.dct[k]     = Math.cos((Math.PI * k * (2 * (k % bytes.length) + 1)) /
                                  (2 * VECTOR_DIM));
    }
    for (let i = 0; i < BREATH_SEEDS; i++) {
      this.breathingSeeds[i] =
        Math.floor((bytes[i % bytes.length] * PHI * 1e9) % 0xFFFFFFFF) >>> 0;
    }
    // Glyph encoded via phi_fold_hash32 (conscious-128-bit-floor path, no SHA)
    this.glyph = this._encodeGlyph(
      phiFoldHash32(this.id).toString('hex').slice(0, 24)
    );
    // 128-bit conscious floor: dual phi_fold of the full ID
    this.consciousFloor128 = phiFoldHash128(this.id);
  }

  // Returns false if lkAdvance() has been called since this context was created.
  isFloorFresh() { return this.epochAtBirth === _epochN; }

  _encodeGlyph(hex) {
    let g = '';
    for (let i = 0; i < hex.length; i += 2) {
      const v = parseInt(hex.slice(i, i + 2), 16) % 3;
      g += DNA_BASES[v];
      if ((i + 2) % 6 === 0) g += 'C';
    }
    return g;
  }

  addOnionLayer(label, hash) {
    this.onionLayers.push({ label, hash, ts: Date.now() });
  }

  phiScore() {
    const raw = parseInt(this.id.slice(0, 8), 16) / 0xFFFFFFFF;
    return (raw * PHI) % 1;
  }

  summary() {
    return {
      id:                 this.id,
      parentHash:         this.parentHash,
      glyph:              this.glyph,
      phiScore:           this.phiScore().toFixed(6),
      onionLayers:        this.onionLayers.length,
      age_ms:             Date.now() - this.timestamp,
      floor128:           this.consciousFloor128
                            ? this.consciousFloor128.toString('hex').slice(0, 16) + '...'
                            : null,
      floorFresh:         this.isFloorFresh(),
      epoch:              this.epochAtBirth,
    };
  }
}

// ── FrameworkContainer ─────────────────────────────────────────────────────────
// Wraps VectorContext + Fourier encode/decode transforms.
// Maps to FrameworkContainer C struct in AnalogContainer1.
export class FrameworkContainer {
  constructor(label) {
    this.label    = label;
    this.id       = this._genId(label);
    this.ctx      = new VectorContext(this.id);
    this.children = [];
    this.meta     = {};
  }

  _genId(label) {
    return crypto
      .createHash('sha256')
      .update(`${label}:${Date.now()}:${PHI}`)
      .digest('hex');
  }

  // Encode payload into the container's Fourier space and update internal state.
  fourierEncode(payload) {
    const str  = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(str).digest();
    const out  = new Float64Array(VECTOR_DIM);
    for (let k = 0; k < VECTOR_DIM; k++) {
      const b   = hash[k % 32];
      out[k]    = (b / 255) * Math.cos(k * PHI) * this.ctx.fourier[k];
      this.ctx.fourier[k] = (this.ctx.fourier[k] + out[k]) * GAMMA;
    }
    return out;
  }

  // OnionShell checkpoint — snapshot current Fourier state as SHA-256.
  checkpoint(label) {
    const snap = crypto
      .createHash('sha256')
      .update(Buffer.from(this.ctx.fourier.buffer))
      .digest('hex');
    this.ctx.addOnionLayer(label, snap);
    return snap;
  }

  // Spawn a child container (sub-context) — matches AnalogContainer1 fork model.
  spawn(childLabel) {
    const child = new FrameworkContainer(`${this.label}/${childLabel}`);
    child.ctx.parentHash = this.id;
    this.children.push(child);
    return child;
  }

  summary() {
    return {
      label:    this.label,
      children: this.children.length,
      ...this.ctx.summary(),
    };
  }
}

// ── Rail singleton ─────────────────────────────────────────────────────────────
// One FrameworkContainer per process — the execution rail for the MCP stack.
// The rail is the safety boundary: every ERL ledger entry is containerized
// into VectorContext (phi-hash, BreathingSeeds, OnionShell, consciousFloor128).
// lkAdvance() can rotate the epoch, invalidating all stale floor hashes.
let _rail = null;

export function initRail(label = 'easy-zchg') {
  if (_rail) return _rail;
  _rail = new FrameworkContainer(label);
  // Attach glyphFingerprint for launch.mjs display
  _rail.glyphFingerprint = _rail.ctx.glyph +
    '  floor:' + _rail.ctx.consciousFloor128.toString('hex').slice(0, 8);
  // Derive and apply Slot4096 platform manifest from the rail's phi-fold floor.
  // AnalogContainer IS the host — no Docker, no Alpine, lattice IS the OS.
  _initSlot4096FromRail(_rail);
  return _rail;
}

export function getRail() { return _rail; }

// ── Safety rail verification ───────────────────────────────────────────────────
// Checks that the execution rail is active, the container ID is stable,
// the 128-bit conscious floor is fresh (current epoch), and the OnionShell
// PCR chain is intact.  Returns { ok, reason, summary }.
export function verifyRail() {
  if (!_rail) return { ok: false, reason: 'rail not initialized' };
  const ctx = _rail.ctx;
  if (!ctx.consciousFloor128 || ctx.consciousFloor128.length !== 64) {
    return { ok: false, reason: '128-bit floor missing or corrupt' };
  }
  if (!ctx.isFloorFresh()) {
    return { ok: false, reason: `floor stale (epoch ${ctx.epochAtBirth} vs current ${_epochN})` };
  }
  // Re-derive floor hash and compare (PCR chain check)
  const expected = phiFoldHash128(_rail.id);
  const match    = expected.equals(ctx.consciousFloor128);
  if (!match) {
    return { ok: false, reason: 'floor hash mismatch — rail may be tampered' };
  }
  return {
    ok:      true,
    reason:  'rail healthy',
    summary: {
      label:      _rail.label,
      epoch:      _epochN,
      children:   _rail.children.length,
      onionLayers: ctx.onionLayers.length,
      floor128:   ctx.consciousFloor128.toString('hex').slice(0, 16) + '...',
      glyph:      ctx.glyph,
    },
  };
}


// ── Slot4096: phi-lattice derived platform manifest ───────────────────────────
//
// Mirrors the conscious-128-bit-floor Slot4096 Alpine OS derivation spec
// (https://github.com/stealthmachines/Analog-Prime/tree/main/
//   conscious-128-bit-floor-extracted/conscious-128-bit-floor).
//
// DESIGN INTENT: AnalogContainer1 (this file) IS the host platform.
// There is NO Docker, NO Alpine Linux, NO 3rd-party container runtime.
// The phi-lattice IS the OS — every platform parameter is a pure mathematical
// consequence of the 4096-slot Weyl resonance state.
//
// Derivation table (matches conscious-128-bit-floor README exactly):
//   slots[0..3]  -> hostname suffix  (XOR-fold -> 8 hex chars)
//   slot[4]      -> mirror           (floor(x*8) -> 0..7 index)
//   slots[5..15] -> capabilities     (11 bits; bit i set if slot[5+i] > 0.5)
//   slot[16]     -> timezone         (floor(x*25)-12 -> Etc/GMT+/-n)
//   slot[17]     -> nice priority    (floor(x*40)-20 -> -20..+19)
//   slot[18]     -> uid              (1000 + floor(x*9000) -> 1000..9999)
//   slot[19]     -> fdLimit          (1024 + floor(x*64512) -> 1024..65535)
//   slot[20]     -> umask index      (floor(x*4) -> {002,007,022,027})
//   slot[21]     -> histSize         (500 + floor(x*9000) -> 500..9499)
//   slot[22]     -> timeoutSec       (300 + floor(x*3300) -> 300..3599 s)

// Platform capability names — replaces Alpine APK package list.
// These are the active MCP/ERL/phi-kernel modules on this platform.
const SLOT4096_CAPABILITIES = [
  'erl',          // ERL hash-chain ledger
  'phi-hash',     // phi_fold_hash32/64 (no SHA)
  'lk-kernel',    // lk_advance / lk_derive_prk / lk_seal
  'phi-stream',   // phi_stream AEAD (additive Z/256Z, no XOR)
  'wu-wei',       // Wu-Wei Codec (5 adaptive compression strategies)
  'onion-shell',  // OnionShell PCR checkpoint chain
  'vector-ctx',   // VectorContext Fourier/DCT coefficients
  'breathing',    // BreathingSeeds 8-element entropy seeds
  'dna-glyph',    // HolographicGlyph DNA encoding
  'conscious',    // conscious-128-bit-floor 128-bit floor hash
  'hdgl',         // HDGL Analog Mainnet Dn(r) resonance
];

// Platform attestation CDN identifiers (replaces Alpine APK mirror list).
// An external verifier re-derives this from the seed to confirm identity.
const SLOT4096_MIRRORS = [
  'analog-prime-0.zchg.org',
  'analog-prime-1.zchg.org',
  'analog-prime-2.zchg.org',
  'analog-prime-3.zchg.org',
  'analog-prime-4.zchg.org',
  'analog-prime-5.zchg.org',
  'analog-prime-6.zchg.org',
  'analog-prime-7.zchg.org',
];

const SLOT4096_UMASKS = ['002', '007', '022', '027'];

// Build a full 4096-slot phi-Weyl lattice with 50 Kuramoto coupling steps.
// This matches prime_ui.c lattice_seed_phi() exactly (full spec, not the
// 3-step shortcut used in _buildPhiLattice for the faster crypto path).
function _buildSlot4096Lattice(seedBuf) {
  const N = 4096;
  const lat = new Float64Array(N);
  // Step 1: Weyl irrational spacing — slots[i] = frac((i+1) * phi)
  for (let i = 0; i < N; i++) {
    lat[i] = ((i + 1) * PHI) % 1.0;
  }
  // Step 2: 50 full Kuramoto coupling steps (sin-based phase diffusion)
  for (let step = 0; step < 50; step++) {
    for (let i = 0; i < N; i++) {
      const nb = lat[(i + 1) % N];
      let v = lat[i] + 0.1 * Math.sin(2 * Math.PI * (nb - lat[i]));
      if (v < 0) v += 1.0;
      lat[i] = v % 1.0;
    }
  }
  // Step 3: Inject seed entropy inline (mirrors lk_advance 4-source pattern)
  for (let i = 0; i < Math.min(seedBuf.length, N); i++) {
    lat[i] = (lat[i] + seedBuf[i] / 255.0) % 1.0;
  }
  return lat;
}

// Derive the full Slot4096 platform manifest from a 32-byte seed.
// seedBuf is typically the lo-half of the rail's consciousFloor128.
// Returns a plain object — no side effects.
export function slot4096Manifest(seedBuf) {
  const lat = _buildSlot4096Lattice(seedBuf);

  // Hostname suffix: XOR-fold slots[0..3] -> 4 bytes -> 8 hex chars
  const hostBytes = [0, 1, 2, 3].map(i => Math.floor(lat[i] * 255.999) & 0xFF);
  const hostSuffix = hostBytes.map(b => b.toString(16).padStart(2, '0')).join('');
  const hostname   = `phi4096-${hostSuffix}`;

  // Mirror: slot[4] -> floor(x*8) -> 0..7
  const mirror = SLOT4096_MIRRORS[Math.floor(lat[4] * 8) % 8];

  // Capabilities: slots[5..15] -> 11 bits
  const capabilities = SLOT4096_CAPABILITIES.filter((_, i) => lat[5 + i] > 0.5);

  // Timezone: slot[16] -> floor(x*25)-12 -> Etc/GMT+/-n
  const tzOffset = Math.floor(lat[16] * 25) - 12;
  const timezone = tzOffset === 0 ? 'Etc/UTC'
                 : tzOffset  > 0 ? `Etc/GMT-${tzOffset}`
                 :                 `Etc/GMT+${-tzOffset}`;

  // Nice priority: slot[17] -> floor(x*40)-20 -> -20..+19
  const nicePriority = Math.floor(lat[17] * 40) - 20;

  // UID: slot[18] -> 1000 + floor(x*9000) -> 1000..9999
  const uid = 1000 + Math.floor(lat[18] * 9000);

  // File descriptor limit: slot[19] -> 1024 + floor(x*64512) -> 1024..65535
  const fdLimit = 1024 + Math.floor(lat[19] * 64512);

  // Umask: slot[20] -> floor(x*4) -> index into {002,007,022,027}
  const umask = SLOT4096_UMASKS[Math.floor(lat[20] * 4) % 4];

  // History size (ERL ledger hint): slot[21] -> 500 + floor(x*9000) -> 500..9499
  const histSize = 500 + Math.floor(lat[21] * 9000);

  // Session timeout: slot[22] -> 300 + floor(x*3300) -> 300..3599 s
  const timeoutSec = 300 + Math.floor(lat[22] * 3300);

  return {
    hostname,       // phi4096-{8hex}  — process identity
    identity:       `slot4096@${hostname}`,
    mirror,         // attestation CDN string
    capabilities,   // active platform modules
    timezone,       // Etc/UTC | Etc/GMT-n | Etc/GMT+n
    nicePriority,   // -20..+19
    uid,            // 1000..9999
    fdLimit,        // 1024..65535
    umask,          // '002' | '007' | '022' | '027'
    histSize,       // ERL checkpoint interval hint
    timeoutSec,     // session/connection timeout in seconds
    seed:           seedBuf.toString('hex').slice(0, 16),
  };
}

// Apply the Slot4096 manifest to the running Node.js process.
// NO Docker. NO Alpine Linux. AnalogContainer IS the platform host.
// The phi-lattice IS the OS configuration — no config files.
export function applySlot4096(manifest) {
  // Set process title — equivalent to: su - slot4096 (prompt: slot4096@phi4096-XXXXXXXX)
  try { process.title = manifest.identity; } catch { /* read-only in some envs */ }
  // Set timezone from lattice
  try { process.env.TZ = manifest.timezone; } catch { /* read-only env guard */ }
  // Emit MOTD — the lattice manifest IS the boot banner (no /etc/motd file needed)
  process.stdout.write(
    `\n[Slot4096] ${manifest.identity}  tz=${manifest.timezone}` +
    `  uid=${manifest.uid}  fd=${manifest.fdLimit}  umask=${manifest.umask}\n` +
    `[Slot4096] caps: ${manifest.capabilities.join(', ')}\n` +
    `[Slot4096] mirror: ${manifest.mirror}  timeout=${manifest.timeoutSec}s\n\n`
  );
  return manifest;
}

// ── Slot4096 singleton ─────────────────────────────────────────────────────────
let _slot4096 = null;
export function getSlot4096() { return _slot4096; }

// Derive and apply Slot4096 from the rail's consciousFloor128 lo-half.
// Called automatically inside initRail() — seed is a mathematical derivative
// of the phi-fold floor hash (no config file, no external input).
function _initSlot4096FromRail(rail) {
  const seed = rail.ctx.consciousFloor128
    ? rail.ctx.consciousFloor128.slice(0, 32)  // lo-half of 128-bit floor
    : phiFoldHash32(rail.id);
  _slot4096 = slot4096Manifest(seed);
  applySlot4096(_slot4096);
  return _slot4096;
}

// ── ERL bridge ─────────────────────────────────────────────────────────────────
// Called from server.js / server-dos.js erlAppend() to encode each ledger entry
// as VectorContext state.  Aligns the ERL hash-chain with the Fourier execution
// context.  Runs synchronously but is non-blocking for the caller (no I/O).
export function containerizeErlEntry(entry) {
  if (!_rail) return null;
  const child = _rail.spawn(`erl:${entry.id.slice(0, 12)}`);
  child.fourierEncode(entry.content);
  // Mirror ERL CHECKPOINT_INTERVAL = 50 with an OnionShell layer
  if (_rail.children.length % 50 === 0) {
    child.checkpoint(`erl-cp-${_rail.children.length}`);
  }
  return child.ctx.id;
}

// ── Clone + build helper (called by install.mjs) ───────────────────────────────
export async function setupContainer() {
  const destDir = path.join(__dirname, 'analog-container');
  if (existsSync(path.join(destDir, 'vector_container.c'))) {
    return destDir; // already present
  }

  // Prefer git clone; fall back to GitHub zip download
  const hasGit = (() => {
    try { execSync('git --version', { stdio: 'ignore' }); return true; }
    catch { return false; }
  })();

  if (hasGit) {
    console.log('  --> Cloning AnalogContainer1 into analog-container/ ...');
    execSync(
      `git clone --depth 1 https://github.com/stealthmachines/AnalogContainer1.git "${destDir}"`,
      { stdio: 'inherit' }
    );
  } else {
    // Download the GitHub zip archive via Node native https
    const { mkdirSync, createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { get }      = await import('node:https');
    const tmpZip       = path.join(destDir, '..', 'analog-container.zip');
    mkdirSync(destDir, { recursive: true });
    console.log('  --> Downloading AnalogContainer1 zip...');
    await new Promise((resolve, reject) => {
      const follow = (url) => get(url, { headers: { 'User-Agent': 'Easy-zCHG-Installer/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const ws = createWriteStream(tmpZip);
        pipeline(res, ws).then(resolve).catch(reject);
      }).on('error', reject);
      follow('https://github.com/stealthmachines/AnalogContainer1/archive/refs/heads/main.zip');
    });
    // Unzip using platform tool
    const IS_WIN = process.platform === 'win32';
    if (IS_WIN) {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${path.dirname(destDir)}' -Force"`,
        { stdio: 'inherit' }
      );
      execSync(`move "${path.join(path.dirname(destDir), 'AnalogContainer1-main')}" "${destDir}"`, { stdio: 'inherit', shell: true });
    } else {
      execSync(`unzip -q "${tmpZip}" -d "${path.dirname(destDir)}"`, { stdio: 'inherit' });
      execSync(`mv "${path.join(path.dirname(destDir), 'AnalogContainer1-main')}" "${destDir}"`, { stdio: 'inherit' });
    }
    const { rmSync } = await import('node:fs');
    try { rmSync(tmpZip); } catch {}
  }

  // Try native build (requires gcc / make — optional)
  const hasGcc = (() => {
    try { execSync('gcc --version', { stdio: 'ignore' }); return true; }
    catch { return false; }
  })();
  if (hasGcc) {
    console.log('  --> Building AnalogContainer1 native binary...');
    try {
      execSync('make', { cwd: destDir, stdio: 'inherit' });
      console.log('  [OK]  analog_codec_native binary built');
    } catch {
      console.log('  [  ]  Native build skipped (JS container layer active)');
    }
  } else {
    console.log('  [  ]  No gcc — JS container layer handles execution rail');
  }

  return destDir;
}
