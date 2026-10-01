/**
 * Files library: upload any file into category folders (Movies, Series,
 * Courses, Documents, …), browse, search, stream and download.
 *
 * Everything lives under one root folder. Only the Movies and Series folders
 * are also scanned into Movies & TV (see mediaRootsFor), so a course or a
 * personal video never shows up among the films.
 *
 * Uploads are chunked (8 MB) because Cloudflare rejects request bodies over
 * 100 MB, and resumable: the upload id is derived from who is uploading what,
 * so re-selecting the same file after a dropped connection or a page reload
 * continues from the chunks already on disk.
 *
 * Auth: the global gate in server.ts has already verified the token (header or
 * ?token=) and put it on req.authPayload; this module only decides what that
 * user may do.
 */
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs, writeFile, readFile, unlink } from "node:fs/promises";

export const DEFAULT_CATEGORIES = ["Movies", "Series", "Videos", "Courses", "Music", "Photos", "Documents", "Other"];
/** Categories whose videos also belong in Movies & TV. */
const MEDIA_LIBRARY_CATEGORIES = ["Movies", "Series"];

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = CHUNK_SIZE + 1024;
/** Keep this much free so an upload can never fill the disk. */
const DISK_RESERVE_BYTES = 2 * 1024 ** 3;
const STALE_UPLOAD_MS = 7 * 24 * 3600 * 1000;
const UPLOAD_DIR = ".uploads";

type FileType = "video" | "audio" | "image" | "document" | "archive" | "other";
const EXT_TYPES: Record<FileType, string[]> = {
  video: [".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".ts", ".m2ts", ".mts", ".3gp", ".ogv"],
  audio: [".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus", ".wma"],
  image: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".heic", ".avif"],
  document: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx", ".txt", ".md", ".rtf", ".odt", ".epub", ".srt", ".vtt"],
  archive: [".zip", ".rar", ".7z", ".tar", ".gz"],
  other: [],
};
const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
  ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".mts": "video/mp2t", ".3gp": "video/3gpp", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wma": "audio/x-ms-wma",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".avif": "image/avif", ".heic": "image/heic",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8", ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8",
};

export function fileTypeOf(name: string): FileType {
  const ext = path.extname(name).toLowerCase();
  for (const [t, exts] of Object.entries(EXT_TYPES)) if (exts.includes(ext)) return t as FileType;
  return "other";
}

/** The folders under root that Movies & TV should scan. */
export function mediaRootsFor(root: string): string[] {
  return MEDIA_LIBRARY_CATEGORIES.map((c) => path.join(root, c));
}

/** Folder/file names coming from a client: no separators, no dot-files, no reserved names. */
function cleanName(raw: unknown): string {
  const name = String(raw ?? "").normalize("NFC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim().replace(/[. ]+$/, "");
  if (!name || name.startsWith(".") || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return "";
  return name.slice(0, 180);
}

/** A client-supplied relative path, split into clean segments. "" is the root. */
function cleanRel(raw: unknown): string[] | null {
  const s = String(raw ?? "").replace(/\\/g, "/").trim();
  if (!s || s === "/") return [];
  const parts = s.split("/").filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const c = cleanName(p);
    if (!c || c !== p.trim().replace(/[. ]+$/, "") || p === "..") return null;
    out.push(c);
  }
  return out;
}

/** Same, but repairs segments instead of refusing them — for names we create (uploads, new folders). */
function sanitizeRel(raw: unknown): string[] | null {
  const parts = String(raw ?? "").replace(/\\/g, "/").split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) return null;
  return parts.map((p) => cleanName(p.replace(/^\.+/, "")) || "_");
}

type Perms = { userId: string; username: string; canView: boolean; canUpload: boolean; isAdmin: boolean };

export type FilesDeps = {
  root: string;
  /** Resolves who is calling and what they may do. */
  getUser: (payload: any) => Promise<{ role?: string; media_access?: boolean; can_upload_media?: boolean } | null>;
  log: (level: string, msg: string) => void;
  /** Called after anything changes under a media-library category. */
  onMediaChanged?: () => void;
};

