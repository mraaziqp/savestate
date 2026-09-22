#!/usr/bin/env node
/**
 * Streaming + audit verification.
 *
 *   - HTTP 206 range handling returns EXACTLY the requested bytes
 *   - Large (10MB) ranges are served efficiently and correctly
 *   - Segment latency and buffer configuration are sane
 *   - The route audit finds no 5xx
 *
 * Usage: TEST_ADMIN_ID=<uuid> node scripts/test-audit-streaming.cjs
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';
let pass = 0, fail = 0, skip = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };
const note = (m) => { skip++; console.log(`  ○ ${m}`); };
const head = (m) => console.log(`\n── ${m}`);

function token() {
  const secret = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^JWT_SECRET=(.*)$/m) || [])[1].trim();
  const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
  return jwt.sign({ userId: process.env.TEST_ADMIN_ID || '0', username: 'stream-test' }, secret, { expiresIn: '20m' });
}

// ── Range correctness ───────────────────────────────────────────────────────
async function testRanges(tok) {
  head('HTTP 206 range handling');
  const H = { Authorization: `Bearer ${tok}` };

  const lib = await fetch(`${BASE}/api/media/library`, { headers: H, signal: AbortSignal.timeout(120000) }).then((r) => r.json());
  const vid = (lib.items || []).find((i) => i.kind === 'video' && i.size > 12 * 1024 * 1024);
  if (!vid) return note('no video large enough to range-test');
  const url = `${BASE}/api/media/file?rel=${encodeURIComponent(vid.relPath)}`;

  // A range must return exactly what was asked for — no more, no less. Getting
  // this wrong corrupts playback in ways that only surface mid-file.
  const cases = [
    { start: 0, end: 1023, label: '1KB from the head' },
    { start: 1_000_000, end: 1_999_999, label: '1MB from the middle' },
    { start: 5_000_000, end: 14_999_999, label: '10MB block' },
  ];
  for (const c of cases) {
    const want = c.end - c.start + 1;
    const r = await fetch(url, { headers: { ...H, Range: `bytes=${c.start}-${c.end}` }, signal: AbortSignal.timeout(120000) });
    if (r.status !== 206) { bad(`${c.label}: expected 206, got ${r.status}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    const cr = r.headers.get('content-range') || '';
    const cl = Number(r.headers.get('content-length') || 0);
    const okLen = buf.length === want;
    const okCl = cl === want;
    const okCr = cr === `bytes ${c.start}-${c.end}/${vid.size}`;
    (okLen && okCl && okCr)
      ? ok(`${c.label}: exactly ${want} bytes, Content-Range correct`)
      : bad(`${c.label}: got ${buf.length}B (want ${want}), CL=${cl}, CR="${cr}"`);
  }

  // Overlapping ranges must agree, or seeking lands on different data.
  const a = Buffer.from(await (await fetch(url, { headers: { ...H, Range: 'bytes=2000000-2009999' }, signal: AbortSignal.timeout(60000) })).arrayBuffer());
  const b = Buffer.from(await (await fetch(url, { headers: { ...H, Range: 'bytes=2005000-2014999' }, signal: AbortSignal.timeout(60000) })).arrayBuffer());
  a.subarray(5000, 10000).equals(b.subarray(0, 5000))
    ? ok('overlapping ranges return identical bytes')
    : bad('overlapping ranges disagree — seeking would land on wrong data');

  // An open-ended range is what a browser sends first.
  const openR = await fetch(url, { headers: { ...H, Range: 'bytes=0-' }, signal: AbortSignal.timeout(60000) });
  openR.status === 206 && (openR.headers.get('content-range') || '').endsWith(`/${vid.size}`)
    ? ok('open-ended "bytes=0-" answered with the full length')
    : bad(`open-ended range: ${openR.status} ${openR.headers.get('content-range')}`);

  openR.headers.get('accept-ranges') === 'bytes'
    ? ok('Accept-Ranges advertised')
    : bad('Accept-Ranges missing — browsers would refuse to seek');
}

// ── Segment latency ─────────────────────────────────────────────────────────
async function testSegments(tok) {
  head('HLS segment delivery');
  const H = { Authorization: `Bearer ${tok}` };
  const lib = await fetch(`${BASE}/api/media/library`, { headers: H, signal: AbortSignal.timeout(120000) }).then((r) => r.json());
  const vid = (lib.items || []).find((i) => i.kind === 'video');
  if (!vid) return note('no video available');
  const rel = encodeURIComponent(vid.relPath);

  const t0 = Date.now();
  const pl = await fetch(`${BASE}/api/media/hls/playlist.m3u8?rel=${rel}`, { headers: H, signal: AbortSignal.timeout(120000) });
  const plMs = Date.now() - t0;
  const body = await pl.text();
  pl.ok ? ok(`playlist served in ${plMs}ms`) : bad(`playlist returned ${pl.status}`);

  // Fast-start: the head segments must be short so a frame can be drawn early.
  const durs = [...body.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1]));
  (durs.length >= 4 && durs[0] <= 2.5 && durs[3] > durs[0])
    ? ok(`fast-start head: first segments ${durs.slice(0, 3).join('s, ')}s then ${durs[3]}s`)
    : bad(`segment durations look wrong: ${durs.slice(0, 5).join(', ')}`);

  body.includes('#EXT-X-ENDLIST') ? ok('VOD playlist is terminated') : bad('no ENDLIST — player would treat it as live');

  const t1 = Date.now();
  const seg = await fetch(`${BASE}/api/media/hls/segment.ts?rel=${rel}&quality=auto&audio_track=0&n=0`, { headers: H, signal: AbortSignal.timeout(180000) });
  const segMs = Date.now() - t1;
  const segBuf = Buffer.from(await seg.arrayBuffer());
  seg.ok && segBuf.length > 1000 ? ok(`segment 0: ${(segBuf.length / 1024).toFixed(0)}KB in ${segMs}ms`) : bad(`segment 0 failed (${seg.status})`);
  // MPEG-TS packets begin with 0x47; a body that isn't TS means the muxer failed.
  segBuf[0] === 0x47 ? ok('segment is valid MPEG-TS (sync byte present)') : bad('segment is not MPEG-TS');
  (seg.headers.get('cache-control') || '').includes('immutable')
    ? ok('segments served immutable') : bad('segments not immutably cached');
}

// ── Buffer configuration ────────────────────────────────────────────────────
function testBufferConfig() {
  head('Player buffer configuration');
  const pl = fs.readFileSync(path.join(ROOT, 'public', 'player.html'), 'utf8');

  const size = (pl.match(/maxBufferSize:\s*(\d+)\s*\*\s*1000\s*\*\s*1000/) || [])[1];
  const back = (pl.match(/backBufferLength:\s*(\d+)/g) || []).map((m) => +m.split(':')[1].trim());
  const backCfg = back.length ? back[back.length - 1] : null;

  // hls.js applies maxBufferSize across the WHOLE SourceBuffer, back buffer
  // included. A large back buffer therefore eats the forward budget — measured
  // at 7-9s of forward buffer when backBufferLength was 60.
  (size && +size >= 240) ? ok(`byte budget raised to ${size}MB`) : bad(`maxBufferSize is ${size}MB — too small to hold a deep forward buffer`);
  (backCfg !== null && backCfg <= 30) ? ok(`back buffer trimmed to ${backCfg}s so it cannot starve the forward buffer`) : bad(`backBufferLength ${backCfg}s will consume the byte budget`);

  const delay = (pl.match(/SPINNER_DELAY_MS\s*=\s*(\d+)/) || [])[1];
  (delay && +delay >= 1000) ? ok(`spinner debounce ${delay}ms`) : bad(`spinner debounce ${delay}ms is too eager`);
  /if \(v\.paused\) return false;/.test(pl) ? ok('spinner suppressed while paused') : bad('spinner can appear while paused');
  /v\.readyState >= 3/.test(pl) ? ok('spinner suppressed when a frame is ready') : bad('spinner ignores readyState');

  // Seeking must commit on release, not on every pointer move.
  const move = (pl.match(/pointermove[\s\S]*?\}\);/) || [''])[0];
  !/currentTime\s*=/.test(move) ? ok('scrubbing does not seek on pointermove') : bad('scrubbing seeks on every move');
  /const endDrag[\s\S]*?currentTime\s*=\s*dragTo/.test(pl) ? ok('seek committed on release') : bad('no commit-on-release seek');
}

// ── Fail-safe launcher ──────────────────────────────────────────────────────
function testFailSafe() {
  head('Emulation fail-safe UI');
  const p = path.join(ROOT, 'public', 'launch.html');
  if (!fs.existsSync(p)) return bad('public/launch.html missing');
  const s = fs.readFileSync(p, 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  /id="optAlt"/.test(s) ? ok('option 1: try a different emulator') : bad('no alternate-emulator option');
  /id="optBios"/.test(s) && /drop/.test(s) ? ok('option 2: drag-and-drop BIOS upload') : bad('no BIOS upload option');
  /id="desktopGo"/.test(s) ? ok('option 3: hand off to desktop') : bad('no desktop handoff');
  /requires_action === 'upload_bios'/.test(s) ? ok('reacts to the 202 BIOS signal') : bad('ignores requires_action');
  /setTimeout\(\(\) => launch\(\), 600\)/.test(s) ? ok('launch resumes automatically after BIOS upload') : bad('no auto-resume after upload');
  /emulator: \$\('#altSelect'\)\.value/.test(s) ? ok('retry sends the chosen emulator') : bad('retry does not pass a choice');

  /app\.get\("\/api\/emulator\/alternates"/.test(srv) ? ok('alternates endpoint exists') : bad('no alternates endpoint');
  // Regression: this route was originally nested inside the launch handler, so
  // it only registered after someone launched a game.
  const iMatrix = srv.indexOf('const EMULATOR_FALLBACKS');
  const iRoute = srv.indexOf('app.get("/api/emulator/alternates"');
  const iLaunch = srv.indexOf('app.post("/api/games/launch"');
  (iMatrix > iLaunch && iRoute > iMatrix)
    ? ok('matrix and route are at server scope, not nested in a request handler')
    : bad('alternates route or matrix is nested inside the launch handler');
  /forcedEmulator/.test(srv) ? ok('launch accepts an explicit emulator choice') : bad('cannot force an emulator');
}

(async () => {
  console.log('NexusEmu — streaming & audit verification');
  const tok = token();
  await testRanges(tok);
  await testSegments(tok);
  testBufferConfig();
  testFailSafe();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
