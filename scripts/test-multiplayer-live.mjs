import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'nexus-dev-secret-change-in-production';
// Generate admin token
const adminToken = jwt.sign(
  {
    userId: 'e8491213-951e-4281-bdbe-377c17e737e5',
    username: 'mraaziqp',
    role: 'admin',
    accountType: 'admin',
  },
  JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' }
);

async function testLive() {
  console.log('Testing SaveState Multiplayer Live API on http://127.0.0.1:3000...');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminToken}`,
  };

  // 1. Stats endpoint
  const statsRes = await fetch('http://127.0.0.1:3000/api/multiplayer/stats', { headers });
  console.log('1. GET /api/multiplayer/stats Status:', statsRes.status);
  const stats = await statsRes.json();
  console.log('Stats:', stats);

  // 2. Query GoldenEye in multiplayer endpoint
  const geRes = await fetch('http://127.0.0.1:3000/api/multiplayer/games?search=goldeneye', { headers });
  console.log('2. GET /api/multiplayer/games?search=goldeneye Status:', geRes.status);
  const geData = await geRes.json();
  console.log('GoldenEye results count:', geData.games?.length);
  if (geData.games?.length) {
    console.log('GoldenEye multiplayer metadata:', JSON.stringify(geData.games[0].multiplayer, null, 2));
  }

  // 3. Query GoldenEye in CO-OP endpoint (GoldenEye MUST NOT be returned)
  const coopRes = await fetch('http://127.0.0.1:3000/api/coop/games', { headers });
  console.log('3. GET /api/coop/games Status:', coopRes.status);
  const coopData = await coopRes.json();
  const goldenEyeInCoop = (coopData.games ?? []).some(g => String(g.title).toLowerCase().includes('goldeneye'));
  console.log('Is GoldenEye in co-op games list?', goldenEyeInCoop ? 'FAIL: Found in co-op!' : 'PASS: Strictly excluded from co-op!');
  const contraInCoop = (coopData.games ?? []).some(g => String(g.title).toLowerCase().includes('contra'));
  console.log('Is Contra in co-op games list?', contraInCoop ? 'PASS: Contra correctly included in co-op!' : 'WARN: Contra not found');

  // 4. Test QA Suite run via API
  console.log('4. Running QA Suite via POST /api/qa/run ...');
  const qaRes = await fetch('http://127.0.0.1:3000/api/qa/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  console.log('QA Suite Status:', qaRes.status);
  const qaData = await qaRes.json();
  if (qaData.ok && qaData.report) {
    console.log(`QA Suite Run Result: ${qaData.report.passedCount}/${qaData.report.totalTests} tests passed (${qaData.report.totalDurationMs}ms)`);
    const multiResults = qaData.report.results.filter(r => r.subsystem === 'multiplayer');
    for (const r of multiResults) {
      console.log(` - [${r.passed ? 'PASS' : 'FAIL'}] ${r.id}: ${r.name} (${r.durationMs}ms) -> ${r.details || r.error}`);
    }
  } else {
    console.log('QA Suite response:', qaData);
  }
}

testLive().catch(console.error);