export function registerFilesLibrary(app: express.Express, deps: FilesDeps) {
  const ROOT = path.resolve(deps.root);
  const TMP = path.join(ROOT, UPLOAD_DIR);

  const ensureRoot = (async () => {
    await mkdir(TMP, { recursive: true });
    for (const c of DEFAULT_CATEGORIES) await mkdir(path.join(ROOT, c), { recursive: true });
  })().catch((e) => deps.log("ERROR", `Files library root unavailable (${ROOT}): ${e?.message ?? e}`));

  function abs(segs: string[]): string {
    const p = path.resolve(ROOT, ...segs);
    if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error("outside root");
    return p;
  }

  async function perms(req: express.Request): Promise<Perms | null> {
    const payload = (req as any).authPayload;
    if (!payload) return null;
    if (payload.brain || payload.nexus) return { userId: "host", username: "host", canView: true, canUpload: true, isAdmin: true };
    if (!payload.userId) return null;
    const u = await deps.getUser(payload).catch(() => null);
    if (!u) return null;
    const isAdmin = ["admin", "superadmin", "ultra_admin"].includes(u.role ?? "");
    return {
      userId: String(payload.userId), username: String(payload.username ?? "user"),
      isAdmin, canView: isAdmin || !!u.media_access, canUpload: isAdmin || !!u.can_upload_media,
    };
  }

  function guard(need: "view" | "upload" | "admin", handler: (req: express.Request, res: express.Response, p: Perms) => Promise<unknown>) {
    return async (req: express.Request, res: express.Response) => {
      try {
        await ensureRoot;
        const p = await perms(req);
        if (!p) return res.status(401).json({ error: "Please sign in" });
        const ok = need === "view" ? p.canView : need === "upload" ? p.canUpload : p.isAdmin;
        if (!ok) {
          const why = need === "view" ? "The host hasn't given you access to the library yet."
            : need === "upload" ? "The host hasn't given you permission to upload." : "Only the host can do that.";
          return res.status(403).json({ error: why });
        }
        await handler(req, res, p);
      } catch (e: any) {
        if (!res.headersSent) res.status(500).json({ error: String(e?.message ?? e) });
      }
    };
  }

  // ── Index (for listing counts and search) ──────────────────────────────
  type Entry = { path: string; name: string; size: number; mtime: number; type: FileType; category: string };
  let index: { at: number; files: Entry[] } | null = null;
  let building: Promise<Entry[]> | null = null;
  const invalidate = (rel?: string) => {
    index = null;
    if (rel && MEDIA_LIBRARY_CATEGORIES.some((c) => rel === c || rel.startsWith(c + "/"))) deps.onMediaChanged?.();
  };

  async function allFiles(): Promise<Entry[]> {
    if (index && Date.now() - index.at < 60_000) return index.files;
    if (building) return building;
    building = (async () => {
      const out: Entry[] = [];
      const walk = async (dir: string, rel: string, depth: number) => {
        if (depth > 12) return;
        let ents: import("node:fs").Dirent[];
        try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const d of ents) {
          if (d.name.startsWith(".")) continue;
          const r = rel ? `${rel}/${d.name}` : d.name;
          const full = path.join(dir, d.name);
          if (d.isDirectory()) { await walk(full, r, depth + 1); continue; }
          if (!d.isFile()) continue;
          const st = await stat(full).catch(() => null);
          if (!st) continue;
          out.push({ path: r, name: d.name, size: st.size, mtime: st.mtimeMs, type: fileTypeOf(d.name), category: r.split("/")[0] });
        }
      };
      await walk(ROOT, "", 0);
      index = { at: Date.now(), files: out };
      return out;
    })().finally(() => { building = null; });
    return building;
  }

  // ── Browse ─────────────────────────────────────────────────────────────
  app.get("/api/files/categories", guard("view", async (_req, res) => {
    const files = await allFiles();
    const dirs = (await readdir(ROOT, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith("."));
    const cats = dirs.map((d) => {
      const inCat = files.filter((f) => f.category === d.name);
      return {
        name: d.name,
        builtin: DEFAULT_CATEGORIES.includes(d.name),
        inMediaLibrary: MEDIA_LIBRARY_CATEGORIES.includes(d.name),
        count: inCat.length,
        size: inCat.reduce((a, f) => a + f.size, 0),
        updated: inCat.reduce((a, f) => Math.max(a, f.mtime), 0),
      };
    });
    const order = (n: string) => { const i = DEFAULT_CATEGORIES.indexOf(n); return i < 0 ? 100 : i; };
    cats.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
    let free: number | null = null;
    try { const s = await statfs(ROOT); free = Number(s.bavail) * Number(s.bsize); } catch { /* unknown */ }
    res.json({ categories: cats, totalFiles: files.length, totalSize: files.reduce((a, f) => a + f.size, 0), freeBytes: free });
  }));

  app.get("/api/files/list", guard("view", async (req, res) => {
    const segs = cleanRel(req.query.path);
    if (!segs) return res.status(400).json({ error: "Invalid path" });
    const dir = abs(segs);
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) return res.status(404).json({ error: "Folder not found" });
    const rel = segs.join("/");
    const files = await allFiles();
    const ents = await readdir(dir, { withFileTypes: true });
    const folders: any[] = [];
    const items: any[] = [];
    for (const d of ents) {
      if (d.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        const inside = files.filter((f) => f.path.startsWith(r + "/"));
        folders.push({ name: d.name, path: r, count: inside.length, size: inside.reduce((a, f) => a + f.size, 0), mtime: inside.reduce((a, f) => Math.max(a, f.mtime), 0) });
      } else if (d.isFile()) {
        const s = await stat(path.join(dir, d.name)).catch(() => null);
        if (s) items.push({ name: d.name, path: r, size: s.size, mtime: s.mtimeMs, type: fileTypeOf(d.name) });
      }
    }
    const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    folders.sort((a, b) => natural.compare(a.name, b.name));
    items.sort((a, b) => natural.compare(a.name, b.name));
    res.json({ path: rel, folders, files: items });
  }));

  app.get("/api/files/search", guard("view", async (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase().trim();
    const type = String(req.query.type ?? "").trim();
    const category = String(req.query.category ?? "").trim();
    const sort = String(req.query.sort ?? (q ? "relevance" : "recent"));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const words = q.split(/\s+/).filter(Boolean);
    let hits = (await allFiles()).filter((f) =>
      (!type || f.type === type) && (!category || f.category === category) &&
      words.every((w) => f.path.toLowerCase().includes(w)));
    if (sort === "recent") hits.sort((a, b) => b.mtime - a.mtime);
    else if (sort === "size") hits.sort((a, b) => b.size - a.size);
    else if (sort === "name") hits.sort((a, b) => a.name.localeCompare(b.name));
    else hits.sort((a, b) => {
      // Name matches before folder-only matches, then newest.
      const an = words.every((w) => a.name.toLowerCase().includes(w)) ? 1 : 0;
      const bn = words.every((w) => b.name.toLowerCase().includes(w)) ? 1 : 0;
      return bn - an || b.mtime - a.mtime;
    });
    res.json({ total: hits.length, results: hits.slice(0, limit) });
  }));

  // ── Stream / download ──────────────────────────────────────────────────
  app.get("/api/files/raw", guard("view", async (req, res) => {
    const segs = cleanRel(req.query.path);
    if (!segs || !segs.length) return res.status(400).json({ error: "Invalid path" });
    const file = abs(segs);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return res.status(404).json({ error: "File not found" });
    const name = segs[segs.length - 1];
    const ext = path.extname(name).toLowerCase();
    const download = req.query.download === "1";
    // Only types a browser can safely render inline are served inline; the
    // rest are always downloads, so an uploaded .html/.svg can never run as a
    // page on this origin.
    const inlineOk = !download && MIME[ext] && ext !== ".svg";
    res.setHeader("Content-Type", inlineOk ? MIME[ext] : "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${inlineOk ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7E]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start); end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) { res.setHeader("Content-Range", `bytes */${st.size}`); return res.status(416).end(); }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(file, { start, end, highWaterMark: 2 * 1024 * 1024 }).on("error", () => res.destroy()).pipe(res);
      return;
    }
    res.setHeader("Content-Length", String(st.size));
    createReadStream(file, { highWaterMark: 2 * 1024 * 1024 }).on("error", () => res.destroy()).pipe(res);
  }));

  // ── Manage ─────────────────────────────────────────────────────────────
  app.post("/api/files/folder", express.json(), guard("upload", async (req, res) => {
    const segs = sanitizeRel(req.body?.path);
    if (!segs || !segs.length) return res.status(400).json({ error: "Give the folder a name (no / \\ : * ? \" < > |)" });
    await mkdir(abs(segs), { recursive: true });
    invalidate(segs.join("/"));
    res.json({ ok: true, path: segs.join("/") });
  }));

  app.post("/api/files/move", express.json(), guard("upload", async (req, res, p) => {
    const from = cleanRel(req.body?.from);
    const to = sanitizeRel(req.body?.to);
    if (!from?.length || !to?.length) return res.status(400).json({ error: "Invalid name" });
    if (from.length === 1 && DEFAULT_CATEGORIES.includes(from[0]) && !p.isAdmin) return res.status(403).json({ error: "Built-in categories can't be renamed" });
    const src = abs(from);
    const dst = abs(to);
    if (dst === src) return res.json({ ok: true, path: to.join("/") });
    if (dst.startsWith(src + path.sep)) return res.status(400).json({ error: "Can't move a folder into itself" });
    if (!existsSync(src)) return res.status(404).json({ error: "Not found" });
    if (existsSync(dst)) return res.status(409).json({ error: "Something with that name already exists there" });
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(src, dst);
    invalidate(from.join("/")); invalidate(to.join("/"));
    deps.log("INFO", `Files: ${p.username} moved ${from.join("/")} → ${to.join("/")}`);
    res.json({ ok: true, path: to.join("/") });
  }));

  app.delete("/api/files", guard("admin", async (req, res, p) => {
    const segs = cleanRel(req.query.path);
    if (!segs?.length) return res.status(400).json({ error: "Invalid path" });
    if (segs.length === 1 && DEFAULT_CATEGORIES.includes(segs[0])) return res.status(400).json({ error: "Built-in categories can't be deleted" });
    const target = abs(segs);
    if (!existsSync(target)) return res.status(404).json({ error: "Not found" });
    await rm(target, { recursive: true, force: true });
    invalidate(segs.join("/"));
    deps.log("INFO", `Files: ${p.username} deleted ${segs.join("/")}`);
    res.json({ ok: true });
  }));

  // ── Upload (chunked, resumable) ────────────────────────────────────────
  const idPattern = /^[a-f0-9]{32}$/;
  const metaPath = (id: string) => path.join(TMP, id, "meta.json");
  const chunkPath = (id: string, i: number) => path.join(TMP, id, `${i}.part`);

  async function receivedChunks(id: string, total: number): Promise<number[]> {
    const got: number[] = [];
    for (let i = 0; i < total; i++) {
      const s = await stat(chunkPath(id, i)).catch(() => null);
      if (s) got.push(i);   // written then renamed, so existing means complete
    }
    return got;
  }

  app.post("/api/files/upload/init", express.json(), guard("upload", async (req, res, p) => {
    const dir = sanitizeRel(req.body?.dir);
    const name = cleanName(String(req.body?.name ?? "").replace(/^\.+/, ""));
    const size = Number(req.body?.size);
    if (!dir || !dir.length) return res.status(400).json({ error: "Pick a category first" });
    if (!name) return res.status(400).json({ error: "That file name isn't allowed" });
    if (!Number.isFinite(size) || size < 0) return res.status(400).json({ error: "Invalid size" });
    try {
      const fs = await statfs(ROOT);
      const free = Number(fs.bavail) * Number(fs.bsize);
      if (size > free - DISK_RESERVE_BYTES) return res.status(507).json({ error: `Not enough space on the host (${(free / 1024 ** 3).toFixed(1)} GB free)` });
    } catch { /* statfs unsupported — let the write fail naturally */ }
    const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    const id = crypto.createHash("sha256")
      .update(JSON.stringify([p.userId, dir.join("/"), name, size, Number(req.body?.lastModified) || 0]))
      .digest("hex").slice(0, 32);
    await mkdir(path.join(TMP, id), { recursive: true });
    await writeFile(metaPath(id), JSON.stringify({ dir, name, size, totalChunks, userId: p.userId, username: p.username, started: Date.now() }));
    res.json({ uploadId: id, chunkSize: CHUNK_SIZE, totalChunks, received: await receivedChunks(id, totalChunks) });
  }));

  app.put("/api/files/upload/:id/chunk", express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }), guard("upload", async (req, res) => {
    const id = String(req.params.id);
    const i = Number(req.query.index);
    if (!idPattern.test(id) || !Number.isInteger(i) || i < 0) return res.status(400).json({ error: "Bad chunk" });
    const meta = JSON.parse(await readFile(metaPath(id), "utf8").catch(() => "null"));
    if (!meta) return res.status(404).json({ error: "Upload not found — start it again" });
    if (i >= meta.totalChunks) return res.status(400).json({ error: "Chunk out of range" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const expected = i === meta.totalChunks - 1 ? meta.size - i * CHUNK_SIZE : CHUNK_SIZE;
    if (body.length !== expected) return res.status(400).json({ error: `Chunk ${i} is ${body?.length ?? 0} bytes, expected ${expected}` });
    // Write then rename, so a half-written chunk is never counted as received.
    const tmp = chunkPath(id, i) + ".tmp";
    await writeFile(tmp, body);
    await rename(tmp, chunkPath(id, i));
    res.json({ ok: true });
  }));

  app.post("/api/files/upload/:id/complete", express.json(), guard("upload", async (req, res, p) => {
    const id = String(req.params.id);
    if (!idPattern.test(id)) return res.status(400).json({ error: "Bad upload id" });
    const meta = JSON.parse(await readFile(metaPath(id), "utf8").catch(() => "null"));
    if (!meta) return res.status(404).json({ error: "Upload not found" });
    const got = await receivedChunks(id, meta.totalChunks);
    if (got.length !== meta.totalChunks) return res.status(409).json({ error: "Some pieces are missing", received: got });

    const dirAbs = abs(meta.dir);
    await mkdir(dirAbs, { recursive: true });
    // Never overwrite: "Lecture 1.mp4" → "Lecture 1 (2).mp4".
    const ext = path.extname(meta.name);
    const stem = meta.name.slice(0, meta.name.length - ext.length);
    let finalName = meta.name;
    for (let n = 2; existsSync(path.join(dirAbs, finalName)); n++) finalName = `${stem} (${n})${ext}`;
    const partial = path.join(dirAbs, `.${finalName}.partial`);
    const out = createWriteStream(partial);
    try {
      for (let i = 0; i < meta.totalChunks; i++) {
        await new Promise<void>((ok, fail) => {
          const rs = createReadStream(chunkPath(id, i));
          rs.on("error", fail);
          rs.on("end", () => ok());
          rs.pipe(out, { end: false });
        });
      }
      await new Promise<void>((ok, fail) => { out.on("error", fail); out.end(() => ok()); });
    } catch (e) {
      out.destroy();
      await unlink(partial).catch(() => {});
      throw e;
    }
    const st = await stat(partial);
    if (st.size !== meta.size) { await unlink(partial).catch(() => {}); return res.status(500).json({ error: "Assembled file has the wrong size — please upload again" }); }
    await rename(partial, path.join(dirAbs, finalName));
    await rm(path.join(TMP, id), { recursive: true, force: true });
    const rel = [...meta.dir, finalName].join("/");
    invalidate(rel);
    deps.log("INFO", `Files: ${p.username} uploaded ${rel} (${(meta.size / 1024 ** 2).toFixed(1)} MB)`);
    res.json({ ok: true, path: rel, name: finalName, size: meta.size, type: fileTypeOf(finalName) });
  }));

  app.delete("/api/files/upload/:id", guard("upload", async (req, res) => {
    const id = String(req.params.id);
    if (!idPattern.test(id)) return res.status(400).json({ error: "Bad upload id" });
    await rm(path.join(TMP, id), { recursive: true, force: true });
    res.json({ ok: true });
  }));

  // Abandoned uploads are cleared after a week.
  setInterval(async () => {
    try {
      for (const id of await readdir(TMP)) {
        const s = await stat(path.join(TMP, id)).catch(() => null);
        if (s && Date.now() - s.mtimeMs > STALE_UPLOAD_MS) await rm(path.join(TMP, id), { recursive: true, force: true });
      }
    } catch { /* nothing to clean */ }
  }, 6 * 3600 * 1000).unref();

  deps.log("INFO", `Files library at ${ROOT}`);
}
