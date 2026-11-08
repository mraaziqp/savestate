import type express from "express";
import path from "node:path";
import { statfs, stat, unlink, rm, rename, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

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
  const m = /^([A-Za-z]:)/.exec(p);
  if (m) return m[1].toUpperCase();
  if (isCloud(p)) return "Google Drive";
  return "Local";
}

export function registerLibraryManagerApi(deps: LibraryManagerDeps) {
  const { app, pool, mem, log, requireAuth, isAdmin, resolveRomPath, getVaultConfig, getExtraRoots, refreshMediaLibrary } = deps;

  // 1. Storage summary across all physical and cloud drives
  app.get("/api/library/storage-summary", async (req, res) => {
    try {
      const candidates = ["C:\\", "E:\\", "F:\\", "I:\\"];
      const drives: Array<{ drive: string; label: string; totalBytes: number; freeBytes: number; usedBytes: number; totalFormatted: string; freeFormatted: string; percentUsed: number; isCloud: boolean }> = [];

      for (const d of candidates) {
        try {
          const s = await statfs(d);
          const total = Number(s.bsize) * Number(s.blocks);
          const free = Number(s.bsize) * Number(s.bavail);
          const used = Math.max(0, total - free);
          const isCl = d.startsWith("I:") || isCloud(d);
          const label = d.startsWith("C:") ? "SSD (System C:)"
            : d.startsWith("E:") ? "External Storage (E:)"
            : d.startsWith("F:") ? "Storage (F:)"
            : "Google Drive (I:)";

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

      const items: Array<{
        id: string;
        type: "game" | "media";
        title: string;
        platform?: string;
        category?: string;
        path: string;
        relativePath?: string;
        drive: string;
        size: number;
        sizeFormatted: string;
        isCloud: boolean;
        boxArt?: string | null;
        updatedAt?: string | null;
      }> = [];

      const cfg = await getVaultConfig().catch(() => ({ root_path: "C:\\Users\\mraaz\\nexus-cloud-media\\roms" }));
      const extraRoots = getExtraRoots(cfg);

      // Collect Games
      if (type === "all" || type === "games") {
        let gameRows: any[] = [];
        if (pool) {
          try {
            let sql = "SELECT id, title, platform, relative_path, file_size, box_art, updated_at FROM games WHERE 1=1";
            const params: any[] = [];
            if (platformFilter) {
              params.push(platformFilter);
              sql += ` AND LOWER(platform) = $${params.length}`;
            }
            if (search) {
              params.push(`%${search}%`);
              sql += ` AND (LOWER(title) LIKE $${params.length} OR LOWER(relative_path) LIKE $${params.length})`;
            }
            sql += " ORDER BY file_size DESC NULLS LAST, title ASC LIMIT 3000";
            const r = await pool.query(sql, params);
            gameRows = r.rows;
          } catch {
            gameRows = mem.games;
          }
        } else {
          gameRows = mem.games;
        }

        for (const g of gameRows) {
          const rel = String(g.relative_path ?? g.relativePath ?? "");
          let absPath = "";
          // Fast resolution: check if already absolute, or under root/extraRoots
          if (path.isAbsolute(rel) && existsSync(rel)) {
            absPath = rel;
          } else {
            // Check common roots
            const cand = path.resolve(cfg.root_path || "E:\\ROMS", rel.replace(/^\.\//, ""));
            if (existsSync(cand)) {
              absPath = cand;
            } else {
              absPath = rel; // fallback
            }
          }

          const drv = getDriveLetter(absPath);
          const isCl = isCloud(absPath);

          if (driveFilter !== "ALL") {
            if (driveFilter === "I:" || driveFilter === "CLOUD" || driveFilter === "GOOGLE DRIVE") {
              if (!isCl && drv !== "I:") continue;
            } else if (drv !== driveFilter) {
              continue;
            }
          }

          const sz = Number(g.file_size) || 0;

          items.push({
            id: String(g.id),
            type: "game",
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
          });
        }
      }

      // Collect Media
      if (type === "all" || type === "media") {
        const mediaList = (mem.media || []).filter(m => m.kind === "video");
        for (const m of mediaList) {
          const title = m.seriesTitle ? `${m.seriesTitle} S${String(m.season).padStart(2, "0")}E${String(m.episode).padStart(2, "0")}` : (m.name || path.basename(m.path));
          if (search && !title.toLowerCase().includes(search) && !m.path.toLowerCase().includes(search)) {
            continue;
          }
          if (categoryFilter && m.category !== categoryFilter) {
            continue;
          }

          const drv = getDriveLetter(m.path);
          const isCl = isCloud(m.path);

          if (driveFilter !== "ALL") {
            if (driveFilter === "I:" || driveFilter === "CLOUD" || driveFilter === "GOOGLE DRIVE") {
              if (!isCl && drv !== "I:") continue;
            } else if (drv !== driveFilter) {
              continue;
            }
          }

          const sz = Number(m.size) || 0;

          items.push({
            id: String(m.id),
            type: "media",
            title,
            category: m.category,
            path: m.path,
            relativePath: m.relPath,
            drive: drv,
            size: sz,
            sizeFormatted: humanBytes(sz),
            isCloud: isCl,
            boxArt: m.relatedCoverRelPath ? `/api/media/cover/${encodeURIComponent(m.id)}` : null,
            updatedAt: m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
          });
        }
      }

      // Sort
      if (sort === "size_desc") {
        items.sort((a, b) => b.size - a.size);
      } else if (sort === "size_asc") {
        items.sort((a, b) => a.size - b.size);
      } else if (sort === "title_asc") {
        items.sort((a, b) => a.title.localeCompare(b.title));
      } else if (sort === "date_desc") {
        items.sort((a, b) => (b.updatedAt ? new Date(b.updatedAt).getTime() : 0) - (a.updatedAt ? new Date(a.updatedAt).getTime() : 0));
      }

      const total = items.length;
      const paginated = items.slice(offset, offset + limit);

      return res.json({
        ok: true,
        total,
        offset,
        limit,
        items: paginated,
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
