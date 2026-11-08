const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'games'");
    console.log('Columns in games:', cols.rows.map(r => r.column_name).join(', '));

    const games = await client.query('SELECT * FROM games ORDER BY id DESC LIMIT 10');
    console.log('Recent 10 games:');
    for (const g of games.rows) {
      console.log(`- [${g.platform}] ID: ${g.id} Title: "${g.title}" File: ${g.filename || g.file_hash} Created: ${g.created_at}`);
    }

    const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('\nAll tables:');
    console.log(tables.rows.map(r => r.table_name).join(', '));

    const ps2Count = await client.query("SELECT COUNT(*) FROM games WHERE LOWER(platform) = 'ps2'");
    console.log('\nTotal PS2 games in DB:', ps2Count.rows[0].count);

    const recentPs2 = await client.query("SELECT id, title, filename, file_hash, created_at FROM games WHERE LOWER(platform) = 'ps2' ORDER BY id DESC LIMIT 10");
    console.log('\nRecent PS2 games in DB:');
    for (const g of recentPs2.rows) {
      console.log(`- ID: ${g.id} Title: "${g.title}" File: ${g.filename}`);
    }
  } finally {
    client.release();
    pool.end();
  }
}
main().catch(console.error);
