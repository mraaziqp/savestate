const { Pool } = require('pg');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const m = env.match(/DATABASE_URL=(.*)/);
const pool = new Pool({ connectionString: m[1].trim() });

async function run() {
  const r = await pool.query("SELECT id, username, display_name, email, role FROM users WHERE role IN ('admin', 'superadmin', 'ultra_admin')");
  console.table(r.rows);
  await pool.end();
}
run().catch(console.error);
