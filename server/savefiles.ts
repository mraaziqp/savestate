/**
 * Game saves that follow you between devices (battery saves: the .srm file
 * an emulator keeps for a game). The PS Vita app and the browser player send
 * a game's save here after playing and fetch it before playing, so progress
 * made on one device carries on on another.
 *
 *   GET  /api/savefile/:gameId        the save (bytes), X-Save-Crc / X-Saved-At headers; 404 if none
 *   GET  /api/savefile/:gameId/info   { crc, size, savedAt, device } or 404
 *   PUT  /api/savefile/:gameId        raw bytes (up to 8 MB) -> { crc, savedAt }
 *
 * Stored in the database (table save_files), so every host serving the site
 * (this PC, the NAS) has the same saves. The copy it replaces is kept
 * (prev_data), so a save overwritten from the wrong device can be recovered.
 */
import express from "express";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** CRC-32 (the same as zlib's crc32, which the Vita app uses). */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function registerSaveFiles(app: express.Express, deps: {
  pool: () => any | null;
  userOf: (req: express.Request, res: express.Response) => { userId: string } | null;
  log: (level: string, msg: string) => void;
}) {
  let ready = false;
  async function table(pool: any) {
    if (ready) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS save_files (
      user_id TEXT NOT NULL, game_id TEXT NOT NULL, data BYTEA NOT NULL, crc BIGINT NOT NULL,
      size INT NOT NULL, saved_at BIGINT NOT NULL, device TEXT, prev_data BYTEA, prev_saved_at BIGINT,
      PRIMARY KEY (user_id, game_id))`);
    ready = true;
  }
  const gameIdOf = (req: express.Request) => String(req.params.gameId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

  app.get("/api/savefile/:gameId/info", async (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const pool = deps.pool(); if (!pool) return res.status(503).json({ error: "Database not connected" });
    try {
      await table(pool);
      const r = await pool.query("SELECT crc, size, saved_at, device FROM save_files WHERE user_id=$1 AND game_id=$2", [who.userId, gameIdOf(req)]);
      if (!r.rows[0]) return res.status(404).json({ error: "No save yet" });
      res.json({ crc: Number(r.rows[0].crc), size: r.rows[0].size, savedAt: Number(r.rows[0].saved_at), device: r.rows[0].device ?? null });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/savefile/:gameId", async (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const pool = deps.pool(); if (!pool) return res.status(503).json({ error: "Database not connected" });
    try {
      await table(pool);
      const r = await pool.query("SELECT data, crc, saved_at FROM save_files WHERE user_id=$1 AND game_id=$2", [who.userId, gameIdOf(req)]);
      if (!r.rows[0]) return res.status(404).json({ error: "No save yet" });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Save-Crc", String(r.rows[0].crc));
      res.setHeader("X-Saved-At", String(r.rows[0].saved_at));
      res.send(r.rows[0].data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/savefile/:gameId", express.raw({ type: () => true, limit: "8mb" }), async (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const pool = deps.pool(); if (!pool) return res.status(503).json({ error: "Database not connected" });
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) return res.status(400).json({ error: "Empty save" });
    const gameId = gameIdOf(req);
    if (!gameId) return res.status(400).json({ error: "Which game?" });
    try {
      await table(pool);
      const crc = crc32(body);
      const now = Date.now();
      const device = String(req.headers["x-device"] ?? "").slice(0, 40) || null;
      // The same bytes again: nothing to do (and the backup copy stays useful).
      const same = await pool.query("SELECT crc, saved_at FROM save_files WHERE user_id=$1 AND game_id=$2", [who.userId, gameId]);
      if (same.rows[0] && Number(same.rows[0].crc) === crc) return res.json({ crc, savedAt: Number(same.rows[0].saved_at), unchanged: true });
      await pool.query(`INSERT INTO save_files (user_id, game_id, data, crc, size, saved_at, device)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (user_id, game_id) DO UPDATE SET prev_data = save_files.data, prev_saved_at = save_files.saved_at,
          data = EXCLUDED.data, crc = EXCLUDED.crc, size = EXCLUDED.size, saved_at = EXCLUDED.saved_at, device = EXCLUDED.device`,
        [who.userId, gameId, body, crc, body.length, now, device]);
      res.json({ crc, savedAt: now });
    } catch (e: any) {
      deps.log("WARN", `save upload failed (${gameId}): ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
}
