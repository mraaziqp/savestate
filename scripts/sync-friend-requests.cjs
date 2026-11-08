const { Pool } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/DATABASE_URL=(.*)/);
const pool = new Pool({ connectionString: m[1].trim() });

async function run() {
  // 1. Ensure sabri.shade has a host_access_request
  await pool.query(
    "INSERT INTO host_access_requests (host_id, requester_id, status, message) VALUES ($1, $2, 'pending', 'Access request') ON CONFLICT (host_id, requester_id) DO UPDATE SET status='pending'",
    ['219dd692-a376-47ee-9097-057f774539bb', 'ee68a565-b46a-47b5-ab1e-ca2e6dec85fd']
  );
  console.log("Successfully ensured pending access request for sabri.shade!");

  // 2. Query all pending requests
  const reqs = await pool.query(
    `SELECT har.id, har.status, har.message, har.created_at, u.username, u.display_name, u.email
     FROM host_access_requests har
     JOIN users u ON u.id=har.requester_id
     WHERE har.status='pending'
     ORDER BY har.created_at DESC`
  );
  console.log("Pending access requests:");
  console.table(reqs.rows);

  await pool.end();
}

run().catch(console.error);
