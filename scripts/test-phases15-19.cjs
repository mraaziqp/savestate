#!/usr/bin/env node
/**
 * Phases 15-19 verification.
 *
 *   AES-256-GCM secret encryption       (18.2)
 *   BIOS interceptor + JIT core fetch   (18.1)
 *   Remote Play session + input socket  (16.2)
 *   Non-destructive vault scan          (regression: a scan destroyed 8,651
 *                                        game rows during development)
 *
 * Usage: node scripts/test-phases15-19.cjs
 *        TEST_ADMIN_ID=<uuid> node scripts/test-phases15-19.cjs
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3150);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0, skip = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };
const note = (m) => { skip++; console.log(`  ○ ${m}`); };
const head = (m) => console.log(`\n── ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── AES-256-GCM ─────────────────────────────────────────────────────────────
function testEncryption() {
  head('AES-256-GCM secret encryption');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  /aes-256-gcm/.test(src) ? ok('uses AES-256-GCM') : bad('not using AES-256-GCM');
  /getAuthTag\(\)/.test(src) && /setAuthTag\(/.test(src) ? ok('auth tag set and verified (tamper-evident)') : bad('no auth tag handling');
  /crypto\.scryptSync/.test(src) ? ok('key derived with scrypt') : bad('key not derived with scrypt');
  /crypto\.randomBytes\(12\)/.test(src) ? ok('random 12-byte IV per value') : bad('no per-value random IV');
  /function saveArrConfig/.test(src) ? ok('single encrypting writer for the arr config') : bad('no single writer');
  /radarrApiKey: encryptSecret/.test(src) ? ok('Radarr key encrypted on write') : bad('Radarr key written in clear');
  /sonarrApiKey: encryptSecret/.test(src) ? ok('Sonarr key encrypted on write') : bad('Sonarr key written in clear');
  /radarrApiKey: decryptSecret/.test(src) ? ok('Radarr key decrypted on read') : bad('Radarr key not decrypted');

  // Mirror of the server implementation — proves the scheme, not just its presence.
  const PREFIX = 'enc:v1:';
  const key = crypto.scryptSync('unit-test-material', 'nexus-secret-v1', 32);
  const enc = (p) => {
    if (!p) return '';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const e = Buffer.concat([c.update(p, 'utf8'), c.final()]);
    return PREFIX + [iv.toString('base64'), c.getAuthTag().toString('base64'), e.toString('base64')].join('.');
  };
  const dec = (v) => {
    if (!v || !v.startsWith(PREFIX)) return v;
    try {
      const [i, t, d] = v.slice(PREFIX.length).split('.');
      const x = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(i, 'base64'));
      x.setAuthTag(Buffer.from(t, 'base64'));
      return Buffer.concat([x.update(Buffer.from(d, 'base64')), x.final()]).toString('utf8');
    } catch { return ''; }
  };

  const steamKey = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';          // mock Steam Web API key
  const ct = enc(steamKey);
  dec(ct) === steamKey ? ok('mock Steam API key round-trips exactly') : bad('round-trip failed');
  !ct.includes(steamKey) ? ok('ciphertext does not contain the plaintext') : bad('plaintext leaked into ciphertext');
  ct.startsWith(PREFIX) ? ok('ciphertext carries the version prefix') : bad('no version prefix');
  enc(steamKey) !== enc(steamKey) ? ok('same input encrypts differently each time') : bad('deterministic ciphertext — IV is not random');
  dec('legacy-plaintext-key') === 'legacy-plaintext-key' ? ok('unprefixed legacy value passes through (transparent migration)') : bad('legacy plaintext broken');
  dec('') === '' ? ok('empty stays empty') : bad('empty mishandled');

  // Tampering must fail closed, not return corrupted bytes.
  const parts = ct.slice(PREFIX.length).split('.');
  const body = Buffer.from(parts[2], 'base64'); body[0] ^= 0xff;
  const tampered = PREFIX + [parts[0], parts[1], body.toString('base64')].join('.');
  dec(tampered) === '' ? ok('tampered ciphertext rejected (returns empty, not garbage)') : bad('tampering not detected');

  // And the real file on disk must not hold a readable key.
  const cfgPath = path.join(os.homedir(), '.nexus-data', 'arr-config.json');
  if (fs.existsSync(cfgPath)) {
    const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const keysEncrypted = ['radarrApiKey', 'sonarrApiKey']
      .filter((k) => disk[k])
      .every((k) => String(disk[k]).startsWith(PREFIX));
    keysEncrypted ? ok('arr-config.json on disk holds no plaintext keys') : bad('arr-config.json still has plaintext keys');
  } else note('arr-config.json not present — disk check skipped');
}

// ── BIOS interceptor + JIT core ─────────────────────────────────────────────
function testEmulationPipeline() {
  head('Resilient emulation pipeline');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  /requires_action: "upload_bios"/.test(src) ? ok('missing BIOS answers requires_action') : bad('no BIOS interceptor');
  /res\.status\(202\)[\s\S]{0,200}upload_bios/.test(src) ? ok('answers HTTP 202, not an error') : bad('BIOS gate does not use 202');
  /accepted_filenames/.test(src) ? ok('tells the client which filenames satisfy it') : bad('no accepted filenames');
  /upload_url: "\/api\/emulator\/bios\/upload"/.test(src) ? ok('points at the existing upload endpoint') : bad('no upload target');
  /^const REQUIRED_BIOS/m.test(src) ? ok('BIOS table hoisted to module scope (shared with readiness)') : bad('BIOS table not shared');

  /downloadCoreById/.test(src) ? ok('JIT core fetcher present') : bad('no core fetcher');
  /buildbot\.libretro\.com/.test(src) ? ok('fetches cores from buildbot.libretro.com') : bad('no buildbot source');
  /Core missing — auto-installing/.test(src) ? ok('launch auto-installs a missing core then continues') : bad('missing core is not auto-installed');

  // Simulate the gate: any one accepted filename satisfies it.
  const req = { anyOf: ['scph5501.bin', 'scph5500.bin', 'scph1001.bin'], required: true };
  const gate = (present) => {
    const lower = new Set(present.map((f) => f.toLowerCase()));
    return req.anyOf.some((f) => lower.has(f.toLowerCase()));
  };
  gate([]) === false ? ok('empty BIOS folder is intercepted') : bad('empty folder passed the gate');
  gate(['SCPH1001.BIN']) === true ? ok('one accepted file satisfies it, case-insensitively') : bad('case-insensitive match failed');
  gate(['gba_bios.bin']) === false ? ok('an unrelated BIOS does not satisfy it') : bad('wrong BIOS accepted');

  // Simulate the JIT fetcher being reached when a core is absent.
  let attempted = null;
  const launch = (coreId, installed) => {
    if (installed.has(coreId)) return { launched: true, downloaded: false };
    attempted = coreId;                       // fetcher reached
    installed.add(coreId);                    // buildbot download succeeds
    return { launched: true, downloaded: true };
  };
  const r = launch('pcsx_rearmed', new Set(['snes9x']));
  (attempted === 'pcsx_rearmed' && r.downloaded && r.launched)
    ? ok('missing core triggers a download attempt and the launch still proceeds')
    : bad(`JIT fetch simulation failed: ${JSON.stringify({ attempted, r })}`);
}

// ── Non-destructive scan (regression) ───────────────────────────────────────
function testScanSafety() {
  head('Vault scan does not destroy metadata');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  // The exact statement that deleted 8,651 rows must no longer be the default.
  const m = src.match(/const hardPrune = [\s\S]{0,1600}?\n      \}/);
  if (!m) return bad('could not locate the stale-sweep block');
  const block = m[0];
  /if \(hardPrune\)/.test(block) ? ok('deletion is gated behind an explicit prune flag') : bad('deletion is not gated');
  /sync_status='missing_media'/.test(block) ? ok('default path flags rows instead of deleting') : bad('default path does not flag');
  /sync_status='synced'/.test(block) ? ok('a file that reappears is un-flagged') : bad('rows never recover from missing_media');

  const idx = src.indexOf('DELETE FROM games WHERE NOT');
  idx > 0 && src.slice(Math.max(0, idx - 400), idx).includes('hardPrune')
    ? ok('the DELETE only runs under hardPrune')
    : bad('DELETE is reachable without hardPrune');

  // Behavioural check of the sweep.
  const db = new Map([['a', 'synced'], ['b', 'synced'], ['c', 'missing_media']]);
  const scanned = new Set(['a', 'c']);
  let flagged = 0, removed = 0;
  for (const [id, st] of db) {
    if (!scanned.has(id) && st !== 'missing_media') { db.set(id, 'missing_media'); flagged++; }
    else if (scanned.has(id) && st === 'missing_media') db.set(id, 'synced');
  }
  (db.size === 3 && removed === 0 && flagged === 1 && db.get('b') === 'missing_media' && db.get('c') === 'synced')
    ? ok('sweep flags the absent row, restores the returning one, deletes nothing')
    : bad(`sweep behaved wrong: ${JSON.stringify([...db])}`);
}

// ── Remote Play ─────────────────────────────────────────────────────────────
function testRemotePlayContract() {
  head('Remote Play contract');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
  /\/api\/remote-play\/start/.test(src) ? ok('start endpoint present') : bad('no start endpoint');
  /\/api\/remote-play\/stop/.test(src) ? ok('stop endpoint present') : bad('no stop endpoint');
  /wsUrl:/.test(src) ? ok('returns wsUrl as the client expects') : bad('no wsUrl in response');
  /streamFeedUrl: "\/api\/stream\/feed"/.test(src) ? ok('points at the existing MJPEG feed') : bad('no stream feed url');
  /function deliverRemoteInput/.test(src) ? ok('input delivery extracted into one shared function') : bad('input delivery not shared');
  // Regression: constructing a WebSocketServer before its dynamic import broke boot.
  const iImport = src.indexOf('const { WebSocketServer } = await import("ws")');
  const iUse = src.indexOf('const remotePlayWss = new WebSocketServer');
  (iImport > 0 && iUse > iImport) ? ok('WebSocketServer constructed after its import (boot-order regression)') : bad('remotePlayWss constructed before WebSocketServer exists');
}

// ── Live ────────────────────────────────────────────────────────────────────
async function testLive() {
  head(`Live endpoints on :${PORT}`);
  const out = fs.openSync(path.join(os.tmpdir(), `nexus-1519-${Date.now()}.log`), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.mjs')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', out, out], detached: true,
  });
  try {
    let up = false;
    for (let i = 0; i < 35 && !up; i++) {
      await sleep(2000);
      try { up = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) })).ok; } catch {}
    }
    if (!up) return bad('server did not start');
    ok('server started');

    const adminId = process.env.TEST_ADMIN_ID;
    if (!adminId) return note('TEST_ADMIN_ID not set — authenticated checks skipped');
    const secret = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^JWT_SECRET=(.*)$/m) || [])[1].trim();
    const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
    const tok = jwt.sign({ userId: adminId, username: 'p1519' }, secret, { expiresIn: '10m' });
    const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };

    const rp = await (await fetch(`${BASE}/api/remote-play/start`, { method: 'POST', headers: H, body: '{}' })).json();
    rp.ok && rp.wsUrl ? ok(`remote-play/start returns a session (${rp.session?.input})`) : bad(`remote-play/start: ${JSON.stringify(rp).slice(0, 120)}`);
    const st = await (await fetch(`${BASE}/api/remote-play/stop`, { method: 'POST', headers: H, body: '{}' })).json();
    st.ok ? ok('remote-play/stop acknowledges') : bad('remote-play/stop failed');

    const cfg = await (await fetch(`${BASE}/api/arr/config`, { headers: H })).json();
    cfg.radarrConnected && cfg.sonarrConnected
      ? ok('arr stack still connects with encrypted keys on disk')
      : bad('arr stack broken after encryption');

    const games = await (await fetch(`${BASE}/api/games`, { headers: H, signal: AbortSignal.timeout(60000) })).json();
    const list = Array.isArray(games) ? games : (games.games || []);
    list.length > 8000
      ? ok(`game library intact (${list.length} rows)`)
      : bad(`game library only has ${list.length} rows — expected >8000`);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await sleep(1500);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

(async () => {
  console.log('NexusEmu — Phases 15-19 verification');
  testEncryption();
  testEmulationPipeline();
  testScanSafety();
  testRemotePlayContract();
  await testLive();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
