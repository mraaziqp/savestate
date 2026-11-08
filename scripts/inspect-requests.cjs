const { Pool } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/DATABASE_URL=(.*)/);
const pool = new Pool({ connectionString: m[1].trim() });

async function run() {
  const cols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='host_access_requests' ORDER BY ordinal_position");
  console.log("Columns:", cols.rows);
  const rows = await pool.query(`
    SELECT har.*, u.username, u.display_name, u.email, u.role, u.user_tier, u.media_access, u.games_access
    FROM host_access_requests har
    JOIN users u ON u.id = har.requester_id
    ORDER BY har.created_at DESC
  `);
  console.log("Access Requests:", rows.rows);
  await pool.end();
}
run().catch(console.error);
