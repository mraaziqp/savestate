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

async function main() {
  // Let's get all relative_path from games table
  const res = await pool.query("SELECT id, title, platform, relative_path, sync_status FROM games WHERE sync_status = 'missing_media'");
  console.log(`Total missing_media games in DB: ${res.rows.length}`);

  // Create a map of relative_path (lowercase) -> db row
  const dbPathMap = new Map();
  for (const row of res.rows) {
    dbPathMap.set(row.relative_path.toLowerCase(), row);
    // Also map basename
    const base = path.basename(row.relative_path).toLowerCase();
    if (!dbPathMap.has(base)) dbPathMap.set(base, row);
  }

  // Scan K:\retroarch\ROMS files
  function scan(dir) {
    let files = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        files = files.concat(scan(full));
      } else {
        files.push(full);
      }
    }
    return files;
  }

  const allFiles = scan('K:/retroarch/ROMS');
  console.log(`Total files on K:/retroarch/ROMS: ${allFiles.length}`);

  let directRelMatch = 0;
  let baseMatch = 0;
  const matchedIds = [];

  for (const f of allFiles) {
    let rel = './' + path.relative('K:/retroarch/ROMS', f).replace(/\\/g, '/');
    // Try as-is
    if (dbPathMap.has(rel.toLowerCase())) {
      directRelMatch++;
      matchedIds.push(dbPathMap.get(rel.toLowerCase()).id);
      continue;
    }
    // Try if "Sega Genesis" replaced with "GENESIS"
    let altRel = rel.replace(/^\.\/Sega Genesis\//i, './GENESIS/');
    if (dbPathMap.has(altRel.toLowerCase())) {
      directRelMatch++;
      matchedIds.push(dbPathMap.get(altRel.toLowerCase()).id);
      continue;
    }
    // Try basename match
    const base = path.basename(f).toLowerCase();
    if (dbPathMap.has(base)) {
      baseMatch++;
      matchedIds.push(dbPathMap.get(base).id);
    }
  }

  console.log(`Direct relative path matches (with GENESIS alias): ${directRelMatch}`);
  console.log(`Basename matches: ${baseMatch}`);
  console.log(`Total unique games on K: that match missing DB rows: ${new Set(matchedIds).size}`);

  await pool.end();
}

main().catch(console.error);
