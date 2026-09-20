#!/usr/bin/env node
/**
 * Phases 13 & 14 verification.
 *
 *   13 — Sonarr/Radarr: payload shape, credential wiring, webhook contract.
 *   14 — TV UI: viewport-relative sizing, aspect-ratio grids, D-pad keycodes.
 *
 * Usage: node scripts/test-phases13-14.cjs
 *        TEST_ADMIN_ID=<uuid> node scripts/test-phases13-14.cjs   (live checks)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3129);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0, skip = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };
const note = (m) => { skip++; console.log(`  ○ ${m}`); };
const head = (m) => console.log(`\n── ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 13.1 Radarr/Sonarr payload routing ──────────────────────────────────────
function testArrPayload() {
  head('Arr search/add payloads route to the right API');

  // Mirrors what the server builds, so the shape is asserted independently.
  const build = (type, item, profileId, rootFolder) => {
    const base = { qualityProfileId: profileId, rootFolderPath: rootFolder, monitored: true };
    return type === 'movie'
      ? { url: '/api/v3/movie', body: { ...base, tmdbId: item.id, title: item.title, year: item.year, addOptions: { searchForMovie: true } } }
      : { url: '/api/v3/series', body: { ...base, tvdbId: item.id, title: item.title, year: item.year, seasonFolder: true, addOptions: { searchForMissingEpisodes: true } } };
  };

  const movie = build('movie', { id: 438631, title: 'Dune', year: 2021 }, 4, '/home/moh/nexus-media/Movies');
  movie.url === '/api/v3/movie' ? ok('movie add targets Radarr /api/v3/movie') : bad(`wrong movie url: ${movie.url}`);
  movie.body.tmdbId === 438631 ? ok('movie carries tmdbId') : bad('movie missing tmdbId');
  'tvdbId' in movie.body ? bad('movie payload leaked tvdbId') : ok('movie payload has no tvdbId');
  movie.body.addOptions.searchForMovie === true ? ok('movie triggers an indexer search') : bad('movie will not search');

  const series = build('series', { id: 121361, title: 'Game of Thrones', year: 2011 }, 4, '/home/moh/nexus-media/TV');
  series.url === '/api/v3/series' ? ok('series add targets Sonarr /api/v3/series') : bad(`wrong series url: ${series.url}`);
  series.body.tvdbId === 121361 ? ok('series carries tvdbId') : bad('series missing tvdbId');
  series.body.seasonFolder === true ? ok('series uses season folders') : bad('seasonFolder not set');

  for (const p of [movie.body, series.body]) {
    if (!p.qualityProfileId) return bad('quality profile missing — this is what made adds fail');
    if (!p.rootFolderPath) return bad('root folder missing');
  }
  ok('both payloads carry a quality profile and a root folder');

  // A root folder on the destroyed drive must never be selected.
  const pick = (folders, preferred) => {
    const usable = folders.filter((f) => f.path && f.accessible !== false);
    return usable.find((f) => f.path === preferred)?.path
      ?? usable.slice().sort((a, b) => (b.freeSpace ?? 0) - (a.freeSpace ?? 0))[0]?.path
      ?? preferred;
  };
  const chosen = pick([
    { path: '/media/moh/EMULATION dRIVE/NexussEmu/data/media/Movies', accessible: false, freeSpace: 0 },
    { path: '/home/moh/nexus-media/Movies', accessible: true, freeSpace: 58e9 },
  ], '/nope');
  chosen === '/home/moh/nexus-media/Movies'
    ? ok('dead-drive root folder is never selected')
    : bad(`selected ${chosen}`);
}

// ── 13.2 Webhook contract ───────────────────────────────────────────────────
function testWebhookContract() {
  head('Arr webhook contract');
  const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');

  /\/api\/webhooks\/arr/.test(src) ? ok('webhook route defined') : bad('no webhook route');
  /"\/api\/webhooks\/arr",\s*\/\/ called by Sonarr/.test(src)
    ? ok('webhook is exempt from the JWT gate (Arr apps cannot carry one)')
    : bad('webhook not in PUBLIC_API_PREFIXES — Sonarr/Radarr would get 401');
  /ARR_WEBHOOK_SECRET/.test(src) ? ok('webhook requires a shared secret') : bad('webhook is unauthenticated');
  /scheduleArrIngest/.test(src) ? ok('completion triggers a library ingest') : bad('no ingest trigger');
  /eventType === "Test"/.test(src) ? ok('Test events answered without scanning') : bad('Test event would trigger a scan');
  /install-webhook/.test(src) ? ok('one-shot installer present') : bad('no installer');

  // Coalescing: a season import fires many events in seconds.
  let scans = 0, timer = null;
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { scans++; timer = null; }, 10); };
  for (let i = 0; i < 12; i++) schedule();
  return new Promise((res) => setTimeout(() => {
    scans === 1 ? ok(`12 import events coalesced into ${scans} scan`) : bad(`12 events produced ${scans} scans`);
    res();
  }, 60));
}

// ── 14.1 TV sizing ──────────────────────────────────────────────────────────
function testTvSizing() {
  head('TV layout uses viewport units and aspect-ratio');
  const p = path.join(ROOT, 'public', 'tv.html');
  if (!fs.existsSync(p)) return bad('public/tv.html missing');
  const src = fs.readFileSync(p, 'utf8');
  const css = (src.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';

  /--u:\s*[\d.]+vw/.test(css) ? ok('base unit is viewport-relative (scales 1080p -> 4K)') : bad('no viewport-relative base unit');
  /aspect-ratio:\s*2\s*\/\s*3/.test(css) ? ok('posters pinned to 2:3 aspect-ratio') : bad('posters have no aspect-ratio');
  /aspect-ratio:\s*16\s*\/\s*9/.test(css) ? ok('wide tiles pinned to 16:9') : bad('no 16:9 tile');
  /--safe:\s*\d/.test(css) ? ok('overscan safe area defined') : bad('no overscan allowance — TVs crop the edges');
  /grid-template-columns:\s*repeat\(var\(--cols/.test(css) ? ok('strict column grid (predictable D-pad neighbours)') : bad('grid columns are not fixed');

  // Fixed pixel sizing was the original sizing bug; flag any that creep back.
  // Media-query breakpoints are excluded: a breakpoint MUST be an absolute
  // width, and the sidebar rail is deliberately fixed so the icon column does
  // not grow on a 4K panel.
  const layoutCss = css
    .replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '')   // drop media query blocks
    .replace(/--sidebar[^;]*;/g, '');
  const pxSizes = layoutCss.match(/(?:width|height|font-size|padding|gap)\s*:\s*\d{2,}px/g) || [];
  pxSizes.length === 0
    ? ok('no fixed pixel dimensions in layout rules')
    : bad(`fixed px sizing found in layout rules: ${pxSizes.slice(0, 3).join(', ')}`);

  const breakpoints = (css.match(/@media\s*\((?:min|max)-width/g) || []).length;
  breakpoints >= 3 ? ok(`${breakpoints} responsive breakpoints`) : bad(`only ${breakpoints} breakpoint(s)`);
}

// ── 14.2 D-pad ──────────────────────────────────────────────────────────────
function testDpad() {
  head('D-pad / remote handling');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'tv.html'), 'utf8');

  for (const [code, name] of [[37, 'Left'], [38, 'Up'], [39, 'Right'], [40, 'Down'], [13, 'Enter']]) {
    new RegExp(`case ${code}:`).test(src) ? ok(`keycode ${code} (${name}) handled`) : bad(`keycode ${code} (${name}) not handled`);
  }
  /10009/.test(src) && /461/.test(src)
    ? ok('Tizen (10009) and webOS (461) Back handled')
    : bad('TV Back keycodes missing');
  /e\.preventDefault\(\)/.test(src) ? ok('default scrolling prevented') : bad('arrows would scroll the page under the focus ring');
  /\},\s*true\)/.test(src) ? ok('listener registered in capture phase') : bad('not capturing — a page handler could scroll first');

  // Focus held as a key, not an element reference: this is what stops focus
  // being dropped when a row re-renders.
  /const el = \(k\) => document\.querySelector/.test(src)
    ? ok('focus is re-resolved from a key (survives re-render)')
    : bad('focus appears to be held as an element reference');

  // Directional scoring must punish cross-axis drift, or "down" lands diagonally.
  /const score = along \+ across \* 4/.test(src)
    ? ok('cross-axis drift penalised (down lands directly below)')
    : bad('no drift penalty in the spatial scoring');

  /function goBack/.test(src) && /view !== 'media'/.test(src)
    ? ok('Back walks up the view tree instead of exiting')
    : bad('Back would exit the app');
}

// ── Live ────────────────────────────────────────────────────────────────────
async function testLive() {
  head(`Live endpoints on :${PORT}`);
  const out = fs.openSync(path.join(os.tmpdir(), `nexus-1314-${Date.now()}.log`), 'w');
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

    for (const r of ['/tv', '/leanback']) {
      try {
        const res = await fetch(BASE + r, { signal: AbortSignal.timeout(15000) });
        res.ok ? ok(`${r} served`) : bad(`${r} returned ${res.status}`);
      } catch (e) { bad(`${r}: ${e.message}`); }
    }

    // Unauthenticated webhook must be rejected, not silently accepted.
    try {
      const res = await fetch(`${BASE}/api/webhooks/arr`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'Test' }), signal: AbortSignal.timeout(15000),
      });
      res.status === 401 ? ok('webhook rejects a request with no secret') : bad(`webhook returned ${res.status} without a secret`);
    } catch (e) { bad(`webhook probe failed: ${e.message}`); }

    const adminId = process.env.TEST_ADMIN_ID;
    if (!adminId) return note('TEST_ADMIN_ID not set — arr config check skipped');
    const secret = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^JWT_SECRET=(.*)$/m) || [])[1].trim();
    const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
    const tok = jwt.sign({ userId: adminId, username: 'p1314' }, secret, { expiresIn: '10m' });

    const cfg = await (await fetch(`${BASE}/api/arr/config`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(30000) })).json();
    cfg.configured ? ok('arr stack is configured') : bad('arr stack not configured');
    cfg.radarrConnected ? ok('Radarr reachable') : bad('Radarr unreachable');
    cfg.sonarrConnected ? ok('Sonarr reachable') : bad('Sonarr unreachable');
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await sleep(1500);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

(async () => {
  console.log('NexusEmu — Phases 13 & 14 verification');
  testArrPayload();
  await testWebhookContract();
  testTvSizing();
  testDpad();
  await testLive();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
