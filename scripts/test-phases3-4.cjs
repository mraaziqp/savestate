const http = require('http');
const WebSocket = require('ws');

const PORT = 3000;
const HOST = '127.0.0.1';

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function testPhases3And4() {
  console.log('===============================================================');
  console.log('🧪 Running Diagnostic Tests: Phases 3 & 4');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name} ${details ? `(${details})` : ''}`);
      failed++;
    }
  }

  // --- Phase 3: Owner-Only Server Play Security ---
  console.log('Test Phase 3: Owner-Only Server Play Security');
  const nonOwnerRes = await request(
    {
      hostname: HOST,
      port: PORT,
      path: '/api/game-sessions/init',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    JSON.stringify({ tenantUsername: 'guest_attacker', game_id: 'sm64' })
  );

  assert(nonOwnerRes.status === 403, 'Non-owner tenant receives HTTP 403 Forbidden');
  assert(nonOwnerRes.body?.enforce_streaming_only === true, 'enforce_streaming_only flag is set to true');
  assert(!!nonOwnerRes.body?.webrtc_stream_url, 'Peer-to-peer WebRTC stream URL provided');

  const ownerRes = await request(
    {
      hostname: HOST,
      port: PORT,
      path: '/api/game-sessions/init',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    JSON.stringify({ tenantUsername: 'moh', game_id: 'sm64' })
  );

  assert(ownerRes.status === 200, 'Host owner receives HTTP 200 OK');
  assert(ownerRes.body?.server_emulation === true, 'Host owner authorized for server-side emulation');

  // --- Phase 4: Jarvis Tool Execution (/api/ai/chat) ---
  console.log('\nTest Phase 4: Jarvis Tool Execution & Diagnostics');
  const jarvisRes = await request(
    {
      hostname: HOST,
      port: PORT,
      path: '/api/ai/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    JSON.stringify({ message: 'diagnose_hls_stream' })
  );

  assert(jarvisRes.status === 200, 'Jarvis AI chat endpoint responds with HTTP 200');
  assert(jarvisRes.body?.toolExecuted?.name === 'diagnose_hls_stream', 'Executed diagnose_hls_stream tool');
  assert(jarvisRes.body?.toolExecuted?.result?.ramBuffer?.path === '/dev/shm', 'Diagnosed RAM buffer /dev/shm');

  // --- Phase 4: Telemetry WebSocket (/api/v1/telemetry/jarvis) ---
  console.log('\nTest Phase 4: Telemetry WebSocket Stream');
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/api/v1/telemetry/jarvis`);
    let receivedBootstrap = false;

    ws.on('open', () => {
      assert(true, 'WebSocket connection established to /api/v1/telemetry/jarvis');
    });

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'jarvis_telemetry_init') {
          receivedBootstrap = true;
          assert(true, 'Received jarvis_telemetry_init bootstrap payload');
          assert(Array.isArray(data.recentLogs), 'Bootstrap payload contains Winston JSON logs');
          ws.close();
          resolve();
        }
      } catch (err) {
        assert(false, 'Failed parsing WebSocket payload', String(err));
        ws.close();
        resolve();
      }
    });

    ws.on('error', (err) => {
      assert(false, 'WebSocket connection error', String(err));
      resolve();
    });

    setTimeout(() => {
      if (!receivedBootstrap) {
        assert(false, 'WebSocket timeout waiting for bootstrap');
        try { ws.close(); } catch {}
        resolve();
      }
    }, 4000);
  });

  console.log('\n===============================================================');
  console.log(`📊 Phase 3 & 4 Summary: ${passed} Passed, ${failed} Failed`);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

testPhases3And4();
