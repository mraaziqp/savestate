/**
 * SaveState Engine on the host: save states that follow the person between
 * PCs, with earlier versions kept, and the player's preferences.
 *
 *   GET    /api/engine/states/:gameId                   [{ slot, version, savedAt, size, device, thumb, versions }]
 *   GET    /api/engine/states/:gameId/:slot             the newest state (?version=n for an earlier one);
 *                                                       X-Version / X-Saved-At / X-Crc / X-Encoding headers
 *   GET    /api/engine/states/:gameId/:slot/versions    [{ version, savedAt, size, device }], newest first
 *   PUT    /api/engine/states/:gameId/:slot             a state in the engine's container (below) -> { version, savedAt }
 *   DELETE /api/engine/states/:gameId/:slot             removes every version of that slot
 *   GET    /api/engine/prefs                            the person's player preferences (JSON)
 *   PUT    /api/engine/prefs                            replaces them (JSON, up to 64 KB)
 *
 * The engine uploads a state as: "SSST" | format u8 (1) | flags u8 (bit 0:
 * LZ4, size-prepended) | 0 u16 | thumbnail length u32 | thumbnail PNG | state.
 * Stored in the database (table engine_states), so every host serving the
 * site has the same states. The five newest versions of each slot are kept.
 * Battery saves are /api/savefile (savefiles.ts), shared with the browser
 * player and the PS Vita app.
 */
import express from "express";
import { crc32 } from "./savefiles.ts";

const KEEP_VERSIONS = 5;
const MAX_STATE = 48 * 1024 * 1024;

