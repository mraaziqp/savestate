/**
 * Folder uploads to the media library, planned as a whole and remembered.
 *
 * A folder is described to the server before any bytes move (paths and
 * sizes). The server decides where every file goes, looking at the batch as a
 * whole rather than one file at a time:
 *
 *   - episodes that carry no show name ("S02E05.mkv", "Episode 3.mp4") take it
 *     from their folders, or from the show their siblings belong to;
 *   - the same show spelt differently across loose files and season folders
 *     ("Lanterns.2025.S01E01", "lanterns/Season 2/...") lands in one folder;
 *   - an episode with no season is season 1;
 *   - subtitles and posters follow the video they belong to.
 *
 * The plan is saved (upload-batches/<id>.json in the data folder) with each
 * file's state, so an upload that is interrupted - a closed laptop, a lost
 * connection, a restarted host - carries on where it stopped, from any device
 * the member signs in on. Chunks already received are kept by the upload
 * routes themselves; sessions untouched for 14 days are cleared.
 */
import type express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { receipt, addLiveSource } from "./receipts.ts";

export type Classified = {
  kind: "video" | "subtitle" | "image" | "other";
  junk: boolean;
  isSeries: boolean;
  /** Show title as found in this file's own name or folders (normalised), or null. */
  title: string | null;
  season: number | null;
  episode: number | null;
  /** Where the per-file rules would put it (Movies/<title>/<file>, Assets/..., TV Shows/...). */
  target: string;
};

export type BatchDeps = {
  persistDir: string;
  tempDir: string;
  classify: (rel: string, size: number) => Classified;
  normTitle: (s: string) => string;
  seriesKey: (s: string) => string;
  safeSegment: (s: string) => string;
  seasonFolder: (n: number | null) => string;
  /** userId of a signed-in member allowed to upload to the library, or null. */
  uploader: (req: express.Request) => Promise<string | null>;
  log: (level: string, msg: string) => void;
};

type FileState = "pending" | "done" | "skipped" | "failed";
type BatchFile = {
  i: number; rel: string; size: number; lastModified?: number;
  kind: Classified["kind"]; target: string; show: string | null; season: number | null; episode: number | null;
  state: FileState; note?: string; doneAt?: number;
};
type Batch = {
  id: string; userId: string; name: string; createdAt: number; updatedAt: number;
  /** User's renames: series key -> title. */
  renames: Record<string, string>;
  files: BatchFile[];
};

const GENERIC = /^(?:movies?|films?|tv(?:[\s._-]*shows?)?|series|shows?|videos?|downloads?|media|season[\s._-]*\d*|s\d{1,2}|specials?|extras?|featurettes?|complete|new folder)$/i;

