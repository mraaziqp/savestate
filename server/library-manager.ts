import type express from "express";
import path from "node:path";
import { statfs, stat, unlink, rm, rename, copyFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";

export type LibraryManagerDeps = {
  app: express.Express;
  pool: any;
  mem: { games: any[]; media: any[] };
  log: (level: string, msg: string, subsystem?: string) => void;
  requireAuth: (req: express.Request, res: express.Response) => any;
  isAdmin: (auth: any) => Promise<boolean>;
  resolveRomPath: (configRoot: string, game: Record<string, any>, extraRoots?: string[]) => Promise<{ absolutePath: string | null; relativePath: string | null }>;
  getVaultConfig: () => Promise<any>;
  getExtraRoots: (config: any) => string[];
  refreshMediaLibrary?: (force?: boolean) => Promise<any>;
};

export function humanBytes(bytes: number): string {
  if (bytes == null || isNaN(bytes)) return "0 B";
  const b = Math.max(0, bytes);
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function isCloud(p: string): boolean {
  if (!p) return false;
  return /^[I]:|[\\/]nexus-cloud-media|[\\/]google drive|[\\/]my drive|[\\/]nexusarchive/i.test(p);
}

function getDriveLetter(p: string): string {
  if (!p) return "Unknown";
  if (isCloud(p)) return "Google Drive";
  const m = /^([A-Za-z]:)/.exec(p);
  if (m) return m[1].toUpperCase();
  return "Local";
}

let gdriveQuotaCache: { at: number; data: { total: number; free: number; used: number } } | null = null;
let gdriveFetching = false;

function refreshGdriveQuotaInBackground(): void {
  if (gdriveFetching) return;
  gdriveFetching = true;
  execFile("rclone", ["about", "gdrive:", "--json"], { timeout: 10000 }, (err, stdout) => {
    gdriveFetching = false;
    if (!err && stdout) {
      try {
        const json = JSON.parse(stdout.trim());
        const total = Number(json.total) || 0;
        const free = Number(json.free) || 0;
        const used = Number(json.used) || 0;
        if (total > 0) {
          gdriveQuotaCache = { at: Date.now(), data: { total, free, used } };
        }
      } catch {}
    }
  });
}

// Pre-seed Google Drive quota cache on boot
refreshGdriveQuotaInBackground();

async function getGdriveCloudQuota(): Promise<{ total: number; free: number; used: number } | null> {
  if (!gdriveQuotaCache || Date.now() - gdriveQuotaCache.at > 300_000) {
    refreshGdriveQuotaInBackground();
  }
  return gdriveQuotaCache?.data ?? null;
}

let cachedGamesCount: { at: number; count: number } | null = null;
async function getGamesTotal(pool: any, whereSql: string, params: any[]): Promise<number> {
  if (whereSql === "WHERE 1=1" && cachedGamesCount && Date.now() - cachedGamesCount.at < 60_000) {
    return cachedGamesCount.count;
  }
  const countRes = await pool.query(`SELECT COUNT(*)::int AS count FROM games ${whereSql}`, params);
  const count = Number(countRes.rows[0]?.count ?? 0);
  if (whereSql === "WHERE 1=1") {
    cachedGamesCount = { at: Date.now(), count };
  }
  return count;
}

export function registerLibraryManagerApi(deps: LibraryManagerDeps) {
  const { app, pool, mem, log, requireAuth, isAdmin, resolveRomPath, getVaultConfig, getExtraRoots, refreshMediaLibrary } = deps;

  // 1. Storage summary across all physical and cloud drives
  app.get("/api/library/storage-summary", async (req, res) => {
    try {
      const candidates = ["C:\\", "E:\\", "F:\\", "I:\\"];
      const drives: Array<{ drive: string; label: string; totalBytes: number; freeBytes: number; usedBytes: number; totalFormatted: string; freeFormatted: string; percentUsed: number; isCloud: boolean }> = [];
      let hasGoogleDrive = false;

      for (const d of candidates) {
        try {
          const s = await statfs(d);
          let total = Number(s.bsize) * Number(s.blocks);
          let free = Number(s.bsize) * Number(s.bavail);
          let used = Math.max(0, total - free);
          const isCl = d.startsWith("I:") || isCloud(d);
          let label = d.startsWith("C:") ? "SSD (System C:)"
            : d.startsWith("E:") ? "External Storage (E:)"
            : d.startsWith("F:") ? "Storage (F:)"
            : "Google Drive (I:)";

          if (d.startsWith("I:") || isCl) {
            hasGoogleDrive = true;
            const gquota = await getGdriveCloudQuota();
            if (gquota && gquota.total > 0) {
              total = gquota.total;
              free = gquota.free;
              used = gquota.used;
              label = "Google Drive (Cloud)";
            }
          }

          drives.push({
            drive: d.replace(/\\$/, ""),
            label,
            totalBytes: total,
            freeBytes: free,
            usedBytes: used,
            totalFormatted: humanBytes(total),
            freeFormatted: humanBytes(free),
            percentUsed: total > 0 ? Math.round((used / total) * 100) : 0,
            isCloud: isCl,
          });
        } catch {
          // Drive not mounted / unreachable
        }
      }

      if (!hasGoogleDrive) {
        const gquota = await getGdriveCloudQuota();
        if (gquota && gquota.total > 0) {
          drives.push({
            drive: "Google Drive",
            label: "Google Drive (Cloud)",
            totalBytes: gquota.total,
            freeBytes: gquota.free,
            usedBytes: gquota.used,
            totalFormatted: humanBytes(gquota.total),
            freeFormatted: humanBytes(gquota.free),
            percentUsed: Math.round((gquota.used / gquota.total) * 100),
            isCloud: true,
          });
        }
      }

      // Games and Media counts & approximate sizes
      let gamesCount = 0;
      let gamesTotalBytes = 0;
      if (pool) {
        try {
          const r = await pool.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(file_size), 0)::bigint AS bytes FROM games");
          gamesCount = Number(r.rows[0]?.count ?? 0);
          gamesTotalBytes = Number(r.rows[0]?.bytes ?? 0);
        } catch {
          gamesCount = mem.games.length;
        }
      } else {
        gamesCount = mem.games.length;
      }

      const mediaVideos = (mem.media || []).filter(m => m.kind === "video");
      const mediaCount = mediaVideos.length;
      const mediaTotalBytes = mediaVideos.reduce((acc, m) => acc + (Number(m.size) || 0), 0);

      return res.json({
        ok: true,
        drives,
        stats: {
          games: { count: gamesCount, totalBytes: gamesTotalBytes, totalFormatted: humanBytes(gamesTotalBytes) },
          media: { count: mediaCount, totalBytes: mediaTotalBytes, totalFormatted: humanBytes(mediaTotalBytes) },
          totalTrackedBytes: gamesTotalBytes + mediaTotalBytes,
          totalTrackedFormatted: humanBytes(gamesTotalBytes + mediaTotalBytes),
        }
      });
    } catch (err: any) {
      log("ERROR", `library storage summary failed: ${err.message}`, "library");
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // 2. Query items (Games and Media) with filtering, sorting, and pagination
  app.get("/api/library/items", async (req, res) => {
    try {
      const type = String(req.query.type ?? "all").toLowerCase(); // "all" | "games" | "media"
      const driveFilter = String(req.query.drive ?? "all").toUpperCase(); // "ALL", "C:", "E:", "I:", etc.
      const search = String(req.query.search ?? "").trim().toLowerCase();
      const platformFilter = String(req.query.platform ?? "").trim().toLowerCase();
      const categoryFilter = String(req.query.category ?? "").trim().toLowerCase();
      const sort = String(req.query.sort ?? "size_desc"); // "size_desc", "size_asc", "title_asc", "date_desc"
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);

      log("INFO", `[items-query] start: type=${type} limit=${limit} offset=${offset}`, "library");

      const cfg = await getVaultConfig().catch(() => ({ root_path: "C:\\Users\\mraaz\\nexus-cloud-media\\roms" }));
      const extraRoots = getExtraRoots(cfg);

      const candRoots = [
        "E:\\ROMS",
        cfg.root_path || "C:\\Users\\mraaz\\nexus-cloud-media\\roms",
        ...extraRoots,
        "F:\\SaveState\\client-roms",
      ].filter((r) => r && !isCloud(r));

      function formatGameRow(g: any) {
        const rel = String(g.relative_path ?? g.relativePath ?? "").trim();
        const cleanRel = rel.replace(/^\.\//, "").replace(/\//g, path.sep);
        let absPath = "";
        let drv = "E:";
        let isCl = false;

        if (path.isAbsolute(rel)) {
          absPath = rel;
          drv = getDriveLetter(absPath);
          isCl = isCloud(absPath);
        } else if (cleanRel.toLowerCase().includes("nexus-cloud-media") || cleanRel.toLowerCase().includes("drive")) {
          absPath = path.resolve(cfg.root_path || "C:\\Users\\mraaz\\nexus-cloud-media\\roms", cleanRel);
          drv = "Google Drive";
          isCl = true;
        } else {
          absPath = path.resolve("E:\\ROMS", cleanRel);
          drv = "E:";
          isCl = false;
        }

        const sz = Number(g.file_size) || 0;

        return {
          id: String(g.id),
          type: "game" as const,
          title: g.title,
          platform: g.platform,
          path: absPath,
          relativePath: rel,
          drive: drv,
          size: sz,
          sizeFormatted: humanBytes(sz),
          isCloud: isCl,
          boxArt: g.box_art || `/api/art/${g.id}`,
          updatedAt: g.updated_at ? new Date(g.updated_at).toISOString() : null,
        };
      }

      function formatMediaRow(m: any) {
        const title = m.seriesTitle ? `${m.seriesTitle} S${String(m.season).padStart(2, "0")}E${String(m.episode).padStart(2, "0")}` : (m.name || path.basename(m.path));
        const drv = getDriveLetter(m.path);
        const sz = Number(m.size) || 0;
        return {
          id: String(m.id),
          type: "media" as const,
          title,
          category: m.category,
          path: m.path,
          relativePath: m.relPath,
          drive: drv,
          size: sz,
          sizeFormatted: humanBytes(sz),
          isCloud: isCloud(m.path),
          boxArt: m.relatedCoverRelPath ? `/api/media/cover/${encodeURIComponent(m.id)}` : null,
          updatedAt: m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
        };
      }

      function filterMediaList() {
        let list = (mem.media || []).filter((m: any) => m.kind === "video");
        if (search) {
          list = list.filter((m: any) => {
            const title = m.seriesTitle ? `${m.seriesTitle} S${String(m.season).padStart(2, "0")}E${String(m.episode).padStart(2, "0")}` : (m.name || path.basename(m.path));
            return title.toLowerCase().includes(search) || (m.path && m.path.toLowerCase().includes(search));
          });
        }
        if (categoryFilter) {
          list = list.filter((m: any) => m.category === categoryFilter);
        }
        if (driveFilter !== "ALL") {
          list = list.filter((m: any) => {
            const drv = getDriveLetter(m.path);
            const isCl = isCloud(m.path);
            if (driveFilter === "I:" || driveFilter === "CLOUD" || driveFilter === "GOOGLE DRIVE") {
              return isCl || drv === "I:";
            }
            return drv === driveFilter;
          });
        }
        return list;
      }

      function sortMediaList(list: any[]) {
        if (sort === "size_desc") {
          list.sort((a: any, b: any) => (Number(b.size) || 0) - (Number(a.size) || 0));
        } else if (sort === "size_asc") {
          list.sort((a: any, b: any) => (Number(a.size) || 0) - (Number(b.size) || 0));
        } else if (sort === "title_asc") {
          list.sort((a: any, b: any) => {
            const at = a.seriesTitle || a.name || path.basename(a.path);
            const bt = b.seriesTitle || b.name || path.basename(b.path);
            return at.localeCompare(bt);
          });
        } else if (sort === "date_desc") {
          list.sort((a: any, b: any) => (b.updatedAt ? new Date(b.updatedAt).getTime() : 0) - (a.updatedAt ? new Date(a.updatedAt).getTime() : 0));
        }
        return list;
      }

      // CASE 1: Games only (Pushdown to Neon DB)
      if (type === "games") {
        if (pool) {
          let whereSql = "WHERE 1=1";
          const params: any[] = [];
          if (platformFilter) {
            params.push(platformFilter);
            whereSql += ` AND LOWER(platform) = $${params.length}`;
          }
          if (search) {
            params.push(`%${search}%`);
            whereSql += ` AND (LOWER(title) LIKE $${params.length} OR LOWER(relative_path) LIKE $${params.length})`;
          }
          if (driveFilter !== "ALL") {
            if (driveFilter === "E:") {
              whereSql += " AND (file_size > 0 OR relative_path LIKE 'E:%')";
            } else if (driveFilter === "C:") {
              whereSql += " AND relative_path LIKE 'C:%'";
            } else if (driveFilter === "I:" || driveFilter === "CLOUD" || driveFilter === "GOOGLE DRIVE") {
              whereSql += " AND (relative_path LIKE 'I:%' OR relative_path ILIKE '%cloud%')";
            }
          }

          let orderSql = "ORDER BY file_size DESC NULLS LAST, title ASC";
          if (sort === "size_asc") orderSql = "ORDER BY file_size ASC NULLS LAST, title ASC";
          else if (sort === "title_asc") orderSql = "ORDER BY title ASC";
          else if (sort === "date_desc") orderSql = "ORDER BY updated_at DESC NULLS LAST, id DESC";

          const total = await getGamesTotal(pool, whereSql, params);

          params.push(limit);
          const limitIdx = params.length;
          params.push(offset);
          const offsetIdx = params.length;

          const dataRes = await pool.query(
            `SELECT id, title, platform, relative_path, file_size, box_art, updated_at FROM games ${whereSql} ${orderSql} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            params
          );

          const items = dataRes.rows.map(formatGameRow);
          return res.json({ ok: true, total, offset, limit, items });
        } else {
          let gList = [...mem.games];
          if (platformFilter) gList = gList.filter((g) => (g.platform || "").toLowerCase() === platformFilter);
          if (search) gList = gList.filter((g) => (g.title || "").toLowerCase().includes(search));
          const total = gList.length;
          const items = gList.slice(offset, offset + limit).map(formatGameRow);
          return res.json({ ok: true, total, offset, limit, items });
        }
      }

      // CASE 2: Media only
      if (type === "media") {
        const filtered = filterMediaList();
        sortMediaList(filtered);
        const total = filtered.length;
        const items = filtered.slice(offset, offset + limit).map(formatMediaRow);
        return res.json({ ok: true, total, offset, limit, items });
      }

      // CASE 3: Both Games and Media
      let gamesTotal = 0;
      let gameItems: any[] = [];

      if (pool) {
        let whereSql = "WHERE 1=1";
        const params: any[] = [];
        if (platformFilter) {
          params.push(platformFilter);
          whereSql += ` AND LOWER(platform) = $${params.length}`;
        }
        if (search) {
          params.push(`%${search}%`);
          whereSql += ` AND (LOWER(title) LIKE $${params.length} OR LOWER(relative_path) LIKE $${params.length})`;
        }
        if (driveFilter !== "ALL") {
          if (driveFilter === "E:") {
            whereSql += " AND (file_size > 0 OR relative_path LIKE 'E:%')";
          } else if (driveFilter === "C:") {
            whereSql += " AND relative_path LIKE 'C:%'";
          } else if (driveFilter === "I:" || driveFilter === "CLOUD" || driveFilter === "GOOGLE DRIVE") {
            whereSql += " AND (relative_path LIKE 'I:%' OR relative_path ILIKE '%cloud%')";
          }
        }

        let orderSql = "ORDER BY file_size DESC NULLS LAST, title ASC";
        if (sort === "size_asc") orderSql = "ORDER BY file_size ASC NULLS LAST, title ASC";
        else if (sort === "title_asc") orderSql = "ORDER BY title ASC";
        else if (sort === "date_desc") orderSql = "ORDER BY updated_at DESC NULLS LAST, id DESC";

        gamesTotal = await getGamesTotal(pool, whereSql, params);

        const fetchMax = Math.min(500, offset + limit);
        params.push(fetchMax);
        const limitIdx = params.length;

        const dataRes = await pool.query(
          `SELECT id, title, platform, relative_path, file_size, box_art, updated_at FROM games ${whereSql} ${orderSql} LIMIT $${limitIdx}`,
          params
        );
        gameItems = dataRes.rows.map(formatGameRow);
      } else {
        gamesTotal = mem.games.length;
        gameItems = mem.games.slice(0, offset + limit).map(formatGameRow);
      }

      const mediaFiltered = filterMediaList();
      sortMediaList(mediaFiltered);
      const mediaTotal = mediaFiltered.length;
      const mediaItems = mediaFiltered.slice(0, offset + limit).map(formatMediaRow);

      const combined = [...gameItems, ...mediaItems];
      if (sort === "size_desc") {
        combined.sort((a, b) => b.size - a.size);
      } else if (sort === "size_asc") {
        combined.sort((a, b) => a.size - b.size);
      } else if (sort === "title_asc") {
        combined.sort((a, b) => a.title.localeCompare(b.title));
      } else if (sort === "date_desc") {
        combined.sort((a, b) => (b.updatedAt ? new Date(b.updatedAt).getTime() : 0) - (a.updatedAt ? new Date(a.updatedAt).getTime() : 0));
      }

      const total = gamesTotal + mediaTotal;
      const items = combined.slice(offset, offset + limit);

      return res.json({
        ok: true,
        total,
        offset,
        limit,
        items,
      });
    } catch (err: any) {
      log("ERROR", `library items query failed: ${err.message}`, "library");
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // 3. Delete items safely
  app.post("/api/library/delete", async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;
      if (!(await isAdmin(auth))) {
        return res.status(403).json({ error: "Only administrators can delete installed library items." });
      }

      const itemsToDelete: Array<{ id: string; type: "game" | "media" }> = req.body?.items ?? [];
      if (!Array.isArray(itemsToDelete) || itemsToDelete.length === 0) {
        return res.status(400).json({ error: "No items specified for deletion." });
      }

      const cfg = await getVaultConfig().catch(() => ({ root_path: "C:\\Users\\mraaz\\nexus-cloud-media\\roms" }));
      const extraRoots = getExtraRoots(cfg);

      let deletedCount = 0;
      let freedBytes = 0;
      const errors: string[] = [];

      for (const item of itemsToDelete) {
        try {
          if (item.type === "game") {
            // Query game row
            let gRow: any = null;
            if (pool) {
              const r = await pool.query("SELECT * FROM games WHERE id::text = $1", [item.id]);
              gRow = r.rows[0];
            } else {
              gRow = mem.games.find(g => String(g.id) === String(item.id));
            }

            if (!gRow) {
              errors.push(`Game ID ${item.id} not found`);
              continue;
            }

            const resolved = await resolveRomPath(cfg.root_path, gRow, extraRoots);
            const absPath = resolved.absolutePath;

            if (absPath && existsSync(absPath)) {
              // Safety check: ensure file path is in a designated storage directory
              const norm = path.resolve(absPath);
              const isSafe = /^[E-Z]:[\\/]|nexus-cloud-media|videos|media|nexusarchive/i.test(norm) && !/windows|system32|program files/i.test(norm);
              if (isSafe) {
                const st = await stat(norm).catch(() => null);
                const fileSz = st?.size || Number(gRow.file_size) || 0;
                if (st?.isDirectory()) {
                  await rm(norm, { recursive: true, force: true });
                } else {
                  await unlink(norm);
                }
                freedBytes += fileSz;
                log("INFO", `Deleted game file: ${norm} (${humanBytes(fileSz)})`, "library");
              } else {
                errors.push(`File path ${norm} is not in a recognized safe library directory`);
              }
            }

            // Remove from database
            if (pool) {
              await pool.query("DELETE FROM games WHERE id::text = $1", [item.id]);
            }
            mem.games = mem.games.filter(g => String(g.id) !== String(item.id));
            deletedCount++;
          } else if (item.type === "media") {
            const mItem = (mem.media || []).find(m => String(m.id) === String(item.id));
            if (!mItem) {
              errors.push(`Media ID ${item.id} not found`);
              continue;
            }

            const norm = path.resolve(mItem.path);
            const isSafe = /^[E-Z]:[\\/]|nexus-cloud-media|videos|media|nexusarchive/i.test(norm) && !/windows|system32|program files/i.test(norm);
            if (isSafe && existsSync(norm)) {
              const st = await stat(norm).catch(() => null);
              const fileSz = st?.size || Number(mItem.size) || 0;
              await unlink(norm);
              freedBytes += fileSz;
              log("INFO", `Deleted media file: ${norm} (${humanBytes(fileSz)})`, "library");
            }

            // Remove from in-memory media list
            mem.media = (mem.media || []).filter(m => String(m.id) !== String(item.id));
            deletedCount++;
          }
        } catch (itemErr: any) {
          log("WARN", `Failed to delete item ${item.id}: ${itemErr.message}`, "library");
          errors.push(`Item ${item.id}: ${itemErr.message}`);
        }
      }

      return res.json({
        ok: true,
        deletedCount,
        freedBytes,
        freedFormatted: humanBytes(freedBytes),
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err: any) {
      log("ERROR", `library delete failed: ${err.message}`, "library");
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  // 4. Move an item to another storage root (e.g. migrate between E: and Google Drive)
  app.post("/api/library/move", async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;
      if (!(await isAdmin(auth))) {
        return res.status(403).json({ error: "Only administrators can move installed library items." });
      }

      const { id, type, targetDrive } = req.body ?? {};
      if (!id || !type || !targetDrive) {
        return res.status(400).json({ error: "Missing required parameters: id, type, targetDrive." });
      }

      const cfg = await getVaultConfig().catch(() => ({ root_path: "C:\\Users\\mraaz\\nexus-cloud-media\\roms" }));
      const extraRoots = getExtraRoots(cfg);

      if (type === "game") {
        let gRow: any = null;
        if (pool) {
          const r = await pool.query("SELECT * FROM games WHERE id::text = $1", [id]);
          gRow = r.rows[0];
        } else {
          gRow = mem.games.find(g => String(g.id) === String(id));
        }

        if (!gRow) return res.status(404).json({ error: "Game not found." });

        const resolved = await resolveRomPath(cfg.root_path, gRow, extraRoots);
        const sourcePath = resolved.absolutePath;
        if (!sourcePath || !existsSync(sourcePath)) {
          return res.status(404).json({ error: "Game ROM file not found on disk." });
        }

        // Determine destination path
        const base = path.basename(sourcePath);
        const platform = gRow.platform || "other";
        let destRoot = "";

        if (targetDrive.toUpperCase().startsWith("E:")) {
          destRoot = path.join("E:\\ROMS", platform);
        } else if (targetDrive.toUpperCase().startsWith("I:") || targetDrive.toLowerCase().includes("drive")) {
          destRoot = path.join("I:\\My Drive\\NexusArchive\\roms", platform);
        } else if (targetDrive.toUpperCase().startsWith("F:")) {
          destRoot = path.join("F:\\SaveState\\client-roms", platform);
        } else {
          return res.status(400).json({ error: `Unsupported target drive: ${targetDrive}` });
        }

        await mkdir(destRoot, { recursive: true });
        const destPath = path.join(destRoot, base);

        if (sourcePath === destPath) {
          return res.json({ ok: true, message: "File is already at destination.", path: destPath });
        }

        // Copy then unlink (safe across different filesystem devices)
        await copyFile(sourcePath, destPath);
        await unlink(sourcePath);

        // Update database relative path
        const newRel = `./${platform}/${base}`.replace(/\\/g, "/");
        if (pool) {
          await pool.query("UPDATE games SET relative_path = $1, updated_at = NOW() WHERE id::text = $2", [newRel, id]);
        }
        gRow.relative_path = newRel;

        log("INFO", `Moved game ${gRow.title} from ${sourcePath} to ${destPath}`, "library");
        return res.json({ ok: true, newPath: destPath, relativePath: newRel });
      }

      return res.status(400).json({ error: "Move currently supported for games." });
    } catch (err: any) {
      log("ERROR", `library move failed: ${err.message}`, "library");
      return res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  log("INFO", "Library Manager API registered (/api/library/...)", "library");
}
