import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const colsRes = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'games'
  `);
  console.log('Columns in games table:');
  console.table(colsRes.rows);

  const sampleRes = await pool.query('SELECT * FROM games LIMIT 2');
  console.log('Sample game rows:');
  console.log(JSON.stringify(sampleRes.rows, null, 2));

  const vaultRes = await pool.query('SELECT * FROM vault_config LIMIT 1');
  console.log('Vault config:', vaultRes.rows[0]);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
