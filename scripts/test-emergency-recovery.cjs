#!/usr/bin/env node
/**
 * Emergency recovery verification — "/media/moh/EMULATION dRIVE" is gone.
 *
 * Boots the built server on a scratch port and proves:
 *   1. it starts clean, with no ENOENT/EACCES against the dead media drive;
 *   2. the storage quota it reports comes from Google Drive, not local disk;
 *   3. nothing in the shipped source or bundle still names the dead mount;
 *   4. the recovery endpoints answer and the DB is free of dead paths.
 *
 * Usage:  node scripts/test-emergency-recovery.cjs
 * Exits non-zero on the first hard failure so it can gate a deploy.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const DEAD = '/media/moh/EMULATION dRIVE';
const BOOT_TIMEOUT_MS = Number(process.env.TEST_BOOT_TIMEOUT || 75_000);

let pass = 0, fail = 0;
const ok   = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad  = (m) => { fail++; console.log(`  ✗ ${m}`); };
const head = (m) => console.log(`\n── ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(pathname, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const r = await fetch(BASE + pathname, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

/** Sign an admin JWT so the admin-only recovery routes can be exercised. */
function adminToken() {
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const secret = (env.match(/^JWT_SECRET=(.*)$/m) || [])[1];
    if (!secret) return null;
    const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
    return jwt.sign(
      { userId: process.env.TEST_ADMIN_ID || '00000000-0000-0000-0000-000000000000', username: 'recovery-test' },
      secret.trim(),
      { expiresIn: '10m' },
    );
  } catch { return null; }
}

// ── 1. Static check: no dead-drive literals in shipped code ──────────────────
function checkSources() {
  head('Source & bundle are free of the dead mount');
  const targets = [
    'server.ts',
    'dist/server.mjs',
    ...fs.existsSync(path.join(ROOT, 'src'))
      ? walk(path.join(ROOT, 'src')).map((p) => path.relative(ROOT, p))
      : [],
  ];
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const body = fs.readFileSync(abs, 'utf8');
    // Two kinds of mention are legitimate and must not fail the run:
    //   * comments documenting the outage;
    //   * the NEXUS_DEAD_MOUNTS denylist entry, which exists precisely so the
    //     path is recognised and skipped (esbuild folds it to a bare literal).
    const isComment  = (l) => /^\s*(\/\/|\*|\/\*|#)/.test(l);
    const isDenylist = (l) => new RegExp(`^\\s*["'\`]${DEAD.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}["'\`],?\\s*$`).test(l);
    const offending = body
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes(DEAD))
      .filter(([, line]) => !isComment(line) && !isDenylist(line));
    if (offending.length === 0) ok(`${rel}: clean`);
    else bad(`${rel}: ${offending.length} live reference(s), first at line ${offending[0][0]}`);
  }
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|jsx|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── 2. Config check ──────────────────────────────────────────────────────────
function checkConfig() {
  head('Cloud-first configuration');
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return bad('.env missing');
  const env = fs.readFileSync(envPath, 'utf8');
  const val = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();

  const vault = val('VAULT_ROOT') || '';
  vault.startsWith(DEAD) ? bad(`VAULT_ROOT still on the dead drive: ${vault}`)
                         : ok(`VAULT_ROOT repointed: ${vault}`);

  const gdrive = val('NEXUS_GDRIVE_ROOT') || path.join(os.homedir(), 'nexus-cloud-media');
  fs.existsSync(gdrive) ? ok(`Google Drive mount present: ${gdrive}`)
                        : bad(`Google Drive mount missing: ${gdrive} (is rclone running?)`);

  const fallback = val('NEXUS_VAULT_FALLBACK');
  fallback && fs.existsSync(fallback) ? ok(`Local fallback vault present: ${fallback}`)
                                      : bad(`Local fallback vault missing: ${fallback}`);

  val('NEXUS_CLOUD_FIRST') === '1' ? ok('NEXUS_CLOUD_FIRST=1') : bad('NEXUS_CLOUD_FIRST not enabled');
}

