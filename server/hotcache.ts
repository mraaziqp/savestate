/**
 * Hot cache: local copies of what people play from the Google Drive library.
 *
 * The library lives on Google Drive (Drive for Desktop, I:), so the first read
 * of any film or game comes from Google and a seek can stall while it fetches.
 * Drive's own cache is small and shared with everything else on the drive.
 * This keeps a copy, on a fast local disk, of:
 *   - each film or episode someone starts, and the next episode in its folder
 *     (so "next episode" starts at once);
 *   - each game someone downloads to play, and each game added through
 *     Games > Add games (the upload is still on this PC; it's kept, not refetched).
 * The player and the game download read the local copy when it is complete
 * and the original hasn't changed (same size and modified time). The oldest
 * unused copies make room when it's full, and it always leaves free space on
 * its disk. Files that are already on a local disk are never copied.
 */
import type express from "express";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, stat, statfs, readdir, copyFile, link, utimes } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Caller } from "./access.ts";

export type HotCacheDeps = {
  persistDir: string;
  callerOf: (req: express.Request) => Promise<Caller>;
  log: (level: string, msg: string) => void;
};

type Entry = { src: string; size: number; mtimeMs: number; file: string; addedAt: number; usedAt: number; reason: string; hits: number };
type Settings = { dir: string; maxGb: number; enabled: boolean };

const GB = 1024 ** 3;
/** Always leave this much free on the cache's disk. */
const KEEP_FREE = 10 * GB;
const VIDEO = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|ts|m2ts|mts|mpg|mpeg|flv|3gp|ogv)$/i;

