/**
 * Phase 8, 9, & 10 Integration Test Suite
 * 
 * Verifies:
 * 1. Phase 8: AwehChat Ecosystem Integration & Memory Leak Remediation
 *    - HTTP/HTTPS connection pooling with bounded sockets.
 *    - Dead connection garbage collection and WebSocket tracking.
 *    - Master contact ingestion with query filtering (?q= and ?online=true).
 *    - 1-Click Co-Op invite dispatching to AwehChat DM.
 * 2. Phase 9: Netflix-Style Game Discovery & Gemini AI Concierge
 *    - GET /api/games/recommendations structured payload with topPick, reasoning narrative, and tags.
 *    - 1-hour recommendation cache hit verification.
 * 3. Phase 10: Native Windows Desktop Host Packaging
 *    - Execution of scripts/build-windows-exe.js.
 *    - Verification of generated Windows service scripts (sc.exe create nexus-service).
 *    - Verification of registry protocol handlers (nexus://).
 *    - Verification of packaging manifest.json.
 * 4. Zero-Regression Health & Media Streaming Range Check.
 */

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let passedTests = 0;
let failedTests = 0;

function pass(name) {
  passedTests++;
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  failedTests++;
  console.error(`  ✗ ${name}: ${err.message || err}`);
}

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });

    req.on('error', reject);

    if (postData) {
      if (typeof postData === 'string') {
        req.write(postData);
      } else {
        req.write(JSON.stringify(postData));
      }
    }
    req.end();
  });
}

