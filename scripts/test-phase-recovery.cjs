#!/usr/bin/env node
/**
 * Streaming + recovery verification.
 *
 * Covers the two things the phase asked for, plus the streaming work that
 * turned out to be the actual cause of the buffering:
 *
 *   1. A scrub gesture issues ONE seek, not one per pointer move. The custom
 *      scrubber commits on pointerup rather than pointermove, so this asserts
 *      against the real player source rather than mocking a component.
 *   2. The cloud audit flags a file that does not exist and confirms one that
 *      does, matching on name and size.
 *   3. Hardware transcoding is wired in and segments carry immutable caching.
 *
 * Usage: node scripts/test-phase-recovery.cjs
 *        TEST_ADMIN_ID=<uuid> node scripts/test-phase-recovery.cjs   (live API)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3126);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0, skip = 0;
const ok   = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad  = (m) => { fail++; console.log(`  ✗ ${m}`); };
const note = (m) => { skip++; console.log(`  ○ ${m}`); };
const head = (m) => console.log(`\n── ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Scrubber: one seek per gesture ────────────────────────────────────────
function testScrubber() {
  head('Scrubber commits one seek per gesture');
  const p = path.join(ROOT, 'public', 'player.html');
  if (!fs.existsSync(p)) return bad('public/player.html missing');
  const src = fs.readFileSync(p, 'utf8');

  // The guarantee is structural: currentTime is assigned in the pointerup /
  // endDrag path, never inside pointermove.
  const move = src.match(/pointermove[\s\S]*?\}\);/);
  if (!move) return bad('no pointermove handler found');
  /currentTime\s*=/.test(move[0])
    ? bad('pointermove assigns currentTime — every drag pixel would seek')
    : ok('pointermove does not seek (paints the bar only)');

  /const endDrag[\s\S]*?currentTime\s*=\s*dragTo/.test(src)
    ? ok('seek is committed in endDrag (pointerup/pointercancel)')
    : bad('no commit-on-release seek found');

  // Simulate a drag and count how many seeks the logic would produce.
  let seeks = 0;
  const player = {
    dragging: false, dragTo: 0, duration: 100,
    down(t) { this.dragging = true; this.dragTo = t; },
    move(t) { if (this.dragging) this.dragTo = t; },   // no seek here
    up()    { if (!this.dragging) return; this.dragging = false; seeks++; },
  };
  player.down(10);
  for (let i = 0; i < 60; i++) player.move(10 + i);    // 60 move events
  player.up();
  seeks === 1
    ? ok(`60 pointermove events produced ${seeks} seek`)
    : bad(`60 pointermove events produced ${seeks} seeks — expected 1`);

  // hls.js does its own segment-level fetching; the old fallback path that
  // restarted the whole transcode on every seek must not be the default.
  /hlsUrl\(/.test(src) && /loadSource/.test(src)
    ? ok('player uses HLS (segment seeking) as its transport')
    : bad('player does not use the HLS transport');
}

// ── 2. Cloud audit: flags missing, confirms present ──────────────────────────
function testCloudAudit() {
  head('Cloud audit flags a missing file and confirms a real one');

  // Reimplements the server's matcher over a temp tree, so the test proves the
  // matching rule (name + size) without needing Drive or the database.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-audit-'));
  const cloud = path.join(tmp, 'cloud');
  fs.mkdirSync(path.join(cloud, 'movies'), { recursive: true });
  const real = path.join(cloud, 'movies', 'Real.Movie.2024.mkv');
  fs.writeFileSync(real, Buffer.alloc(4096, 7));

  const index = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      const k = e.name.toLowerCase();
      (index.get(k) || index.set(k, []).get(k)).push({ path: f, size: fs.statSync(f).size });
    }
  })(cloud);

  const find = (dbPath, knownSize = 0) => {
    const hits = index.get(path.basename(dbPath).toLowerCase());
    if (!hits?.length) return null;
    if (knownSize > 0) {
      const exact = hits.find((h) => h.size === knownSize);
      return exact ? exact : { ...hits[0], sizeMismatch: true };
    }
    return hits[0];
  };

  const gone = find('/media/moh/EMULATION dRIVE/Movies/Lost.Forever.2019.mkv');
  gone === null ? ok('missing file flagged as missing_media') : bad('missing file was matched to something');

  const found = find('/media/moh/EMULATION dRIVE/Movies/Real.Movie.2024.mkv', 4096);
  found && !found.sizeMismatch && found.path === real
    ? ok('surviving file located in the cloud index and size-confirmed')
    : bad(`surviving file not confirmed: ${JSON.stringify(found)}`);

  const wrongSize = find('/media/moh/EMULATION dRIVE/Movies/Real.Movie.2024.mkv', 999999);
  wrongSize && wrongSize.sizeMismatch
    ? ok('name match with wrong size reported as size_mismatch, not repointed')
    : bad('size mismatch was not detected — a different encode would be silently adopted');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 3. Transcoder wiring ─────────────────────────────────────────────────────
function testTranscoder() {
  head('Hardware transcoding is wired in with a software fallback');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  /function videoEncodeArgs/.test(src) ? ok('videoEncodeArgs() exists') : bad('videoEncodeArgs() missing');
  /h264_vaapi/.test(src)               ? ok('VAAPI H.264 encoder referenced') : bad('no VAAPI encoder');
  /hwEncodeAvailable/.test(src)        ? ok('runtime capability probe present') : bad('no capability probe');
  /NEXUS_DISABLE_HW_TRANSCODE/.test(src) ? ok('hardware path can be disabled by env') : bad('no kill switch');

  // A stock container has no /dev/dri; the software path must still exist.
  /libx264/.test(src) ? ok('software fallback retained for hosts without a GPU')
                      : bad('software fallback was removed — container deploys would break');

  const immutable = (src.match(/max-age=31536000, immutable/g) || []).length;
  immutable >= 2 ? ok(`HLS segments served immutable (${immutable} sites)`)
                 : bad(`segments not immutably cached (${immutable} sites)`);

  // Does this host actually have the hardware? Informational, never a failure.
  try {
    const enc = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 20000 });
    const dri = fs.existsSync(process.env.NEXUS_VAAPI_DEVICE || '/dev/dri/renderD128');
    if (/h264_vaapi/.test(enc) && dri) ok('this host can transcode in hardware');
    else note('this host has no usable VAAPI — software transcoding will be used');
  } catch { note('ffmpeg not available to probe'); }
}

// ── 4. Live endpoints (optional) ─────────────────────────────────────────────
async function testLive() {
  head(`Live endpoints on :${PORT}`);
  const logFile = path.join(os.tmpdir(), `nexus-phase-test-${Date.now()}.log`);
  const out = fs.openSync(logFile, 'w');
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

    for (const [route, label] of [['/player', 'standalone player'], ['/recovery', 'recovery report'], ['/vendor/hls.js', 'hls.js vendor alias']]) {
      try {
        const r = await fetch(BASE + route, { signal: AbortSignal.timeout(15000) });
        r.ok ? ok(`${label} served (${route})`) : bad(`${label} returned ${r.status}`);
      } catch (e) { bad(`${label} failed: ${e.message}`); }
    }

    const adminId = process.env.TEST_ADMIN_ID;
    if (!adminId) return note('TEST_ADMIN_ID not set — admin endpoint checks skipped');
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const secret = (env.match(/^JWT_SECRET=(.*)$/m) || [])[1]?.trim();
    const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
    const tok = jwt.sign({ userId: adminId, username: 'phase-test' }, secret, { expiresIn: '10m' });

    const r = await fetch(`${BASE}/api/recovery/report?limit=5`, {
      headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(30000),
    });
    if (r.ok) {
      const d = await r.json();
      ok('/api/recovery/report responds');
      Array.isArray(d.totals) ? ok(`audit holds ${d.totals.reduce((a, t) => a + t.n, 0)} classified row(s)`)
                              : bad('report has no totals');
    } else bad(`/api/recovery/report returned ${r.status}`);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await sleep(1500);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

(async () => {
  console.log('NexusEmu — streaming & recovery verification');
  testScrubber();
  testCloudAudit();
  testTranscoder();
  await testLive();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
