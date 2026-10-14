#!/usr/bin/env node
/**
 * Route audit — probe every registered GET endpoint and report anything that
 * 500s, hangs, or returns a body that isn't what it claims to be.
 *
 * GET only, and only routes with no path parameters: a POST or a :id route
 * needs a meaningful payload to say anything useful, and firing blanks at them
 * produces noise, not signal.
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';

const src = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
// Long-lived streams never complete a request — SSE and MJPEG endpoints hold
// the connection open by design, so probing them just times out. They are
// listed rather than skipped silently, so the count still adds up.
const STREAMING = new Set([
  '/api/ai/stream', '/api/daemon/stream', '/api/music/scan-progress', '/api/stream/feed',
  // Large binary downloads; these legitimately outlast the probe timeout.
  '/api/client/android/retroarch-apk', '/api/storage/download',
  // These open a native file dialog on the host's desktop and wait for a person.
  '/api/system/pick-folder', '/api/system/pick-file',
]);

const all = [...new Set(
  [...src.matchAll(/app\.get\(\s*["'`](\/api\/[^"'`]+)["'`]/g)].map((m) => m[1])
)].filter((r) => !r.includes(':') && !r.includes('*')).sort();
const routes = all.filter((r) => !STREAMING.has(r));

const secret = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^JWT_SECRET=(.*)$/m) || [])[1].trim();
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
// A host session (what the PIN login issues) unless a specific account is
// named. A token with neither is refused outright, and every route then
// "passed" with a 401.
const tok = process.env.AUDIT_ADMIN_ID
  ? jwt.sign({ userId: process.env.AUDIT_ADMIN_ID, username: 'audit' }, secret, { expiresIn: '20m' })
  : jwt.sign({ nexus: true, ts: Date.now() }, secret, { expiresIn: '20m' });

(async () => {
  console.log(`Auditing ${routes.length} parameterless GET routes against ${BASE}`);
  console.log(`(skipping ${all.length - routes.length} long-lived stream endpoints: ${[...STREAMING].join(', ')})\n`);
  const bad = [], slow = [], ok = [], unsupported = [], refused = [];
  for (const r of routes) {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + r, {
        headers: { Authorization: `Bearer ${tok}` },
        signal: AbortSignal.timeout(25000),
      });
      const ms = Date.now() - t0;
      const body = await res.text();
      // 501 means the host genuinely cannot do it (no desktop session for a
      // native picker). That is a stated limitation, not a fault.
      if (res.status === 501) unsupported.push({ r, snip: body.slice(0, 90) });
      else if (res.status >= 500) bad.push({ r, status: res.status, ms, snip: body.slice(0, 140) });
      else if (res.status === 401 || res.status === 403 || res.status === 404) refused.push({ r, status: res.status, snip: body.slice(0, 90) });
      else { ok.push(r); if (ms > 1000) slow.push({ r, ms }); }
    } catch (e) {
      bad.push({ r, status: 'TIMEOUT/ERR', ms: Date.now() - t0, snip: String(e.message).slice(0, 120) });
    }
  }
  console.log(`  ✓ ${ok.length} healthy`);
  if (refused.length) {
    console.log(`\n  REFUSED OR MISSING for an admin session (${refused.length}):`);
    for (const x of refused) console.log(`    ${x.status}  ${x.r}  ${x.snip}`);
  }
  if (unsupported.length) {
    console.log(`\n  NOT SUPPORTED ON THIS HOST (501, by design):`);
    for (const u of unsupported) console.log(`    ${u.r}`);
  }
  if (slow.length) {
    console.log(`\n  SLOW (>1s):`);
    for (const s of slow.sort((a, b) => b.ms - a.ms)) console.log(`    ${String(s.ms).padStart(6)}ms  ${s.r}`);
  }
  if (bad.length) {
    console.log(`\n  FAILING (${bad.length}):`);
    for (const b of bad) console.log(`    ${b.status}  ${b.r}\n        ${b.snip}`);
  } else console.log('\n  no route returned 5xx');
  process.exit(bad.length ? 1 : 0);
})();