async function runTests() {
  console.log('===============================================================');
  console.log(' Starting Integration Diagnostic Suite: Phases 8, 9, & 10      ');
  console.log('===============================================================');

  const repoRoot = path.resolve(__dirname, '..');

  // ───────────────────────────────────────────────────────────────────────────
  // Group 1: Phase 8 - AwehChat Ecosystem & Memory Leak Remediation
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Group 1: Phase 8 - AwehChat Ecosystem & Memory Leak Remediation ---');

  // Test 1.1: AwehChat client module verification
  try {
    const awehchatPath = path.join(repoRoot, 'src', 'utils', 'awehchat.ts');
    assert.strictEqual(fs.existsSync(awehchatPath), true, 'awehchat.ts must exist');
    const content = fs.readFileSync(awehchatPath, 'utf8');
    assert.ok(content.includes('maxSockets: 20'), 'Connection pool must bound sockets');
    assert.ok(content.includes('timeout: 8000'), 'Connection pool must enforce timeouts');
    assert.ok(content.includes('startResourceGarbageCollector'), 'Garbage collector must be defined');
    assert.ok(content.includes('trackWebSocket'), 'WebSocket tracker must be exported');
    pass('Phase 8.1: AwehChat bounded connection pool & GC scavenger defined in src/utils/awehchat.ts');
  } catch (err) {
    fail('Phase 8.1: AwehChat client module verification', err);
  }

  // Test 1.2: GET /api/integrations/ecosystem/contacts
  try {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/integrations/ecosystem/contacts',
      method: 'GET',
    });
    assert.strictEqual(res.statusCode, 200, `Expected HTTP 200, got ${res.statusCode}: ${res.body}`);
    assert.strictEqual(res.json?.ok, true, 'Response must be ok');
    assert.ok(Array.isArray(res.json?.contacts), 'contacts must be an array');
    assert.ok(res.json.contacts.length > 0, 'Contacts array must not be empty');
    pass(`Phase 8.2: GET /api/integrations/ecosystem/contacts returned ${res.json.contacts.length} contacts`);
  } catch (err) {
    fail('Phase 8.2: Ingest ecosystem contacts', err);
  }

  // Test 1.3: Contact Search Filtering (?q=abduraziq)
  try {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/integrations/ecosystem/contacts?q=abduraziq',
      method: 'GET',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.json.contacts.some((c) => c.name.toLowerCase().includes('abduraziq') || c.id.includes('abduraziq')),
      'Should filter contacts matching query');
    pass('Phase 8.3: Ecosystem contacts search filtering (?q=...) verified');
  } catch (err) {
    fail('Phase 8.3: Ecosystem contacts search filtering', err);
  }

  // Test 1.4: Contact Online Filtering (?online=true)
  try {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/integrations/ecosystem/contacts?online=true',
      method: 'GET',
    });
    assert.strictEqual(res.statusCode, 200);
    const allOnline = res.json.contacts.every((c) => c.online === true);
    assert.strictEqual(allOnline, true, 'All returned contacts must have online=true');
    pass(`Phase 8.4: Ecosystem contacts online filter verified (${res.json.contacts.length} online)`);
  } catch (err) {
    fail('Phase 8.4: Ecosystem contacts online filter', err);
  }

  // Test 1.5: POST /api/integrations/ecosystem/invite
  try {
    const invitePayload = {
      contactId: 'usr_abduraziq',
      type: 'coop',
      inviteUrl: 'nexus://join/session_diag_test_88',
      title: 'Super Metroid Co-Op',
    };
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/integrations/ecosystem/invite',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, invitePayload);

    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.strictEqual(res.json?.ok, true, 'Invite dispatch must succeed');
    assert.strictEqual(res.json?.sentTo, 'usr_abduraziq', 'Must confirm sentTo recipient');
    assert.ok(res.json?.messageId, 'Must return generated messageId');
    pass(`Phase 8.5: POST /api/integrations/ecosystem/invite dispatched DM successfully (${res.json.messageId})`);
  } catch (err) {
    fail('Phase 8.5: 1-Click invite dispatch', err);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 2: Phase 9 - Netflix-Style Game Discovery & Gemini Recommendations
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Group 2: Phase 9 - Game Discovery UX & Gemini AI Concierge ---');

  // Test 2.1: GET /api/games/recommendations payload structure
  try {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/games/recommendations',
      method: 'GET',
    });
    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    assert.strictEqual(res.json?.ok, true, 'Response must be ok');
    assert.ok(res.json?.topPick, 'Must have topPick object');
    assert.ok(res.json.topPick.title, 'topPick must have title');
    assert.ok(res.json.topPick.platform, 'topPick must have platform');
    assert.ok(res.json.topPick.reason, 'topPick must have reason narrative');
    assert.ok(Array.isArray(res.json.topPick.tags), 'topPick must have tags array');
    assert.ok(Array.isArray(res.json?.recommendations), 'recommendations must be an array');
    pass(`Phase 9.1: GET /api/games/recommendations returned top pick: "${res.json.topPick.title}" (${res.json.topPick.platform.toUpperCase()})`);
    console.log(`         Narrative reason: "${res.json.topPick.reason.slice(0, 70)}..."`);
  } catch (err) {
    fail('Phase 9.1: Game recommendations payload structure', err);
  }

  // Test 2.2: 1-Hour Recommendation Caching Hit
  try {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/games/recommendations',
      method: 'GET',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json?.cached, true, 'Subsequent request within 1 hour must hit cache');
    pass('Phase 9.2: 1-hour recommendation cache hit verified (instant response without LLM re-computation)');
  } catch (err) {
    fail('Phase 9.2: Recommendation cache hit', err);
  }

  // Test 2.3: Frontend Discovery Components Verification
  try {
    const gameLibraryPath = path.join(repoRoot, 'src', 'components', 'GameLibrary.tsx');
    const inviteModalPath = path.join(repoRoot, 'src', 'components', 'EcosystemInviteModal.tsx');
    assert.strictEqual(fs.existsSync(gameLibraryPath), true, 'GameLibrary.tsx must exist');
    assert.strictEqual(fs.existsSync(inviteModalPath), true, 'EcosystemInviteModal.tsx must exist');

    const glContent = fs.readFileSync(gameLibraryPath, 'utf8');
    assert.ok(glContent.includes('Jump Back In'), 'Must render Jump Back In row');
    assert.ok(glContent.includes('Couch Co-Op'), 'Must render Couch Co-Op row');
    assert.ok(glContent.includes('EcosystemInviteModal'), 'Must integrate EcosystemInviteModal');
    pass('Phase 9.3: Frontend GameLibrary.tsx & EcosystemInviteModal.tsx verified with Netflix rows');
  } catch (err) {
    fail('Phase 9.3: Frontend discovery components verification', err);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 3: Phase 10 - Native Windows Desktop Host Packaging
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Group 3: Phase 10 - Windows Host Packaging & Zero-Config Installer ---');

  // Test 3.1: Run scripts/build-windows-exe.js
  try {
    const buildResult = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-windows-exe.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.strictEqual(buildResult.status, 0, `Build script exited with non-zero code: ${buildResult.stderr || buildResult.stdout}`);
    pass('Phase 10.1: scripts/build-windows-exe.js executed cleanly (exit code 0)');
  } catch (err) {
    fail('Phase 10.1: Run build-windows-exe.js', err);
  }

  // Test 3.2: Verify Generated Windows Packaging Artifacts
  try {
    const winHostDir = path.join(repoRoot, 'dist', 'windows-host');
    const expectedFiles = [
      'install-service.bat',
      'uninstall-service.bat',
      'register-protocol.bat',
      'register-protocol.reg',
      'launch-silent.vbs',
      'launch.bat',
      'manifest.json',
    ];

    for (const f of expectedFiles) {
      const p = path.join(winHostDir, f);
      assert.strictEqual(fs.existsSync(p), true, `Missing required file: ${f}`);
    }

    // Verify service rules in install-service.bat
    const installBat = fs.readFileSync(path.join(winHostDir, 'install-service.bat'), 'utf8');
    assert.ok(installBat.includes('sc.exe create'), 'install-service.bat must use sc.exe create');
    assert.ok(installBat.includes('start= auto'), 'install-service.bat must configure automatic start');
    assert.ok(installBat.includes('sc.exe failure'), 'install-service.bat must configure failure recovery');

    // Verify registry script in register-protocol.bat
    const regBat = fs.readFileSync(path.join(winHostDir, 'register-protocol.bat'), 'utf8');
    assert.ok(regBat.includes('HKCR\\nexus'), 'register-protocol.bat must target HKCR\\nexus');
    assert.ok(regBat.includes('URL:Nexus Protocol'), 'register-protocol.bat must declare URL protocol');

    // Verify manifest JSON
    const manifest = JSON.parse(fs.readFileSync(path.join(winHostDir, 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.service.id, 'nexus-service');
    assert.strictEqual(manifest.protocol.scheme, 'nexus');
    pass('Phase 10.2: All Windows packaging artifacts, service configurations, and registry handlers verified');
  } catch (err) {
    fail('Phase 10.2: Verify packaging artifacts', err);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 4: Regression Check - Host Health & Media Streaming Range
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n--- Group 4: Regression Check - Host Health & Media Streaming ---');

  // Test 4.1: Host Health
  try {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/health',
      method: 'GET',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json?.status, 'ok');
    pass('Phase 4.1: /api/health returned 200 OK');
  } catch (err) {
    fail('Phase 4.1: Health check', err);
  }

  // Test 4.2: Media Streaming Range HTTP 206 Partial Content
  try {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/stream/gdrive/mock_regression_test',
      method: 'GET',
      headers: {
        Range: 'bytes=0-100',
      },
    });
    assert.strictEqual(res.statusCode, 206, `Expected 206 Partial Content, got ${res.statusCode}`);
    assert.ok(res.headers['content-range'], 'Must contain Content-Range header');
    pass(`Phase 4.2: Media streaming proxy returned HTTP 206 Partial Content (${res.headers['content-range']})`);
  } catch (err) {
    fail('Phase 4.2: Media streaming range check', err);
  }

  // Summary
  console.log('\n===============================================================');
  console.log(` Diagnostic Results: ${passedTests} passed, ${failedTests} failed`);
  console.log('===============================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal diagnostic error:', err);
  process.exit(1);
});
