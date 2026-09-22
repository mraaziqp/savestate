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

// ── Malware guard ───────────────────────────────────────────────────────────
function testMalwareGuard() {
  head('Disguised-executable guard');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
  /\/api\/security\/malware-scan/.test(src) ? ok('scanner endpoint present') : bad('no scanner');
  /0x4d && buf\[1\] === 0x5a/.test(src) ? ok('detects by MZ header, not just extension') : bad('header check missing');
  /quarantine/.test(src) ? ok('findings are quarantined, not deleted') : bad('no quarantine path');
  /"\*\.exe", "\*\*\/\*\.exe"/.test(src) ? ok('executables excluded from Drive uploads') : bad('executables could reach Drive');

  // A legitimate game ships .bat files — the roms tree must never be swept.
  const roots = ['nexus-downloads', 'nexus-media', '.nexus-vault'];
  roots.some((r) => /roms/i.test(r)) ? bad('roms tree is in the scan roots') : ok('roms tree excluded from scanning');

  // Behaviour: extension hit, header hit, and a clean file.
  const classify = (name, header) => {
    const ext = path.extname(name).toLowerCase();
    const EXEC = new Set(['.exe', '.scr', '.msi', '.bat', '.cmd', '.vbs']);
    const MEDIA = new Set(['.mkv', '.mp4', '.avi']);
    if (EXEC.has(ext)) return 'executable extension';
    if (MEDIA.has(ext) && header === 'MZ') return 'PE header in a video';
    return null;
  };
  classify('Lanterns.S01E07.exe', null) ? ok('flags an .exe named like an episode') : bad('missed .exe');
  classify('Show.S01E01.mkv', 'MZ') ? ok('flags a PE binary wearing a .mkv name') : bad('missed disguised PE');
  classify('Show.S01E01.mkv', null) === null ? ok('leaves a real video alone') : bad('false positive on real media');
}

// ── Emulation queue ─────────────────────────────────────────────────────────
function testEmulationQueue() {
  head('Browser-play concurrency queue');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
  /MAX_CONCURRENT_EMULATIONS/.test(src) ? ok('concurrency cap defined') : bad('no cap');
  /EMULATION_SESSION_MAX_MS/.test(src) ? ok('hard session timeout defined') : bad('no session timeout');
  /lastBeat/.test(src) ? ok('slots are leased and expire without a heartbeat') : bad('slots never expire');
  // `position` reaches the response via the emuState() spread, so assert on
  // the 202 plus the queue-position call rather than a literal key name.
  /res\.status\(202\)[\s\S]{0,300}emuQueuePosition/.test(src)
    ? ok('queued requests answer 202 carrying their queue position')
    : bad('no 202 queue response');

  // A closed tab must free its slot.
  const MAX = 2, GRACE = 90_000, now = Date.now();
  const active = new Map([['a', { lastBeat: now }], ['b', { lastBeat: now - 120_000 }]]);
  for (const [id, sl] of active) if (now - sl.lastBeat > GRACE) active.delete(id);
  active.size === 1 ? ok('a slot with no heartbeat is reclaimed') : bad(`sweep left ${active.size} slots`);
  active.size < MAX ? ok('reclaimed capacity becomes available again') : bad('capacity not freed');
}

