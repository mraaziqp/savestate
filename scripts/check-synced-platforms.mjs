import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const syncedByPlat = await pool.query("SELECT platform, count(*) FROM games WHERE sync_status = 'synced' GROUP BY platform ORDER BY count DESC");
  console.log('Synced games by platform:');
  console.table(syncedByPlat.rows);
  await pool.end();
}
main().catch(console.error);
