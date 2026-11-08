import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ROM_EXT = new Set([
  ".nes", ".sfc", ".smc", ".z64", ".n64", ".v64",
  ".gba", ".gbc", ".gb", ".nds", ".3ds",
  ".iso", ".bin", ".cue", ".img", ".mdf",
  ".rom", ".zip", ".7z", ".chd",
  ".smd", ".md",  ".gen", ".gg",  ".sms",
  ".pce", ".lnx", ".ws",  ".wsc",
  ".ngp", ".ngc", ".a26", ".a78",
  ".pbp", ".cso",
  ".gcm", ".gcz", ".rvz", ".wbfs", ".wad",
  ".32x",
]);

async function main() {
  console.log('Fetching games from PostgreSQL...');
  const dbRes = await pool.query("SELECT id, title, platform, relative_path, sync_status, file_size FROM games");
  console.log(`Loaded ${dbRes.rows.length} total games from database.`);

  // Create lookup maps
  const idMap = new Map();
  const relPathMap = new Map();
  const baseMap = new Map();

  for (const row of dbRes.rows) {
    idMap.set(row.id, row);
    relPathMap.set(row.relative_path.toLowerCase(), row);
    const base = path.basename(row.relative_path).toLowerCase();
    if (!baseMap.has(base)) baseMap.set(base, row);
  }

  // Walk K:\retroarch\ROMS
  const root = 'K:/retroarch/ROMS';
  const foundFiles = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) {
        walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(full).toLowerCase();
        if (ROM_EXT.has(ext)) {
          foundFiles.push(full);
        }
      }
    }
  }

  walk(root);
  console.log(`Discovered ${foundFiles.length} candidate ROM files on K:/retroarch/ROMS.`);

  const matchedGameIds = new Set();
  const updates = [];

  for (const full of foundFiles) {
    const stat = fs.statSync(full);
    const rel = './' + path.relative(root, full).replace(/\\/g, '/');
    const idByRel = crypto.createHash('md5').update(rel).digest('hex');

    let matchedRow = null;

    if (idMap.has(idByRel)) {
      matchedRow = idMap.get(idByRel);
    } else if (relPathMap.has(rel.toLowerCase())) {
      matchedRow = relPathMap.get(rel.toLowerCase());
    } else {
      // Try alias replacing "Sega Genesis" with "GENESIS"
      const altRel = rel.replace(/^\.\/Sega Genesis\//i, './GENESIS/');
      const altId = crypto.createHash('md5').update(altRel).digest('hex');
      if (idMap.has(altId)) {
        matchedRow = idMap.get(altId);
      } else if (relPathMap.has(altRel.toLowerCase())) {
        matchedRow = relPathMap.get(altRel.toLowerCase());
      } else {
        // Try basename match
        const base = path.basename(full).toLowerCase();
        if (baseMap.has(base)) {
          matchedRow = baseMap.get(base);
        }
      }
    }

    if (matchedRow && !matchedGameIds.has(matchedRow.id)) {
      matchedGameIds.add(matchedRow.id);
      updates.push({
        id: matchedRow.id,
        size: stat.size,
        path: rel
      });
    }
  }

  console.log(`Matched ${updates.length} games to database entries!`);

  // Batch update sync_status = 'synced' and file_size
  console.log('Applying database updates in batches of 200...');
  const batchSize = 200;
  for (let i = 0; i < updates.length; i += batchSize) {
    const chunk = updates.slice(i, i + batchSize);
    const ids = chunk.map(u => u.id);
    await pool.query(`
      UPDATE games 
      SET sync_status = 'synced',
          updated_at = NOW()
      WHERE id = ANY($1::text[])
    `, [ids]);
    process.stdout.write(`Updated ${Math.min(i + batchSize, updates.length)} / ${updates.length}\r`);
  }
  console.log('\nBatch update complete!');

  // Check new distribution
  const statusRes = await pool.query('SELECT sync_status, count(*) FROM games GROUP BY sync_status ORDER BY count DESC');
  console.log('Updated sync status distribution:');
  console.table(statusRes.rows);

  await pool.end();
}

main().catch(console.error);