export function createUploadBatches(deps: BatchDeps) {
  const dir = path.join(deps.persistDir, "upload-batches");
  const fileOf = (id: string) => path.join(dir, `${id.replace(/[^a-f0-9-]/gi, "")}.json`);
  const cache = new Map<string, Batch>();

  async function load(id: string): Promise<Batch | null> {
    if (cache.has(id)) return cache.get(id)!;
    try { const b = JSON.parse(await readFile(fileOf(id), "utf8")) as Batch; cache.set(id, b); return b; } catch { return null; }
  }
  // One write at a time per batch; the last state always wins.
  const writing = new Map<string, Promise<void>>();
  function save(b: Batch): Promise<void> {
    b.updatedAt = Date.now();
    cache.set(b.id, b);
    const prev = writing.get(b.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(dir, { recursive: true });
      const tmp = `${fileOf(b.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(b));
      await rename(tmp, fileOf(b.id));
    }).catch((e) => deps.log("WARN", `Could not save upload batch ${b.id}: ${e?.message ?? e}`));
    writing.set(b.id, next);
    return next;
  }

  /** The folders a file sits in, nearest first, that could name a show. */
  function showFolders(rel: string): string[] {
    const segs = rel.split("/").slice(0, -1).reverse();
    const out: string[] = [];
    for (const s of segs) {
      const t = deps.normTitle(s);
      if (t && !GENERIC.test(t.trim()) && !GENERIC.test(s.trim())) out.push(t);
    }
    return out;
  }

  /** Decide every file's destination, looking at the whole batch. */
  function plan(b: Batch) {
    const info = b.files.map((f) => ({ f, c: deps.classify(f.rel, f.size) }));
    const videos = info.filter((x) => x.c.kind === "video" && !x.c.junk);

    // 1. Shows the batch names, and how often.
    const spellings = new Map<string, Map<string, number>>();
    const note = (t: string) => {
      const k = deps.seriesKey(t);
      if (!k) return;
      const m = spellings.get(k) ?? new Map<string, number>();
      m.set(t, (m.get(t) ?? 0) + 1);
      spellings.set(k, m);
    };
    for (const x of videos) if (x.c.isSeries && x.c.title) note(x.c.title);

    // 2. Episodes without a show name: the nearest folder that names a show
    //    the batch already knows, else the nearest folder that names anything,
    //    else the show most episodes in the same folder belong to.
    const dirOf = (rel: string) => rel.split("/").slice(0, -1).join("/");
    const showByDir = new Map<string, Map<string, number>>();
    for (const x of videos) {
      if (!x.c.isSeries || !x.c.title) continue;
      for (let d = dirOf(x.f.rel); ; d = dirOf(d)) {
        const m = showByDir.get(d) ?? new Map<string, number>();
        m.set(x.c.title, (m.get(x.c.title) ?? 0) + 1);
        showByDir.set(d, m);
        if (!d) break;
      }
    }
    const top = (m?: Map<string, number>) => (m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null);
    for (const x of videos) {
      if (!x.c.isSeries || x.c.title) continue;
      const folders = showFolders(x.f.rel);
      let t = folders.find((s) => spellings.has(deps.seriesKey(s))) ?? null;
      if (!t) for (let d = dirOf(x.f.rel); ; d = dirOf(d)) { t = top(showByDir.get(d)); if (t || !d) break; }
      t ??= folders[0] ?? null;
      if (t) { x.c.title = t; note(t); }
    }

    // 3. One spelling per show: the user's rename, else the most used, else the longest.
    const canonical = new Map<string, string>();
    for (const [k, m] of spellings) {
      canonical.set(k, b.renames[k] || [...m.entries()].sort((a, c) => c[1] - a[1] || c[0].length - a[0].length)[0][0]);
    }
    for (const [k, t] of Object.entries(b.renames)) if (!canonical.has(k)) canonical.set(k, t);

    // 4. Destinations.
    const placed = new Map<string, string>(); // "<dir>/<stem>" of a video -> its target folder
    for (const x of info) {
      const f = x.f;
      f.kind = x.c.kind;
      f.show = null; f.season = null; f.episode = null;
      if (x.c.junk || x.c.kind === "other") {
        f.target = "";
        if (f.state === "pending") { f.state = "skipped"; f.note = x.c.junk ? "Release extra (sample or screenshot)" : "Not a video, subtitle or picture"; }
        continue;
      }
      const name = deps.safeSegment(path.posix.basename(f.rel)) || `file-${f.i}`;
      if (x.c.kind === "video" && x.c.isSeries && x.c.title) {
        const show = canonical.get(deps.seriesKey(x.c.title)) ?? x.c.title;
        // A Specials / Extras folder of a show is season 0, as media servers expect.
        const season = /(^|\/)(specials?|extras?|featurettes?)(\/|$)/i.test(dirOf(f.rel)) ? 0 : x.c.season ?? 1;
        f.show = show; f.season = season; f.episode = x.c.episode;
        f.target = path.posix.join("TV Shows", deps.safeSegment(show), season === 0 ? "Specials" : deps.seasonFolder(season), name);
      } else {
        f.target = x.c.target;
        if (x.c.kind === "video" && x.c.target.startsWith("Movies/")) f.show = null;
      }
      if (x.c.kind === "video") placed.set(`${dirOf(f.rel)}/${stemOf(f.rel)}`.toLowerCase(), path.posix.dirname(f.target));
    }
    // Subtitles and posters next to the video they belong to.
    for (const x of info) {
      const f = x.f;
      if (f.kind !== "subtitle" && f.kind !== "image") continue;
      const d = dirOf(f.rel);
      const stem = stemOf(f.rel).replace(/\.(?:[a-z]{2,3}|forced|sdh|hi)$/i, "").replace(/\.(?:[a-z]{2,3}|forced|sdh|hi)$/i, "");
      let home = placed.get(`${d}/${stem}`.toLowerCase());
      if (!home && f.kind === "image") {
        // A poster in a show's folder belongs to the show.
        const sib = info.find((y) => y.f.kind === "video" && y.f.show && dirOf(y.f.rel).startsWith(d));
        if (sib) home = path.posix.join("TV Shows", deps.safeSegment(sib.f.show!));
      }
      if (!home) {
        const onlyVideo = info.filter((y) => y.f.kind === "video" && dirOf(y.f.rel) === d);
        if (onlyVideo.length === 1) home = path.posix.dirname(onlyVideo[0].f.target);
      }
      if (home) f.target = path.posix.join(home, deps.safeSegment(path.posix.basename(f.rel)));
    }
  }
  const stemOf = (rel: string) => path.posix.basename(rel).replace(/\.[^.]+$/, "");

  function summary(b: Batch) {
    const shows = new Map<string, { title: string; key: string; seasons: Record<number, number>; files: number; bytes: number }>();
    const movies: Array<{ title: string; files: number; bytes: number }> = [];
    const movieMap = new Map<string, { title: string; files: number; bytes: number }>();
    let total = 0, done = 0, bytes = 0, doneBytes = 0, skipped = 0, failed = 0;
    for (const f of b.files) {
      if (f.state === "skipped") { skipped++; continue; }
      total++; bytes += f.size;
      if (f.state === "done") { done++; doneBytes += f.size; }
      if (f.state === "failed") failed++;
      if (f.kind !== "video") continue;
      if (f.show) {
        const k = deps.seriesKey(f.show);
        const s = shows.get(k) ?? { title: f.show, key: k, seasons: {}, files: 0, bytes: 0 };
        s.seasons[f.season ?? 1] = (s.seasons[f.season ?? 1] ?? 0) + 1;
        s.files++; s.bytes += f.size;
        shows.set(k, s);
      } else if (f.target.startsWith("Movies/")) {
        const t = f.target.split("/")[1] ?? "Film";
        const m = movieMap.get(t) ?? { title: t, files: 0, bytes: 0 };
        m.files++; m.bytes += f.size;
        movieMap.set(t, m);
      }
    }
    movies.push(...movieMap.values());
    return { total, done, bytes, doneBytes, skipped, failed, shows: [...shows.values()], movies };
  }
  const view = (b: Batch) => ({
    id: b.id, name: b.name, createdAt: b.createdAt, updatedAt: b.updatedAt, summary: summary(b),
    files: b.files.map(({ i, rel, size, kind, target, show, season, episode, state, note }) => ({ i, rel, size, kind, target, show, season, episode, state, note })),
  });

  // ── Called by the upload routes ─────────────────────────────────────────
  async function targetFor(batchId: string, index: number, userId: string): Promise<string | null> {
    const b = await load(batchId);
    if (!b || b.userId !== userId) return null;
    return b.files[index]?.target || null;
  }
  async function markDone(batchId: string, index: number, userId: string, finalRel?: string) {
    const b = await load(batchId);
    if (!b || b.userId !== userId || !b.files[index]) return;
    b.files[index].state = "done";
    b.files[index].doneAt = Date.now();
    if (finalRel) b.files[index].target = finalRel;
    delete b.files[index].note;
    await save(b);
    const sum = summary(b);
    if (sum.done === sum.total) {
      receipt({ kind: "upload", userId: b.userId, title: `Uploaded to the library: ${b.name}`, bytes: sum.bytes,
        detail: [sum.shows.length ? `${sum.shows.map((x) => x.title).join(", ")} (${sum.shows.reduce((n, x) => n + x.files, 0)} episodes)` : "", sum.movies.length ? `${sum.movies.length} film(s)` : "", `${(sum.bytes / 1024 ** 3).toFixed(1)} GB`].filter(Boolean).join(" · "),
        data: { batch: b.id } });
    }
  }

  // Interrupted chunk sessions are kept for resuming, but not forever.
  async function sweep() {
    const cutoff = Date.now() - 14 * 86400_000;
    for (const d of await readdir(deps.tempDir).catch(() => [] as string[])) {
      const p = path.join(deps.tempDir, d);
      try {
        const st = await stat(p);
        let newest = st.mtimeMs;
        for (const f of await readdir(p).catch(() => [] as string[])) newest = Math.max(newest, (await stat(path.join(p, f)).catch(() => st)).mtimeMs);
        if (newest < cutoff) { await rm(p, { recursive: true, force: true }); deps.log("INFO", `Cleared an upload abandoned for 14 days (${d})`); }
      } catch { /* gone */ }
    }
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith(".json")) continue;
      try {
        const b = JSON.parse(await readFile(path.join(dir, f), "utf8")) as Batch;
        const finished = b.files.every((x) => x.state !== "pending" && x.state !== "failed");
        if (b.updatedAt < Date.now() - (finished ? 7 : 30) * 86400_000) { await rm(path.join(dir, f), { force: true }); cache.delete(b.id); }
      } catch { /* unreadable */ }
    }
  }
  setTimeout(() => void sweep(), 5 * 60_000).unref?.();
  setInterval(() => void sweep(), 12 * 3600_000).unref?.();

  addLiveSource(() => [...cache.values()].filter((b) => Date.now() - b.updatedAt < 10 * 60_000).map((b) => ({ b, s: summary(b) }))
    .filter(({ s }) => s.done < s.total).map(({ b, s }) => ({ kind: "media-upload", title: b.name, progress: s.bytes ? s.doneBytes / s.bytes : null,
      detail: `${s.done} of ${s.total} file(s) in the library${s.failed ? `, ${s.failed} to retry` : ""}` })));

  function register(app: express.Express) {
    const who = async (req: express.Request, res: express.Response) => {
      const u = await deps.uploader(req);
      if (!u) { res.status(403).json({ error: "upload_privilege_required", message: "The host hasn't let your account add to the media library." }); return null; }
      return u;
    };

    // Describe a folder; get back where everything will go.
    app.post("/api/media/upload/batches", async (req, res) => {
      const userId = await who(req, res);
      if (!userId) return;
      const list = Array.isArray(req.body?.files) ? req.body.files : [];
      if (!list.length) return res.status(400).json({ error: "No files." });
      if (list.length > 20000) return res.status(400).json({ error: "That's more than 20,000 files; upload it in parts." });
      const files: BatchFile[] = [];
      for (const raw of list) {
        const rel = String(raw?.rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rel || rel.includes("..") || rel.length > 600) continue;
        files.push({ i: files.length, rel, size: Math.max(0, Number(raw?.size) || 0), lastModified: Number(raw?.lastModified) || undefined,
          kind: "other", target: "", show: null, season: null, episode: null, state: "pending" });
      }
      // The same folder again: carry on with the batch already under way.
      const name = String(req.body?.name ?? files[0]?.rel.split("/")[0] ?? "Upload").slice(0, 120);
      const sig = crypto.createHash("sha1").update(files.map((f) => `${f.rel}|${f.size}`).sort().join("\n")).digest("hex");
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!f.endsWith(".json")) continue;
        const b = await load(f.slice(0, -5));
        if (!b || b.userId !== userId) continue;
        const bsig = crypto.createHash("sha1").update(b.files.map((x) => `${x.rel}|${x.size}`).sort().join("\n")).digest("hex");
        if (bsig === sig && b.files.some((x) => x.state === "pending" || x.state === "failed")) return res.json({ ...view(b), resumed: true });
      }
      const b: Batch = { id: crypto.randomUUID(), userId, name, createdAt: Date.now(), updatedAt: Date.now(), renames: {}, files };
      plan(b);
      await save(b);
      deps.log("INFO", `Upload planned: "${name}", ${files.length} file(s)`);
      res.json(view(b));
    });

    app.get("/api/media/upload/batches", async (req, res) => {
      const userId = await who(req, res);
      if (!userId) return;
      const out = [];
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!f.endsWith(".json")) continue;
        const b = await load(f.slice(0, -5));
        if (b && b.userId === userId) out.push({ id: b.id, name: b.name, createdAt: b.createdAt, updatedAt: b.updatedAt, summary: summary(b) });
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      res.setHeader("Cache-Control", "no-store");
      res.json({ batches: out });
    });

    app.get("/api/media/upload/batches/:id", async (req, res) => {
      const userId = await who(req, res);
      if (!userId) return;
      const b = await load(req.params.id);
      if (!b || b.userId !== userId) return res.status(404).json({ error: "That upload isn't here any more." });
      res.setHeader("Cache-Control", "no-store");
      res.json(view(b));
    });

    // Rename a show before (or while) uploading; pending files move with it.
    app.patch("/api/media/upload/batches/:id", async (req, res) => {
      const userId = await who(req, res);
      if (!userId) return;
      const b = await load(req.params.id);
      if (!b || b.userId !== userId) return res.status(404).json({ error: "That upload isn't here any more." });
      const key = String(req.body?.key ?? "");
      const title = deps.safeSegment(String(req.body?.title ?? "").trim()).slice(0, 120);
      if (!key || !title) return res.status(400).json({ error: "Give the show a name." });
      b.renames[key] = title;
      // A rename that matches another show's key merges the two.
      b.renames[deps.seriesKey(title)] = title;
      const done = new Map(b.files.filter((f) => f.state === "done").map((f) => [f.i, f.target]));
      plan(b);
      for (const [i, t] of done) b.files[i].target = t; // already uploaded files stay where they are
      await save(b);
      res.json(view(b));
    });

    // The client reports files it could not send (or chose to skip).
    app.post("/api/media/upload/batches/:id/files/:i", async (req, res) => {
      const userId = await who(req, res);
      if (!userId) return;
      const b = await load(req.params.id);
      const f = b?.files[Number(req.params.i)];
      if (!b || b.userId !== userId || !f) return res.status(404).json({ error: "Not found." });
      const state = String(req.body?.state ?? "");
      if (!["failed", "skipped", "pending"].includes(state)) return res.status(400).json({ error: "Bad state." });
      if (f.state !== "done") { f.state = state as FileState; f.note = String(req.body?.note ?? "").slice(0, 200) || undefined; await save(b); }
      res.json({ ok: true });
    });

    app.delete("/api/media/upload/batches/:id", async (req, res) => {
      const userId = await who(req, res);
      if (!userId) return;
      const b = await load(req.params.id);
      if (!b || b.userId !== userId) return res.status(404).json({ error: "Not found." });
      cache.delete(b.id);
      await rm(fileOf(b.id), { force: true });
      res.json({ ok: true });
    });
  }

  return { register, targetFor, markDone };
}
