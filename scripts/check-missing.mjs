import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const statusRes = await pool.query('SELECT sync_status, count(*) FROM games GROUP BY sync_status ORDER BY count DESC');
  console.log('Sync status distribution:');
  console.table(statusRes.rows);

  // Check some paths for genesis, snes, n64, neogeo
  const pathsRes = await pool.query(`
    SELECT platform, relative_path, count(*) 
    FROM games 
    WHERE platform IN ('genesis', 'snes', 'n64', 'neogeo', 'gamecube', 'ps2')
    GROUP BY platform, relative_path
    LIMIT 20
  `);
  console.log('Sample relative paths in DB:');
  console.table(pathsRes.rows);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