export function registerEngineStates(app: express.Express, deps: {
  pool: () => any | null;
  userOf: (req: express.Request, res: express.Response) => { userId: string } | null;
  log: (level: string, msg: string) => void;
}) {
  let ready = false;
  async function tables(pool: any) {
    if (ready) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS engine_states (
      user_id TEXT NOT NULL, game_id TEXT NOT NULL, slot INT NOT NULL, version INT NOT NULL,
      data BYTEA NOT NULL, encoding TEXT NOT NULL, thumb BYTEA, size INT NOT NULL, crc BIGINT NOT NULL,
      saved_at BIGINT NOT NULL, device TEXT,
      PRIMARY KEY (user_id, game_id, slot, version))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS engine_prefs (
      user_id TEXT PRIMARY KEY, prefs JSONB NOT NULL, updated_at BIGINT NOT NULL)`);
    ready = true;
  }
  const gameIdOf = (req: express.Request) => String(req.params.gameId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  const slotOf = (req: express.Request) => {
    const n = Number(req.params.slot);
    return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
  };
  const begin = async (req: express.Request, res: express.Response) => {
    const who = deps.userOf(req, res);
    if (!who) return null;
    const pool = deps.pool();
    if (!pool) { res.status(503).json({ error: "Database not connected" }); return null; }
    await tables(pool);
    return { who, pool };
  };

  app.get("/api/engine/states/:gameId", async (req, res) => {
    try {
      const c = await begin(req, res); if (!c) return;
      const r = await c.pool.query(
        `SELECT DISTINCT ON (slot) slot, version, saved_at, size, device, thumb,
           (SELECT COUNT(*) FROM engine_states v WHERE v.user_id = s.user_id AND v.game_id = s.game_id AND v.slot = s.slot) AS versions
         FROM engine_states s WHERE user_id = $1 AND game_id = $2 ORDER BY slot, version DESC`,
        [c.who.userId, gameIdOf(req)]);
      res.setHeader("Cache-Control", "no-store");
      res.json(r.rows.map((x: any) => ({
        slot: x.slot, version: x.version, savedAt: Number(x.saved_at), size: x.size, device: x.device,
        thumb: x.thumb ? Buffer.from(x.thumb).toString("base64") : null, versions: Number(x.versions),
      })));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/engine/states/:gameId/:slot/versions", async (req, res) => {
    try {
      const c = await begin(req, res); if (!c) return;
      const slot = slotOf(req); if (slot == null) return res.status(400).json({ error: "Which slot?" });
      const r = await c.pool.query("SELECT version, saved_at, size, device FROM engine_states WHERE user_id=$1 AND game_id=$2 AND slot=$3 ORDER BY version DESC",
        [c.who.userId, gameIdOf(req), slot]);
      res.setHeader("Cache-Control", "no-store");
      res.json(r.rows.map((x: any) => ({ version: x.version, savedAt: Number(x.saved_at), size: x.size, device: x.device })));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/engine/states/:gameId/:slot", async (req, res) => {
    try {
      const c = await begin(req, res); if (!c) return;
      const slot = slotOf(req); if (slot == null) return res.status(400).json({ error: "Which slot?" });
      const version = req.query.version != null ? Number(req.query.version) : null;
      const r = version != null && Number.isInteger(version)
        ? await c.pool.query("SELECT data, encoding, version, saved_at, crc FROM engine_states WHERE user_id=$1 AND game_id=$2 AND slot=$3 AND version=$4", [c.who.userId, gameIdOf(req), slot, version])
        : await c.pool.query("SELECT data, encoding, version, saved_at, crc FROM engine_states WHERE user_id=$1 AND game_id=$2 AND slot=$3 ORDER BY version DESC LIMIT 1", [c.who.userId, gameIdOf(req), slot]);
      const row = r.rows[0];
      if (!row) return res.status(404).json({ error: "No save in that slot" });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Version", String(row.version));
      res.setHeader("X-Saved-At", String(row.saved_at));
      res.setHeader("X-Crc", String(row.crc));
      res.setHeader("X-Encoding", row.encoding);
      res.send(row.data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/engine/states/:gameId/:slot", express.raw({ type: () => true, limit: MAX_STATE + 1024 * 1024 }), async (req, res) => {
    try {
      const c = await begin(req, res); if (!c) return;
      const slot = slotOf(req); if (slot == null) return res.status(400).json({ error: "Which slot?" });
      const gameId = gameIdOf(req);
      if (!gameId) return res.status(400).json({ error: "Which game?" });
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length < 12 || body.toString("latin1", 0, 4) !== "SSST" || body[4] !== 1) return res.status(400).json({ error: "Not a SaveState Engine state" });
      const lz4 = (body[5] & 1) === 1;
      const thumbLen = body.readUInt32LE(8);
      if (12 + thumbLen > body.length || thumbLen > 512 * 1024) return res.status(400).json({ error: "Damaged state" });
      const thumb = thumbLen ? body.subarray(12, 12 + thumbLen) : null;
      const data = body.subarray(12 + thumbLen);
      if (!data.length || data.length > MAX_STATE) return res.status(400).json({ error: "State too big to keep on the host" });
      const crc = crc32(data);
      const now = Date.now();
      const device = String(req.headers["x-device"] ?? "").slice(0, 40) || null;
      const last = await c.pool.query("SELECT version, crc FROM engine_states WHERE user_id=$1 AND game_id=$2 AND slot=$3 ORDER BY version DESC LIMIT 1", [c.who.userId, gameId, slot]);
      if (last.rows[0] && Number(last.rows[0].crc) === crc) return res.json({ version: last.rows[0].version, savedAt: now, unchanged: true });
      const version = (last.rows[0]?.version ?? 0) + 1;
      await c.pool.query(
        "INSERT INTO engine_states (user_id, game_id, slot, version, data, encoding, thumb, size, crc, saved_at, device) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [c.who.userId, gameId, slot, version, data, lz4 ? "lz4" : "raw", thumb, data.length, crc, now, device]);
      await c.pool.query("DELETE FROM engine_states WHERE user_id=$1 AND game_id=$2 AND slot=$3 AND version <= $4", [c.who.userId, gameId, slot, version - KEEP_VERSIONS]);
      res.json({ version, savedAt: now });
    } catch (e: any) {
      deps.log("WARN", `engine state upload failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/engine/states/:gameId/:slot", async (req, res) => {
    try {
      const c = await begin(req, res); if (!c) return;
      const slot = slotOf(req); if (slot == null) return res.status(400).json({ error: "Which slot?" });
      await c.pool.query("DELETE FROM engine_states WHERE user_id=$1 AND game_id=$2 AND slot=$3", [c.who.userId, gameIdOf(req), slot]);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/engine/prefs", async (req, res) => {
    try {
      const c = await begin(req, res); if (!c) return;
      const r = await c.pool.query("SELECT prefs, updated_at FROM engine_prefs WHERE user_id=$1", [c.who.userId]);
      res.setHeader("Cache-Control", "no-store");
      res.json(r.rows[0] ? { prefs: r.rows[0].prefs, updatedAt: Number(r.rows[0].updated_at) } : { prefs: {}, updatedAt: 0 });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/engine/prefs", express.json({ limit: "64kb" }), async (req, res) => {
    try {
      const c = await begin(req, res); if (!c) return;
      const prefs = req.body?.prefs;
      if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return res.status(400).json({ error: "prefs (an object) required" });
      const now = Date.now();
      await c.pool.query(
        "INSERT INTO engine_prefs (user_id, prefs, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at",
        [c.who.userId, JSON.stringify(prefs), now]);
      res.json({ updatedAt: now });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
}
