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

const newGames = [
  {
    title: 'Super Smash Bros. Melee',
    platform: 'gamecube',
    core_id: 'dolphin',
    relPath: './Gamecube/Super Smash Bros. Melee (USA).iso',
    fullPath: 'K:/retroarch/ROMS/roms/gamecube/Super Smash Bros. Melee (USA).iso'
  },
  {
    title: 'The Incredibles',
    platform: 'gamecube',
    core_id: 'dolphin',
    relPath: './Gamecube/The Incredibles (USA).iso',
    fullPath: 'K:/retroarch/ROMS/roms/gamecube/The Incredibles (USA).iso'
  },
  {
    title: '007 - From Russia with Love',
    platform: 'gamecube',
    core_id: 'dolphin',
    relPath: './Gamecube/007 - From Russia with Love.iso',
    fullPath: 'K:/retroarch/ROMS/roms/gamecube/007 - From Russia with Love.iso'
  },
  {
    title: "Fighter's Destiny",
    platform: 'n64',
    core_id: 'mupen64plus_next',
    relPath: './N64/Fighters Destiny (USA).v64',
    fullPath: 'K:/retroarch/ROMS/N64/Fighters Destiny (USA).v64'
  },
  {
    title: 'Harry Potter and the Order of the Phoenix',
    platform: 'gba',
    core_id: 'mgba',
    relPath: './Gameboy/Harry Potter and the Order of the Phoenix (USA, Europe).zip',
    fullPath: 'K:/retroarch/ROMS/Gameboy/Harry Potter and the Order of the Phoenix (USA, Europe).zip'
  },
  {
    title: 'The Adventures of Jimmy Neutron Boy Genius - Attack of the Twonkies',
    platform: 'gba',
    core_id: 'mgba',
    relPath: './Gameboy/The Adventures of Jimmy Neutron Boy Genius - Attack of the Twonkies (USA, Europe).zip',
    fullPath: 'K:/retroarch/ROMS/Gameboy/The Adventures of Jimmy Neutron Boy Genius - Attack of the Twonkies (USA, Europe).zip'
  },
  {
    title: 'The Incredibles',
    platform: 'gba',
    core_id: 'mgba',
    relPath: './Gameboy/The Incredibles (USA, Europe).zip',
    fullPath: 'K:/retroarch/ROMS/Gameboy/The Incredibles (USA, Europe).zip'
  },
  {
    title: 'The Invincible Iron Man',
    platform: 'gba',
    core_id: 'mgba',
    relPath: './Gameboy/The Invincible Iron Man (USA, Europe).zip',
    fullPath: 'K:/retroarch/ROMS/Gameboy/The Invincible Iron Man (USA, Europe).zip'
  },
  {
    title: 'The King of Fighters 98',
    platform: 'neogeo',
    core_id: 'fbneo',
    relPath: './neogeo/kof98n.zip',
    fullPath: 'K:/retroarch/ROMS/neogeo/kof98n.zip'
  }
];

async function main() {
  for (const g of newGames) {
    if (!fs.existsSync(g.fullPath)) {
      console.warn(`File does not exist: ${g.fullPath}`);
      continue;
    }
    const stat = fs.statSync(g.fullPath);
    const id = crypto.createHash('md5').update(g.relPath).digest('hex');

    const res = await pool.query(`
      INSERT INTO games (
        id, title, platform, core_id, relative_path, file_size, sync_status,
        dominant_color, playtime, rating, players, description, genre
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'synced',
        '#1a1a2e', 0, 0, '1-2', '', ARRAY[]::text[]
      )
      ON CONFLICT (id) DO UPDATE SET 
        sync_status = 'synced',
        relative_path = EXCLUDED.relative_path,
        file_size = EXCLUDED.file_size,
        updated_at = NOW()
      RETURNING id, title
    `, [id, g.title, g.platform, g.core_id, g.relPath, stat.size]);

    console.log(`Registered game: ${g.title} (${g.platform}) -> ID: ${id}`);
  }

  const count = await pool.query('SELECT count(*) FROM games WHERE sync_status = \'synced\'');
  console.log(`Total synced games now: ${count.rows[0].count}`);
  await pool.end();
}

main().catch(console.error);
