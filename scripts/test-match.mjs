import 'dotenv/config';
import crypto from 'crypto';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const rel1 = './Sega Genesis/Zoop.zip';
  const id1 = crypto.createHash('md5').update(rel1).digest('hex');
  const res1 = await pool.query('SELECT id, title, sync_status, relative_path FROM games WHERE id = $1', [id1]);
  console.log('Result for id1 (' + id1 + '):', res1.rows);

  const rel2 = './GENESIS/Zoop.zip';
  const id2 = crypto.createHash('md5').update(rel2).digest('hex');
  const res2 = await pool.query('SELECT id, title, sync_status, relative_path FROM games WHERE id = $1', [id2]);
  console.log('Result for id2 (' + id2 + '):', res2.rows);

  const res3 = await pool.query('SELECT id, title, sync_status, relative_path FROM games WHERE title ILIKE $1', ['%Zoop%']);
  console.log('Result by title %Zoop%:', res3.rows);

  // Check N64 title:
  const res4 = await pool.query('SELECT id, title, sync_status, relative_path FROM games WHERE relative_path ILIKE $1', ['%FORSAKEN%']);
  console.log('Result for Forsaken in DB:', res4.rows);

  await pool.end();
}
main().catch(console.error);