export function createHotCache(deps: HotCacheDeps) {
  const settingsFile = path.join(deps.persistDir, "hot-cache.json");
  const defaults: Settings = { dir: path.join(deps.persistDir, "hot-cache"), maxGb: 20, enabled: true };
  let settings: Settings = { ...defaults };
  try {
    const saved = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings = { ...defaults, ...saved };
  } catch { /* first run */ }

  const index = new Map<string, Entry>();
  const indexFile = () => path.join(settings.dir, "index.json");
  let dirty = false;
  let hits = 0, misses = 0, copiedBytes = 0;
  const queue: Array<{ src: string; reason: string }> = [];
  const queued = new Set<string>();
  let working: { src: string; reason: string; done: number; size: number } | null = null;
  let lastError = "";

  const keyOf = (src: string) => createHash("sha1").update(path.resolve(src).toLowerCase()).digest("hex");

  async function loadIndex() {
    index.clear();
    try {
      const rows = JSON.parse(await readFile(indexFile(), "utf8")) as Entry[];
      for (const e of rows) if (e?.src && e.file && existsSync(e.file)) index.set(keyOf(e.src), e);
    } catch { /* empty */ }
  }
  const saveIndex = async () => {
    if (!dirty) return;
    dirty = false;
    try { await mkdir(settings.dir, { recursive: true }); await writeFile(indexFile(), JSON.stringify([...index.values()])); } catch { dirty = true; }
  };
  const flush = setInterval(() => { void saveIndex(); }, 30_000);
  flush.unref?.();
  const ready = loadIndex();

  // ── Which files live in the cloud ───────────────────────────────────────
  // Drive for Desktop shows up as a drive letter with a "My Drive" folder;
  // the library reaches it through a junction (nexus-cloud-media). The real
  // path of each folder is looked up once.
  const cloudLetter = new Map<string, boolean>();
  const realDir = new Map<string, string>();
  function isCloud(file: string): boolean {
    const dir = path.dirname(file);
    let real = realDir.get(dir);
    if (real === undefined) {
      try { real = realpathSync.native(dir); } catch { real = dir; }
      if (realDir.size > 5000) realDir.clear();
      realDir.set(dir, real);
    }
    const m = /^([A-Za-z]):[\\/]/.exec(real);
    if (!m) return /^\/(mnt|media)\/.*(gdrive|google|drive)/i.test(real); // a NAS with an rclone or Drive mount
    const letter = m[1].toUpperCase();
    if (!cloudLetter.has(letter)) cloudLetter.set(letter, existsSync(`${letter}:\\My Drive`) || existsSync(`${letter}:\\Shared drives`));
    return cloudLetter.get(letter)!;
  }

  // ── Reading ─────────────────────────────────────────────────────────────
  /** The local copy of `src` when there is a complete, current one; else `src`. */
  function pick(src: string, st?: { size: number; mtimeMs: number }): string {
    if (!settings.enabled) return src;
    const e = index.get(keyOf(src));
    if (!e) { if (isCloud(src)) misses++; return src; }
    let cur = st;
    if (!cur) { try { cur = statSync(src); } catch { return src; } }
    if (e.size !== cur.size || Math.abs(e.mtimeMs - cur.mtimeMs) > 2000 || !existsSync(e.file)) {
      index.delete(keyOf(src)); dirty = true;
      void rm(e.file, { force: true });
      misses++;
      return src;
    }
    e.usedAt = Date.now(); e.hits++; hits++; dirty = true;
    return e.file;
  }

  /** Copy `src` into the cache in the background (when it's in the cloud and fits). */
  function warm(src: string, reason: string) {
    if (!settings.enabled || !isCloud(src)) return;
    const k = keyOf(src);
    if (index.has(k) || queued.has(k)) return;
    queued.add(k);
    queue.push({ src, reason });
    void run();
  }

  /**
   * Someone started this film or episode: keep it, and the next one in its
   * folder. The copy starts after the first minute, so it never competes
   * with the player for the start of the film.
   */
  const startedAt = new Map<string, number>();
  async function played(src: string) {
    if (!settings.enabled || !isCloud(src)) return;
    const k = keyOf(src);
    if (index.has(k) || queued.has(k) || Date.now() - (startedAt.get(k) ?? 0) < 10 * 60_000) return;
    startedAt.set(k, Date.now());
    if (startedAt.size > 500) startedAt.clear();
    await new Promise((r) => setTimeout(r, 45_000).unref?.());
    warm(src, "watched");
    try {
      const dir = path.dirname(src);
      const names = (await readdir(dir)).filter((n) => VIDEO.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const i = names.indexOf(path.basename(src));
      if (i >= 0 && i + 1 < names.length) warm(path.join(dir, names[i + 1]), "next episode");
    } catch { /* folder unreadable */ }
  }

  /** A file that is already on this PC (an upload) and is about to go to Drive: keep it as the cached copy. */
  async function adopt(localFile: string, cloudDest: string, reason: string) {
    if (!settings.enabled) return;
    try {
      await ready;
      const st = await stat(cloudDest);
      if (!(await roomFor(st.size))) return;
      const k = keyOf(cloudDest);
      const file = path.join(settings.dir, k.slice(0, 2), k + path.extname(cloudDest));
      await mkdir(path.dirname(file), { recursive: true });
      try { await link(localFile, file); } catch { await copyFile(localFile, file); }
      await utimes(file, st.atime, st.mtime).catch(() => {});
      index.set(k, { src: cloudDest, size: st.size, mtimeMs: st.mtimeMs, file, addedAt: Date.now(), usedAt: Date.now(), reason, hits: 0 });
      dirty = true;
    } catch (e: any) { lastError = String(e?.message ?? e).slice(0, 160); }
  }

  // ── Room ────────────────────────────────────────────────────────────────
  const used = () => [...index.values()].reduce((n, e) => n + e.size, 0);
  async function freeOnDisk(): Promise<number> {
    try { const s = await statfs(settings.dir); return Number(s.bavail) * Number(s.bsize); } catch { return 0; }
  }
  /** Make room for `size` bytes by dropping the least recently used copies. */
  async function roomFor(size: number): Promise<boolean> {
    await mkdir(settings.dir, { recursive: true });
    const max = settings.maxGb * GB;
    if (size > max / 3) return false; // one file never takes most of the cache
    const lru = [...index.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    let total = used();
    let free = await freeOnDisk();
    while ((total + size > max || free - size < KEEP_FREE) && lru.length) {
      const [k, e] = lru.shift()!;
      index.delete(k); dirty = true;
      await rm(e.file, { force: true }).catch(() => {});
      total -= e.size; free += e.size;
    }
    return total + size <= max && free - size >= KEEP_FREE;
  }

  // ── The copier: one file at a time, so a copy never crowds out playback ──
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    await ready;
    try {
      while (queue.length) {
        const job = queue.shift()!;
        const k = keyOf(job.src);
        try {
          const st = await stat(job.src);
          if (!st.isFile() || index.has(k) || !(await roomFor(st.size))) continue;
          const file = path.join(settings.dir, k.slice(0, 2), k + path.extname(job.src));
          const part = file + ".part";
          await mkdir(path.dirname(file), { recursive: true });
          working = { src: job.src, reason: job.reason, done: 0, size: st.size };
          const w = working;
          const rs = createReadStream(job.src, { highWaterMark: 4 * 1024 * 1024 });
          rs.on("data", (c) => { w.done += c.length; });
          await pipeline(rs, createWriteStream(part));
          const after = await stat(job.src);
          if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) { await rm(part, { force: true }); continue; }
          await rename(part, file);
          // Same modified time as the original, so downloads keep the same ETag.
          await utimes(file, st.atime, st.mtime).catch(() => {});
          index.set(k, { src: job.src, size: st.size, mtimeMs: st.mtimeMs, file, addedAt: Date.now(), usedAt: Date.now(), reason: job.reason, hits: 0 });
          dirty = true;
          copiedBytes += st.size;
        } catch (e: any) {
          lastError = `${path.basename(job.src)}: ${String(e?.message ?? e).slice(0, 140)}`;
          deps.log("WARN", `hot cache: ${lastError}`);
        } finally {
          queued.delete(k);
          working = null;
        }
      }
    } finally {
      running = false;
      void saveIndex();
    }
  }

  // ── Settings and the admin page ─────────────────────────────────────────
  async function applySettings(next: Partial<Settings>) {
    const moved = next.dir && path.resolve(next.dir) !== path.resolve(settings.dir);
    settings = { ...settings, ...next };
    await writeFile(settingsFile, JSON.stringify(settings, null, 2));
    if (moved) { await saveIndex(); await loadIndex(); }
    if (!settings.enabled) queue.length = 0;
    await roomFor(0);
    void saveIndex();
  }

  async function status() {
    await ready;
    const free = await freeOnDisk();
    const entries = [...index.values()].sort((a, b) => b.usedAt - a.usedAt);
    return {
      ...settings, usedBytes: used(), files: index.size, freeOnDisk: free, keepFree: KEEP_FREE,
      hits, misses, copiedBytes, lastError,
      copying: working ? { name: path.basename(working.src), reason: working.reason, done: working.done, size: working.size } : null,
      waiting: queue.length,
      recent: entries.slice(0, 40).map((e) => ({ name: path.basename(e.src), size: e.size, reason: e.reason, hits: e.hits, usedAt: e.usedAt })),
    };
  }

  function register(app: express.Express) {
    const admin = async (req: express.Request, res: express.Response) => {
      const c = await deps.callerOf(req);
      if (!c.admin) { res.status(403).json({ error: "admin_only", message: "Only the host's admins can do this." }); return false; }
      return true;
    };
    app.get("/api/admin/hot-cache", async (req, res) => {
      if (!(await admin(req, res))) return;
      res.setHeader("Cache-Control", "no-store");
      res.json(await status());
    });
    app.put("/api/admin/hot-cache", async (req, res) => {
      if (!(await admin(req, res))) return;
      const b = req.body ?? {};
      const next: Partial<Settings> = {};
      if (typeof b.enabled === "boolean") next.enabled = b.enabled;
      if (b.maxGb !== undefined) {
        const n = Number(b.maxGb);
        if (!Number.isFinite(n) || n < 1 || n > 4000) return res.status(400).json({ error: "Choose a size between 1 and 4000 GB." });
        next.maxGb = Math.round(n);
      }
      if (typeof b.dir === "string" && b.dir.trim()) {
        const dir = path.resolve(b.dir.trim());
        try { await mkdir(dir, { recursive: true }); } catch { return res.status(400).json({ error: "That folder can't be created. Choose a folder on a local disk." }); }
        if (isCloud(path.join(dir, "x"))) return res.status(400).json({ error: "That folder is on Google Drive. Choose a folder on a local disk (an SSD is best)." });
        next.dir = dir;
      }
      try { await applySettings(next); } catch (e: any) { return res.status(500).json({ error: `Could not save: ${e?.message ?? e}` }); }
      res.json(await status());
    });
    app.post("/api/admin/hot-cache/clear", async (req, res) => {
      if (!(await admin(req, res))) return;
      for (const e of index.values()) await rm(e.file, { force: true }).catch(() => {});
      index.clear(); dirty = true; hits = 0; misses = 0;
      await saveIndex();
      res.json(await status());
    });
  }

  return { pick, warm, played, adopt, isCloud, register, status };
}