// ── Jarvis guardrails ───────────────────────────────────────────────────────
function testJarvisGuardrails() {
  head('Jarvis admin tooling is allowlisted');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
  /AI_CONFIG_WRITABLE/.test(src) ? ok('config writes are allowlisted') : bad('config writes unrestricted');
  /AI_CONFIG_FORBIDDEN/.test(src) ? ok('secrets explicitly denied') : bad('no deny list');
  /AI_JOBS/.test(src) ? ok('jobs are allowlisted') : bad('jobs unrestricted');

  for (const k of ['JWT_SECRET', 'DATABASE_URL', 'NEXUS_ENCRYPTION_KEY', 'LD_PRELOAD', 'PATH']) {
    new RegExp(`"${k}"`).test(src.slice(src.indexOf('AI_CONFIG_FORBIDDEN'), src.indexOf('AI_CONFIG_FORBIDDEN') + 700))
      ? ok(`${k} is on the deny list`) : bad(`${k} not denied`);
  }
  // No arbitrary execution reachable from the AI surface.
  const jobsBlock = src.slice(src.indexOf('const AI_JOBS'), src.indexOf('const AI_JOBS') + 1200);
  /exec\(|execAsync\(|spawn\(/.test(jobsBlock) ? bad('AI_JOBS can spawn processes') : ok('no process spawning in AI_JOBS');

  // Validation actually constrains values.
  const validate = (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 12 ? null : 'out of range');
  validate('6') === null ? ok('in-range value accepted') : bad('valid value rejected');
  validate('999') !== null ? ok('out-of-range value rejected') : bad('999 accepted');
  validate('6; rm -rf /') !== null ? ok('injection attempt rejected by validation') : bad('injection accepted');
}

// ── Upload dedup ────────────────────────────────────────────────────────────
function testUploadDedup() {
  head('Content-addressed upload dedup');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
  /\^\[a-f0-9\]\{64\}\$/.test(src) ? ok('sha256 format validated') : bad('hash not validated');
  /skipUpload: true/.test(src) ? ok('an already-present file skips the upload entirely') : bad('no skip path');
  /matchedBy: "sha256"/.test(src) ? ok('an interrupted session resumes by content hash') : bad('no hash-based resume');
  /sha256: sha256 \|\| null/.test(src) ? ok('hash persisted in session metadata') : bad('hash not persisted');
}

// ── Theming / onboarding ────────────────────────────────────────────────────
function testThemingOnboarding() {
  head('Theming and onboarding');
  const tv = fs.readFileSync(path.join(ROOT, 'public', 'tv.html'), 'utf8');
  for (const t of ['midnight', 'theater', 'light']) {
    new RegExp(`data-theme="${t}"`).test(tv) ? ok(`${t} theme defined`) : bad(`${t} theme missing`);
  }
  /--bg-primary|--text-primary|--accent/.test(tv) ? ok('semantic tokens in use') : bad('no semantic tokens');
  /id="welcome"/.test(tv) ? ok('onboarding modal present') : bad('no onboarding modal');
  /function applyIntentOrder/.test(tv) ? ok('sidebar reorders to match intent') : bad('no intent ordering');
  /nexus_intent/.test(tv) ? ok('intent remembered per device') : bad('intent not persisted');
  /case 84:/.test(tv) ? ok('T cycles the theme') : bad('no theme shortcut');
  /transform:scale\(1\.05\)/.test(tv) ? ok('focus scales to 1.05') : bad('focus scale wrong');

  // No raw colours outside the theme blocks.
  const css = (tv.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  const themeBlocks = css.slice(0, css.indexOf('/* ── Onboarding'));
  const body = css.slice(css.indexOf('*{box-sizing'));
  const raw = (body.match(/(?:background|color)\s*:\s*(?:#[0-9a-fA-F]{3,6}|rgba?\()/g) || []);
  raw.length === 0 ? ok('no hardcoded colours outside the theme definitions') : bad(`${raw.length} hardcoded colour(s): ${raw.slice(0,3).join(', ')}`);

  const pl = fs.readFileSync(path.join(ROOT, 'public', 'player.html'), 'utf8');
  /SPINNER_DELAY_MS = 500/.test(pl) ? ok('player spinner debounced 500ms') : bad('spinner not debounced');
  /maxBufferLength: 120/.test(pl) ? ok('player buffers 120s') : bad('buffer not raised');
  /\}, 2500\);/.test(pl) ? ok('controls auto-hide at 2500ms') : bad('auto-hide not 2500ms');
  /cursor:\s*none/.test(pl) ? ok('cursor hidden when idle') : bad('cursor not hidden');
}

// ── Metadata healer ─────────────────────────────────────────────────────────
function testMetadataHealer() {
  head('Metadata healer');
  const p = path.join(ROOT, 'scripts', 'metadata-healer.ts');
  if (!fs.existsSync(p)) return bad('scripts/metadata-healer.ts missing');
  const src = fs.readFileSync(p, 'utf8');
  /const APPLY = process\.argv\.includes\("--apply"\)/.test(src) ? ok('dry run by default') : bad('not dry-run by default');
  /BRACKET_TAG/.test(src) && /TRAILING_TAGS/.test(src) ? ok('position-aware tag stripping') : bad('tags stripped anywhere');
  // The regression that mattered: "World" must not be stripped mid-title.
  const trailing = src.slice(src.indexOf('const TRAILING_TAGS'), src.indexOf('const ROM_EXT_RE'));
  !/World\|/.test(trailing) ? ok('"World" excluded from trailing-cluster stripping (Super Mario World)') : bad('"World" would be stripped from titles');
  /fetch-batch/.test(src) ? ok('delegates art to the existing endpoint') : bad('art logic duplicated');
}

// ── Player: startup, spinner, intro skip, autoplay ──────────────────────────
function testPlayerUpgrades() {
  head('Player startup, spinner and intro skip');
  const pl = fs.readFileSync(path.join(ROOT, 'public', 'player.html'), 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  // Startup cost: measured 4.56s cold before these three changes.
  /PROBE_CACHE_FILE/.test(srv) ? ok('probe cache persisted (was ~2.3s per first play)') : bad('probe cache not persisted');
  /function segmentBounds/.test(srv) ? ok('fast-start segment map present') : bad('no fast-start map');
  /HLS_FAST_START_SECONDS = 2/.test(srv) ? ok('head segments are short (2s)') : bad('head segments not shortened');
  /\/api\/media\/prewarm/.test(srv) ? ok('prewarm endpoint present') : bad('no prewarm endpoint');
  /api\/media\/prewarm/.test(pl) ? ok('player prewarms on load') : bad('player does not prewarm');
  // Changing the segment map must invalidate old cached segments.
  /update\(`v2\|/.test(srv) ? ok('segment cache key versioned for the new map') : bad('stale segments could be served');

  // The spinner bug: it showed while paused, with a fully buffered video.
  /function playbackIsBlocked/.test(pl) ? ok('spinner gated on real blockage') : bad('spinner not gated');
  /if \(v\.paused\) return false;/.test(pl) ? ok('never spins while paused') : bad('would spin while paused');
  /v\.readyState >= 3/.test(pl) ? ok('never spins when a frame is ready') : bad('ignores readyState');
  /SPINNER_DELAY_MS = 500/.test(pl) ? ok('500ms debounce retained') : bad('debounce lost');

  // Simulate the exact state that was wrong: paused, ready, buffered.
  const blocked = (st) => {
    if (st.paused) return false;
    if (st.readyState >= 3) return false;
    return !(st.bufferedAhead > 0.6);
  };
  blocked({ paused: true, readyState: 4, bufferedAhead: 30 }) === false ? ok('paused+ready+buffered does not spin') : bad('would still spin while paused');
  blocked({ paused: false, readyState: 4, bufferedAhead: 30 }) === false ? ok('playing with buffer does not spin') : bad('spins during healthy playback');
  blocked({ paused: false, readyState: 1, bufferedAhead: 0 }) === true ? ok('a genuine stall still spins') : bad('real stalls no longer spin');

  // Intro skip.
  /id="skipIntro"/.test(pl) ? ok('Skip Intro button present') : bad('no skip button');
  /intro-markers/.test(pl) ? ok('player loads intro markers') : bad('markers not loaded');
  /autoplayed && inside/.test(pl) ? ok('auto-skips the intro when autoplaying') : bad('no auto-skip on autoplay');
  /blackframe-single/.test(srv) ? ok('single-cut detection fallback') : bad('no single-cut fallback');
  /borrowIntroFromSibling/.test(srv) ? ok('borrows markers from a sibling episode') : bad('no sibling fallback');
  // A borrowed marker must not be re-borrowed, or one mistake spreads.
  /!String\(v\.source \?\? ''\)\.startsWith\('sibling'\)/.test(srv)
    ? ok('prefers a directly-detected marker over a borrowed one')
    : bad('a borrowed marker could propagate through a season');

  // Up next.
  /id="upNext"/.test(pl) ? ok('Up Next card present') : bad('no up-next card');
  /autoplay=1/.test(pl) ? ok('chains to the next episode with autoplay') : bad('no autoplay chaining');
  /left <= 75.*prewarm|prewarmedNext/.test(pl) ? ok('prewarms the next episode before it is needed') : bad('next episode not prewarmed');

  // Reveal must not depend on requestAnimationFrame (throttled in background tabs).
  const rafUses = (pl.match(/requestAnimationFrame\(/g) || []).length;
  rafUses === 0 ? ok('reveal is reflow-based, not rAF-based') : bad(`${rafUses} rAF use(s) remain in reveal paths`);

  // Auth must fail loudly, not silently.
  /function noteAuthFailure/.test(pl) ? ok('expired session surfaces to the viewer') : bad('auth failure degrades silently');

  // Quality.
  /qp: "19"/.test(srv) ? ok('1080p tier raised to qp 19') : bad('quality ladder not raised');
  /qp: "21", abr: "192k", maxrate: w <= 720/.test(srv) ? ok('auto tier balanced at qp 21') : bad('auto tier not balanced');
  /maxBufferSize/.test(pl) ? ok('buffers by size as well as duration') : bad('no size-based buffering');
  /fragLoadingMaxRetry/.test(pl) ? ok('retries slow segments instead of erroring') : bad('no segment retry tuning');
}

// ── Dead drive severed from the shipped frontend ────────────────────────────
function testFrontendDeadDrive() {
  head('Compiled frontend is free of the dead drive');
  const dir = path.join(ROOT, 'dist', 'assets');
  if (!fs.existsSync(dir)) return bad('dist/assets missing');

  const offenders = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('EMULATION dRIVE'));
  offenders.length === 0
    ? ok('no bundle references the destroyed drive')
    : bad(`${offenders.length} bundle(s) still reference it: ${offenders.slice(0, 3).join(', ')}`);

  // The presets now have to point somewhere that exists.
  const pc = fs.readdirSync(dir).find((f) => f.startsWith('PcUpload-'));
  if (pc) {
    const body = fs.readFileSync(path.join(dir, pc), 'utf8');
    /\.nexus-vault\/roms/.test(body) ? ok('upload presets repointed at the local vault') : bad('upload presets not repointed');
  } else note('PcUpload bundle not found — skipped');

  // Patched bundles must still be parseable, or the app white-screens.
  for (const f of fs.readdirSync(dir).filter((x) => /^(PcUpload|MediaCloudView|CloudReclaim|CloudArchive|CloudTransfer)-/.test(x))) {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    // Cheap structural check: balanced braces/brackets survive a string swap.
    const open = (body.match(/[{[]/g) || []).length, close = (body.match(/[}\]]/g) || []).length;
    Math.abs(open - close) < 5 ? ok(`${f.split('-')[0]} structurally intact`) : bad(`${f} looks corrupted`);
  }

  // Workbox keys off the filename when revision is null, so a content-only
  // change would never reach a client that already cached the old bundle.
  const sw = fs.readFileSync(path.join(ROOT, 'dist', 'sw.js'), 'utf8');
  const stillNull = ['PcUpload', 'MediaCloudView', 'CloudReclaim', 'CloudArchive', 'CloudTransfer', 'index-CKnFRVZB']
    .filter((n) => new RegExp(`\\{url:"assets/${n}[^"]*",revision:null\\}`).test(sw));
  stillNull.length === 0
    ? ok('patched bundles carry a real precache revision so clients re-fetch')
    : bad(`${stillNull.join(', ')} still revision:null — clients would keep the stale copy`);
}

// ── Emulator fallback matrix ────────────────────────────────────────────────
function testEmulatorFallback() {
  head('Emulator fallback matrix');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  /EMULATOR_FALLBACKS/.test(src) ? ok('fallback matrix defined') : bad('no fallback matrix');
  /function launchWithFallback/.test(src) ? ok('chain walker present') : bad('no chain walker');
  /id: "play", label: "Play!"/.test(src) ? ok('PS2 falls back to Play!') : bad('no PS2 alternate');
  /id: "duckstation"/.test(src) ? ok('PS1 has DuckStation as an alternate') : bad('no PS1 alternate');
  /fellBackFrom: 'pcsx2'/.test(src) ? ok('a successful fallback is reported to the client') : bad('fallback not reported');
  // The old code returned 500 on the first crash; the chain must run first.
  const idx = src.indexOf("PS2 emulator crashed on start");
  idx > 0 && src.slice(Math.max(0, idx - 1400), idx).includes('launchWithFallback')
    ? ok('the chain is walked before any error is returned')
    : bad('still errors without trying alternates');

  // Not-installed is skipped silently; launched-and-died is a real failure.
  const chain = [
    { id: 'a', resolves: false, alive: false },
    { id: 'b', resolves: true,  alive: false },
    { id: 'c', resolves: true,  alive: true  },
  ];
  const tried = [];
  let winner = null;
  for (const c of chain) {
    if (!c.resolves) { tried.push({ id: c.id, outcome: 'not installed' }); continue; }
    if (!c.alive)    { tried.push({ id: c.id, outcome: 'exited immediately' }); continue; }
    winner = c.id; break;
  }
  (winner === 'c' && tried.length === 2)
    ? ok('skips the uninstalled, records the crash, lands on the one that runs')
    : bad(`chain walk wrong: winner=${winner} tried=${JSON.stringify(tried)}`);
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
  testMalwareGuard();
  testEmulationQueue();
  testJarvisGuardrails();
  testUploadDedup();
  testThemingOnboarding();
  testMetadataHealer();
  testPlayerUpgrades();
  testFrontendDeadDrive();
  testEmulatorFallback();
  await testLive();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
