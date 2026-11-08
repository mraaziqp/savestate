const { Pool } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/DATABASE_URL=(.*)/);
const pool = new Pool({ connectionString: m[1].trim() });

async function check() {
  const r = await pool.query("SELECT * FROM users WHERE username IN ('ziyaadfritz', 'sabri.shade')");
  console.log("=== USERS ===");
  console.log(JSON.stringify(r.rows, null, 2));

  const reqs = await pool.query("SELECT * FROM host_access_requests WHERE requester_id IN ('95bf47d0-5293-4730-a3dc-7979022eced9', 'ee68a565-b46a-47b5-ab1e-ca2e6dec85fd')");
  console.log("=== HOST ACCESS REQUESTS ===");
  console.log(JSON.stringify(reqs.rows, null, 2));

  try {
    const members = await pool.query("SELECT * FROM host_members WHERE user_id IN ('95bf47d0-5293-4730-a3dc-7979022eced9', 'ee68a565-b46a-47b5-ab1e-ca2e6dec85fd')");
    console.log("=== HOST MEMBERS ===");
    console.log(JSON.stringify(members.rows, null, 2));
  } catch (e) {
    console.log("host_members table query error:", e.message);
  }

  await pool.end();
}
check().catch(console.error);