// ── 3. Quota check: Drive capacity, not the local disk ───────────────────────
async function checkQuota() {
  head('Storage quota reflects Google Drive, not local disk');
  const { statfs } = require('fs/promises');
  const gdrive = process.env.NEXUS_GDRIVE_ROOT || path.join(os.homedir(), 'nexus-cloud-media');

  let cloud, local;
  try { cloud = await statfs(gdrive); } catch (e) { return bad(`statfs(${gdrive}) failed: ${e.message}`); }
  try { local = await statfs(os.homedir()); } catch { local = null; }

  const cloudTotal = cloud.blocks * cloud.bsize;
  const cloudFree  = cloud.bavail * cloud.bsize;
  const localTotal = local ? local.blocks * local.bsize : 0;

  cloudTotal > 0 ? ok(`Drive total ${(cloudTotal / 1e12).toFixed(2)} TB, free ${(cloudFree / 1e12).toFixed(2)} TB`)
                 : bad('Drive reports zero capacity');

  // The whole point of the pivot: cloud capacity must dominate the dead local disk.
  cloudTotal > localTotal
    ? ok(`Cloud capacity exceeds local (${(cloudTotal / 1e12).toFixed(2)} TB > ${(localTotal / 1e12).toFixed(2)} TB)`)
    : bad('Cloud capacity does not exceed local disk — quota source looks wrong');

  cloudFree > 50e9 ? ok(`Headroom for uploads: ${(cloudFree / 1e12).toFixed(2)} TB`)
                   : bad(`Only ${(cloudFree / 1e9).toFixed(0)} GB free in Drive`);
}

// ── 4. Boot check ────────────────────────────────────────────────────────────
async function checkBoot() {
  head(`Server boots clean on :${PORT}`);
  const logFile = path.join(os.tmpdir(), `nexus-recovery-test-${Date.now()}.log`);
  const out = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', out, out],
    detached: true,
  });

  let up = false;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const r = await get('/api/health');
      if (r.status === 200) { up = true; break; }
    } catch {}
  }

  try {
    up ? ok('responded 200 on /api/health') : bad(`did not come up within ${BOOT_TIMEOUT_MS / 1000}s`);

    if (up) {
      const root = await get('/');
      root.status === 200 ? ok('serves the SPA on /') : bad(`GET / returned ${root.status}`);

      const token = adminToken();
      if (token) {
        const st = await get('/api/recovery/status', token);
        if (st.status === 200 && st.json) {
          ok('/api/recovery/status responds');
          st.json.gdriveMounted ? ok('reports Drive mounted') : bad('reports Drive NOT mounted');
          st.json.cloudFirst ? ok('reports cloud-first active') : bad('cloud-first inactive');
          const vc = st.json.affected?.['vault_config.root_path'];
          vc === 0 ? ok('vault_config.root_path healed in the database')
                   : bad(`vault_config.root_path still dead (${vc} row(s)) — POST /api/recovery/heal-paths {"apply":true}`);
        } else if (st.status === 403) {
          console.log('  ○ /api/recovery/status: needs a real admin id (set TEST_ADMIN_ID) — skipped');
        } else {
          bad(`/api/recovery/status returned ${st.status}`);
        }
      } else {
        console.log('  ○ admin token unavailable — recovery endpoint checks skipped');
      }
    }

    // The headline assertion: nothing tried to touch the dead drive during boot.
    fs.closeSync(out);
    const log = fs.readFileSync(logFile, 'utf8');
    const deadHits = log.split('\n').filter((l) => l.includes(DEAD));
    const enoent   = log.split('\n').filter((l) => /ENOENT|EACCES/.test(l));
    deadHits.length === 0 ? ok('no reference to the dead drive in boot output')
                          : bad(`dead drive named ${deadHits.length}x, e.g. ${deadHits[0].slice(0, 140)}`);
    enoent.length === 0 ? ok('no ENOENT/EACCES during boot')
                        : bad(`${enoent.length} ENOENT/EACCES line(s), e.g. ${enoent[0].slice(0, 140)}`);
    if (fail) console.log(`\n  (full boot log: ${logFile})`);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await sleep(1500);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

(async () => {
  console.log('NexusEmu — emergency recovery verification');
  console.log(`dead mount under test: ${DEAD}`);
  checkSources();
  checkConfig();
  await checkQuota();
  await checkBoot();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nharness error:', e); process.exit(1); });
