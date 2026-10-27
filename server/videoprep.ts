/**
 * Films ready for every device (video preparation).
 *
 * A browser plays MP4 with H.264 video and AAC or MP3 sound, and WebM with
 * VP8/VP9/AV1. Everything else in the library (HEVC and 10-bit rips, MKV and
 * AVI files, AC-3/DTS/TrueHD sound...) had to be converted on the fly by the
 * host while someone watched. This PC can (NVENC); the NAS can't, so on the
 * NAS those films would not play.
 *
 * Each film is checked once and gets one of:
 *   direct   plays as it is: nothing to do
 *   remux    H.264 already: the picture is copied, only the sound and the
 *            container change (minutes, no GPU)
 *   convert  the picture is converted to H.264 on the GPU (HDR is tone-mapped
 *            to SDR, anything above 1080p becomes 1080p)
 * The ready copy is an MP4 (H.264 + AAC stereo, moov at the front) saved on
 * Google Drive next to the original, in a hidden ".nxweb" folder:
 *   Movies/Film (2020)/Film.mkv  ->  Movies/Film (2020)/.nxweb/Film.mp4
 * so every host that reads the Drive folder (this PC, the NAS through its
 * rclone mount) finds it at the same path. Originals are never changed.
 *
 * Where each film stands lives in the database (table video_prep), shared by
 * every host: the NAS reads which copies are ready, and asks for a film to
 * be done first when someone presses Play on one that isn't (requested_at).
 * Only a host with a hardware H.264 encoder and the Drive account in rclone
 * does the work (the converter); it pauses while a game is running.
 */
import type express from "express";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat, mkdir, rm, readFile, writeFile, statfs, readdir } from "node:fs/promises";
import path from "node:path";
import { addLiveSource, addCompletedSource, humanBytes } from "./receipts.ts";

export type PrepKind = "direct" | "remux" | "convert";
type Status = "ok" | "queued" | "working" | "done" | "failed";
type Row = {
  rel: string; kind: PrepKind | null; status: Status; progress: number | null; out_rel: string | null;
  out_bytes: number | null; src_bytes: number | null; error: string | null; attempts: number;
  requested_at: string | null; updated_at: string | null; info: any;
};

export type VideoPrepDeps = {
  pool: () => any | null;
  log: (level: string, msg: string) => void;
  /** The Drive library folder on this host (PC: nexus-cloud-media, NAS: the rclone mount). */
  mediaRoot: () => string;
  /** Every video in the library (absolute paths). */
  videos: () => Array<{ path: string; name: string; size: number }>;
  ffmpeg: string;
  ffprobe: string;
  persistDir: string;
  /** rclone remote-control call (server/drives.ts). */
  rc: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
  gameModeActive: () => boolean;
  /** This host converts (has a hardware encoder and the Drive account). */
  converter: boolean;
  /** rclone remote and folder that the media root mirrors ("gdrive", "NexusArchive"). */
  remote: string;
  driveFolder: string;
  isAdmin: (req: express.Request) => Promise<boolean>;
};

const MP4ISH = new Set([".mp4", ".m4v"]);
const HDR_TRANSFER = new Set(["smpte2084", "arib-std-b67"]);

/** What a film needs before a browser can play it, from ffprobe's streams. */
export function classify(ext: string, streams: any[]): { kind: PrepKind; why: string; hdr: boolean; audio: number; copyAudio: boolean } {
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audios = streams.filter((s) => s.codec_type === "audio");
  // English if there is any (else every track), and among those one a browser
  // plays as it is (AAC/MP3 stereo, kept untouched), else the default, else the first.
  const english = audios.map((s, i) => ({ s, i })).filter(({ s }) => /^(eng|en)$/i.test(String(s.tags?.language ?? "")));
  const pool = english.length ? english : audios.map((s, i) => ({ s, i }));
  const plain = pool.find(({ s }) => ["aac", "mp3"].includes(String(s.codec_name)) && Number(s.channels ?? 0) <= 2);
  const pick = (plain ?? pool.find(({ s }) => s.disposition?.default) ?? pool[0])?.i ?? 0;
  const a = audios[pick];
  const vc = String(v?.codec_name ?? "").toLowerCase();
  const ac = String(a?.codec_name ?? "").toLowerCase();
  const pix = String(v?.pix_fmt ?? "").toLowerCase();
  const hdr = HDR_TRANSFER.has(String(v?.color_transfer ?? "").toLowerCase());
  const channels = Number(a?.channels ?? 0);
  const h264 = vc === "h264" && (!pix || pix === "yuv420p" || pix === "yuvj420p") && !hdr;
  const copyAudio = !a || ((ac === "aac" || ac === "mp3") && channels <= 2);
  const base = { hdr, audio: Math.max(0, pick), copyAudio };
  if (!v) return { kind: "direct", why: "no picture", ...base };
  // AAC 5.1 in an MP4 plays (browsers mix it down), so those stay as they are.
  if (MP4ISH.has(ext) && h264 && (!a || ac === "aac" || ac === "mp3")) return { kind: "direct", why: "plays as it is", ...base };
  if (ext === ".webm" && ["vp8", "vp9", "av1"].includes(vc) && (!a || ["opus", "vorbis"].includes(ac))) return { kind: "direct", why: "plays as it is", ...base };
  if (h264) return { kind: "remux", why: `${ext.slice(1).toUpperCase()} with ${ac || "no"} sound`, ...base };
  return { kind: "convert", why: `${vc || "unknown"}${/10|12/.test(pix) ? " 10-bit" : ""}${hdr ? " HDR" : ""}`, ...base };
}

/** ffmpeg arguments for one film (exported for tests). */
// soft: decode on the CPU and step over damaged packets. The graphics card's
// decoder stops at the first broken frame, so a damaged source (the "pseudo"
// One Piece batch: 27 s of a 24-minute episode) came out short.
export function encodeArgs(src: string, out: string, kind: PrepKind, info: any, enc: string, soft = false): string[] {
  const a = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
  if (soft) a.push("-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err");
  else if (kind === "convert" && enc === "h264_nvenc") a.push("-hwaccel", "cuda");
  a.push("-threads", "0");
  a.push("-i", src, "-map", "0:v:0", "-map", `0:a:${info.audio ?? 0}?`, "-map_chapters", "-1", "-sn", "-dn");
  if (kind === "remux") a.push("-c:v", "copy", "-tag:v", "avc1");
  else {
    const h = Number(info.height) || 1080;
    const tall = h > 1080 ? 1080 : h;
    const scale = h > 1080 ? "scale=-2:1080:flags=bicubic," : "";
    const tone = info.hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv," : "";
    a.push("-vf", `${scale}${tone}format=yuv420p`);
    const max = tall >= 1000 ? "8M" : tall >= 700 ? "5M" : "2.5M";
    if (enc === "libx264") a.push("-c:v", "libx264", "-preset", "faster", "-crf", "21", "-maxrate", max, "-bufsize", max.replace("M", "") + "M", "-threads", "0");
    else if (enc === "h264_nvenc") a.push("-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", max, "-bufsize", `${parseFloat(max) * 2}M`, "-spatial-aq", "1");
    else a.push("-c:v", enc, "-b:v", max === "8M" ? "6M" : max === "5M" ? "3.5M" : "1.8M", "-maxrate", max);
    a.push("-profile:v", "high", "-g", "96", "-bf", "2");
  }
  if (info.copyAudio) a.push("-c:a", "copy");
  else a.push("-c:a", "aac", "-ac", "2", "-b:a", "160k", "-af", "aresample=async=1:first_pts=0");
  a.push("-movflags", "+faststart", "-f", "mp4", out);
  return a;
}

// Errors that aren't the film's fault: rclone's connection dropping (a server
// restart ends its rclone with it), Drive refusing sign-ins for a while (48
// films "failed" with "couldn't find root directory ID ... invalid
// authentication", 2026-10-26), rate limits and timeouts. The film goes back
// in the queue uncounted.
export const TRANSIENT = /^fetch failed$|ECONNREFUSED|ECONNRESET|socket hang up|googleapi: Error (401|403|429|5\d\d)|couldn't find root directory ID|rateLimitExceeded|aborted due to timeout|TimeoutError/i;

export function fmtEta(s: number): string {
  if (s > 86400) return `${Math.round(s / 86400)} d`;
  if (s > 3600) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  if (s > 60) return `${Math.round(s / 60)} min`;
  return `${Math.max(1, Math.round(s))} s`;
}

export function createVideoPrep(deps: VideoPrepDeps) {
  const settingsFile = path.join(deps.persistDir, "video-prep.json");
  let settings = { paused: false };
  let rows = new Map<string, Row>();
  let encoder: string | null = null;
  let current: {
    rel: string; title: string; phase: string; progress: number; startedAt: number;
    speed: string | null; speedBps: number | null; eta: number | null;
    proc: ChildProcess | null; stopFor: string | null;
  } | null = null;
  let tableReady = false;
  let lastScanAt = 0;
  let scanning = false;
  let driveFree: { at: number; bytes: number | null } = { at: 0, bytes: null };

  const norm = (p: string) => p.replace(/\\/g, "/");
  /** The film's path inside the Drive folder, the same on every host; null outside it. */
  function driveRel(abs: string): string | null {
    const root = deps.mediaRoot();
    if (!root || !abs) return null;
    const r = path.relative(path.resolve(root), path.resolve(abs));
    if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
    return norm(r);
  }
  const outRelFor = (rel: string) => {
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel).replace(/\.[^.]+$/, "");
    return `${dir === "." ? "" : `${dir}/`}.nxweb/${base}.mp4`;
  };
  const localOf = (rel: string) => path.join(deps.mediaRoot(), ...rel.split("/"));

  async function q(sql: string, params: unknown[] = []) {
    const pool = deps.pool();
    if (!pool) throw new Error("database not connected");
    return pool.query(sql, params);
  }
  async function ensureTable() {
    if (tableReady) return;
    await q(`CREATE TABLE IF NOT EXISTS video_prep (
      rel TEXT PRIMARY KEY, kind TEXT, status TEXT NOT NULL DEFAULT 'queued', progress REAL,
      out_rel TEXT, out_bytes BIGINT, src_bytes BIGINT, info JSONB, error TEXT,
      attempts INT NOT NULL DEFAULT 0, requested_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW())`);
    tableReady = true;
  }
  async function load() {
    try {
      await ensureTable();
      const r = await q("SELECT rel, kind, status, progress, out_rel, out_bytes, src_bytes, error, attempts, requested_at, updated_at, info FROM video_prep");
      const next = new Map<string, Row>();
      for (const row of r.rows) next.set(row.rel, { ...row, out_bytes: row.out_bytes == null ? null : Number(row.out_bytes), src_bytes: row.src_bytes == null ? null : Number(row.src_bytes) });
      rows = next;
      // Counted as failed before those errors were known to pass by themselves.
      for (const r of rows.values()) if (r.status === "failed" && TRANSIENT.test(r.error ?? "")) await save(r.rel, { status: "queued", attempts: 0, error: null });
    } catch { /* database not ready yet: keep what we have */ }
  }
  let fullAt = 0;
  /** Films someone asked for on another host (the NAS) since the last look. */
  async function pollRequests() {
    if (Date.now() - fullAt > 10 * 60_000) { await load(); fullAt = Date.now(); return; }
    try {
      const r = await q("SELECT rel, requested_at, status, attempts FROM video_prep WHERE requested_at > NOW() - INTERVAL '2 days'");
      for (const x of r.rows) {
        const row = rows.get(x.rel);
        if (row) Object.assign(row, { requested_at: x.requested_at, status: row.status === "working" ? "working" : x.status, attempts: x.attempts });
      }
    } catch { /* database busy: next time */ }
  }
  async function save(rel: string, patch: Partial<Row>) {
    const row: Row = { ...(rows.get(rel) ?? { rel, kind: null, status: "queued", progress: null, out_rel: null, out_bytes: null, src_bytes: null, error: null, attempts: 0, requested_at: null, updated_at: null, info: null }), ...patch };
    rows.set(rel, row);
    await q(`INSERT INTO video_prep (rel, kind, status, progress, out_rel, out_bytes, src_bytes, info, error, attempts, requested_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (rel) DO UPDATE SET kind=$2, status=$3, progress=$4, out_rel=$5, out_bytes=$6, src_bytes=$7, info=$8, error=$9, attempts=$10, requested_at=$11, updated_at=NOW()`,
      [rel, row.kind, row.status, row.progress, row.out_rel, row.out_bytes, row.src_bytes, row.info ? JSON.stringify(row.info) : null, row.error, row.attempts, row.requested_at]).catch((e: Error) => deps.log("WARN", `video prep: couldn't save ${rel}: ${e.message}`));
  }

  // ── What the other routes ask ──────────────────────────────────────────
  /** The ready copy of a film on this host, if there is one. Whether the
   *  file is there is remembered for 5 minutes: the library asks for every
   *  film on every load, and each check goes through Google Drive. */
  const seenCopy = new Map<string, { at: number; ok: boolean }>();
  function copyFor(abs: string): string | null {
    const rel = driveRel(abs);
    const row = rel ? rows.get(rel) : null;
    if (!row || row.status !== "done" || !row.out_rel) return null;
    const local = localOf(row.out_rel);
    const hit = seenCopy.get(local);
    if (hit && Date.now() - hit.at < (hit.ok ? 5 : 1) * 60_000) return hit.ok ? local : null;
    const ok = existsSync(local);
    seenCopy.set(local, { at: Date.now(), ok });
    return ok ? local : null;
  }
  function stateOf(abs: string) {
    const rel = driveRel(abs);
    const row = rel ? rows.get(rel) : null;
    return { rel, kind: row?.kind ?? null, status: row?.status ?? null, progress: row?.progress ?? null, ready: !!copyFor(abs) };
  }
  /** Someone pressed Play on a film that isn't ready: do it next. */
  async function request(abs: string) {
    const rel = driveRel(abs);
    if (!rel) return;
    const row = rows.get(rel);
    if (row && (row.status === "done" || row.status === "ok" || row.status === "working")) return;
    if (row?.requested_at && Date.now() - Date.parse(row.requested_at) < 60_000) return;
    // Only the request is written: this host's copy of the row may be a
    // minute old, and writing all of it back could undo the converter's
    // "done" from a moment ago.
    const at = new Date().toISOString();
    if (row) row.requested_at = at;
    // A film not checked yet gets a row, so it is checked and done first.
    if (!row) await q("INSERT INTO video_prep (rel, status, requested_at) VALUES ($1, 'queued', $2) ON CONFLICT (rel) DO NOTHING", [rel, at]).catch(() => {});
    await q(`UPDATE video_prep SET requested_at=$2, status = CASE WHEN status = 'failed' AND attempts < 3 THEN 'queued' ELSE status END, updated_at=NOW()
      WHERE rel=$1 AND status NOT IN ('done','ok','working')`, [rel, at]).catch(() => {});
  }

  // ── The converter ──────────────────────────────────────────────────────
  function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) =>
        resolve({ code: err ? ((err as any).code ?? 1) : 0, out: String(out ?? ""), err: String(errOut ?? "") }));
    });
  }
  async function probe(file: string): Promise<{ streams: any[]; duration: number } | null> {
    const r = await run(deps.ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], 90_000);
    if (r.code !== 0) return null;
    try {
      const j = JSON.parse(r.out);
      return { streams: j.streams ?? [], duration: parseFloat(j.format?.duration) || 0 };
    } catch { return null; }
  }
  async function pickEncoder(): Promise<string> {
    if (encoder) return encoder;
    for (const enc of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
      const r = await run(deps.ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.5", "-c:v", enc, "-f", "null", "-"], 30_000);
      if (r.code === 0) return (encoder = enc);
    }
    return (encoder = "libx264");
  }

  /** Check films not seen yet (or changed), a few at a time. */
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      await load();
      const seen = new Set<string>();
      const todo: Array<{ abs: string; rel: string; size: number }> = [];
      for (const v of deps.videos()) {
        if (/[\\/]\.nxweb[\\/]/.test(v.path)) continue;
        const rel = driveRel(v.path);
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        const row = rows.get(rel);
        if (row && row.src_bytes === v.size && row.kind) continue;
        todo.push({ abs: v.path, rel, size: v.size });
      }
      // Films someone pressed Play on are checked first.
      todo.sort((x, y) => (rows.get(y.rel)?.requested_at ? 1 : 0) - (rows.get(x.rel)?.requested_at ? 1 : 0));
      let checked = 0;
      for (const t of todo) {
        if (deps.gameModeActive()) break;
        const p = await probe(t.abs);
        if (!p) continue;
        const c = classify(path.extname(t.rel).toLowerCase(), p.streams);
        const prev = rows.get(t.rel);
        await save(t.rel, {
          kind: c.kind, status: c.kind === "direct" ? "ok" : prev?.status === "done" && prev.src_bytes === t.size ? "done" : "queued",
          src_bytes: t.size, out_rel: c.kind === "direct" ? null : outRelFor(t.rel), progress: null, error: null, attempts: 0,
          info: { why: c.why, hdr: c.hdr, audio: c.audio, copyAudio: c.copyAudio, duration: p.duration,
            height: Number(p.streams.find((s: any) => s.codec_type === "video")?.height ?? 0) },
        });
        checked++;
      }
      if (checked) deps.log("INFO", `video prep: checked ${checked} film(s); ${[...rows.values()].filter((r) => r.status === "queued").length} to prepare`);
    } finally { scanning = false; lastScanAt = Date.now(); }
  }

  // A server restart mid-conversion leaves its working folder behind (the
  // source copy and a half-made film): 17 of them filled 17 GB of the disk
  // downloads use. Nothing is converting when the server starts, so they go.
  void (async () => {
    for (const dir of [process.env.NEXUS_VIDEO_PREP_TMP?.trim(), path.join(deps.persistDir, "tmp", "video-prep")].filter(Boolean) as string[]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      let removed = 0;
      for (const n of names) if (/^\d{10,}$/.test(n)) { await rm(path.join(dir, n), { recursive: true, force: true }).then(() => removed++, () => {}); }
      if (removed) deps.log("INFO", `video prep: removed ${removed} working folder(s) left by a restart`);
    }
  })();

  async function tempDir(need: number): Promise<string | null> {
    for (const dir of [process.env.NEXUS_VIDEO_PREP_TMP?.trim(), path.join(deps.persistDir, "tmp", "video-prep")].filter(Boolean) as string[]) {
      try {
        await mkdir(dir, { recursive: true });
        const s = await statfs(dir);
        if (s.bavail * s.bsize > need + 8 * 1024 ** 3) return dir;
      } catch { /* try the next */ }
    }
    return null;
  }
  async function rcJob(method: string, params: Record<string, unknown>, onBytes?: (b: number) => void) {
    const { jobid } = await deps.rc(method, { ...params, _async: true }, 60_000);
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      if (current?.stopFor) { await deps.rc("job/stop", { jobid }).catch(() => {}); throw new Error(current.stopFor); }
      const st = await deps.rc("job/status", { jobid }, 30_000);
      if (onBytes) { const s = await deps.rc("core/stats", { group: `job/${jobid}` }, 30_000).catch(() => null); if (s) onBytes(Number(s.bytes) || 0); }
      if (st.finished) { if (!st.success) throw new Error(st.error || `${method} failed`); return; }
    }
  }

  async function prepareOne(row: Row) {
    const rel = row.rel;
    const info = row.info ?? {};
    const name = path.posix.basename(rel);
    const size = row.src_bytes ?? 0;
    const tmp = await tempDir(size * 2.2);
    if (!tmp) { await save(rel, { error: "Not enough free space on this PC to prepare it right now." }); return false; }
    const work = path.join(tmp, `${Date.now()}`);
    await mkdir(work, { recursive: true });
    const srcName = `source${path.extname(rel)}`;
    const out = path.join(work, "ready.mp4");
    current = { rel, title: name, phase: "Getting it from Drive", progress: 0, startedAt: Date.now(), speed: null, speedBps: null, eta: null, proc: null, stopFor: null };
    try {
      await save(rel, { status: "working", progress: 0, error: null });
      // A local copy first: reading over Drive for Desktop would fill its cache
      // (and checks on Drive for Desktop paths have frozen the server).
      const src = path.join(work, srcName);
      {
        await rcJob("operations/copyfile", { srcFs: `${deps.remote}:`, srcRemote: `${deps.driveFolder}/${rel}`, dstFs: work, dstRemote: srcName },
          (b) => {
            if (current) {
              current.progress = size ? Math.min(1, b / size) * 0.15 : 0;
              const elapsed = (Date.now() - current.startedAt) / 1000;
              if (elapsed > 1) {
                current.speedBps = Math.round(b / elapsed);
                current.eta = current.speedBps > 0 ? Math.round((size - b) / current.speedBps) : null;
              }
            }
          });
        if (!existsSync(src)) throw new Error("the film didn't come down from Drive");
      }

      current!.phase = row.kind === "remux" ? "Repacking" : "Converting";
      const enc = await pickEncoder();
      const duration = Number(info.duration) || 0;
      const encode = (soft: boolean) => new Promise<void>((resolve, reject) => {
        const p = spawn(deps.ffmpeg, encodeArgs(src, out, row.kind!, info, enc, soft), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        current!.proc = p;
        let errText = "";
        let lastMilestone = 0;
        let lastLog = Date.now();
        p.stdout.on("data", (d: Buffer) => {
          const text = String(d);
          const mTime = /out_time_(?:ms|us)=(\d+)/.exec(text);
          const mSpeed = /speed=\s*([\d.]+)x/.exec(text);
          const mFps = /fps=\s*([\d.]+)/.exec(text);
          if (mTime && duration > 0 && current) {
            const outSec = Number(mTime[1]) / 1e6;
            const frac = Math.min(1, outSec / duration);
            current.progress = 0.15 + frac * 0.7;
            const speedX = mSpeed ? parseFloat(mSpeed[1]) : (outSec / Math.max(1, (Date.now() - current.startedAt) / 1000));
            const fpsVal = mFps ? Math.round(parseFloat(mFps[1])) : 0;
            current.speed = speedX > 0 ? `${speedX.toFixed(1)}x${fpsVal > 0 ? ` (${fpsVal} fps)` : ""}` : null;
            current.eta = speedX > 0 ? Math.max(1, Math.round((duration - outSec) / speedX)) : null;

            const pctNow = Math.floor(current.progress * 100);
            if (pctNow >= lastMilestone + 15 || Date.now() - lastLog > 30000) {
              lastMilestone = pctNow;
              lastLog = Date.now();
              deps.log("INFO", `video prep: ${name} [${current.phase}] ${pctNow}% (${current.speed ?? "transcoding"}${current.eta ? ` · ${fmtEta(current.eta)} left` : ""})`);
            }
          }
        });
        p.stderr.on("data", (d: Buffer) => { errText = (errText + String(d)).slice(-1500); });
        p.on("error", reject);
        p.on("exit", (code) => {
          if (current?.stopFor) reject(new Error(current.stopFor));
          else if (code === 0) resolve();
          else reject(new Error(errText.trim().split(/\r?\n/).pop() || `ffmpeg exit ${code}`));
        });
      });
      const short = (c: any) => duration > 60 && Math.abs(c.duration - duration) > Math.max(5, duration * 0.02);
      let soft = false;
      try { await encode(false); } catch (e) { if (current?.stopFor) throw e; soft = true; }
      let check = soft ? null : await probe(out);
      // Short, or the converter gave up: once more, decoding on the CPU past the damage.
      if (soft || (check && short(check))) {
        deps.log("INFO", `video prep: ${name}: ${soft ? "the converter stopped" : `came out ${Math.round(check!.duration)} s of ${Math.round(duration)} s`}; trying again past damaged frames`);
        if (current) { current.progress = 0.15; current.phase = "Converting (second try)"; }
        await rm(out, { force: true });
        await encode(true);
        check = await probe(out);
      }
      current!.proc = null;

      // Checked before it goes up: it opens, has a picture, and is the full length.
      const outV = check?.streams.find((s: any) => s.codec_type === "video");
      if (!check || !outV || String(outV.codec_name) !== "h264") throw new Error("the prepared copy didn't check out");
      if (short(check)) throw new Error(`the prepared copy is ${Math.round(check.duration)} s long, the film ${Math.round(duration)} s`);
      const outBytes = (await stat(out)).size;

      current!.phase = "Saving to Drive";
      const outRel = row.out_rel ?? outRelFor(rel);
      // Up with rclone, checked for its full size (a copy dropped into the
      // Drive for Desktop folder uploads later, unchecked).
      {
        await rcJob("operations/copyfile", { srcFs: work, srcRemote: "ready.mp4", dstFs: `${deps.remote}:`, dstRemote: `${deps.driveFolder}/${outRel}` },
          (b) => {
            if (current) {
              current.progress = 0.85 + Math.min(1, b / outBytes) * 0.15;
              const elapsed = (Date.now() - current.startedAt) / 1000;
              if (elapsed > 1) {
                current.speedBps = Math.round(b / elapsed);
                current.eta = current.speedBps > 0 ? Math.round((outBytes - b) / current.speedBps) : null;
              }
            }
          });
        const up = await deps.rc("operations/stat", { fs: `${deps.remote}:`, remote: `${deps.driveFolder}/${outRel}` }, 60_000).catch(() => null);
        if (Number(up?.item?.Size) !== outBytes) throw new Error("the copy on Drive isn't the full size");
      }

      await save(rel, { status: "done", progress: 1, out_rel: outRel, out_bytes: outBytes, error: null, requested_at: null });
      deps.log("INFO", `video prep: ${name} ready (${row.kind}, ${humanBytes(outBytes)}, ${Math.round((Date.now() - current!.startedAt) / 1000)} s)`);
      return true;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // The connection to rclone dropping (a server restart ends its rclone
      // with it) isn't the film's fault: "Power" episodes reached 3 failed
      // attempts that way on 2026-10-19. It goes back in the queue uncounted.
      const transient = TRANSIENT.test(msg);
      if (current?.stopFor || transient) {
        await save(rel, { status: "queued", progress: null });
        if (transient) deps.log("INFO", `video prep: ${name}: lost the connection to rclone; it goes back in the queue`);
      } else {
        const attempts = (row.attempts ?? 0) + 1;
        await save(rel, { status: attempts >= 3 ? "failed" : "queued", attempts, error: msg.slice(0, 400), progress: null });
        deps.log("WARN", `video prep: ${name}: ${msg}`);
      }
      return false;
    } finally {
      current = null;
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  function next(): Row | null {
    const list = [...rows.values()].filter((r) => r.status === "queued" && r.kind && r.kind !== "direct" && (r.attempts ?? 0) < 3);
    list.sort((a, b) =>
      (b.requested_at ? Date.parse(b.requested_at) : 0) - (a.requested_at ? Date.parse(a.requested_at) : 0)
      || (a.kind === "remux" ? 0 : 1) - (b.kind === "remux" ? 0 : 1)
      || (a.src_bytes ?? 0) - (b.src_bytes ?? 0));
    return list[0] ?? null;
  }

  async function loop() {
    for (;;) {
      try {
        await new Promise((r) => setTimeout(r, current ? 5000 : 15_000));
        if (!deps.pool()) continue;
        if (!scanning) await pollRequests();
        if (settings.paused || deps.gameModeActive()) continue;
        // Never fill the Drive account: stop with 200 GB to spare.
        if (Date.now() - driveFree.at > 30 * 60_000) {
          const about = await deps.rc("operations/about", { fs: `${deps.remote}:` }, 60_000).catch(() => null);
          driveFree = { at: Date.now(), bytes: about?.free != null ? Number(about.free) : null };
        }
        if (driveFree.bytes != null && driveFree.bytes < 200 * 1024 ** 3) continue;
        const row = next();
        if (row) await prepareOne(row);
      } catch (e: any) { deps.log("WARN", `video prep: ${e?.message ?? e}`); }
    }
  }
  // A game started: stop the conversion now (it starts again afterwards).
  setInterval(() => {
    if (current && !current.stopFor && (deps.gameModeActive() || settings.paused)) {
      current.stopFor = deps.gameModeActive() ? "paused for a game" : "paused";
      try { current.proc?.kill(); } catch { /* gone */ }
    }
  }, 3000).unref?.();

  // Hosts that only read: refresh which copies are ready.
  setInterval(() => { if (!deps.converter) void load(); }, 60_000).unref?.();
  void (async () => {
    try { settings = { ...settings, ...JSON.parse(await readFile(settingsFile, "utf8")) }; } catch { /* first run */ }
    await new Promise((r) => setTimeout(r, 20_000));
    await load();
    // A film that was being prepared when the server stopped starts again.
    if (deps.converter) for (const r of [...rows.values()].filter((x) => x.status === "working")) await save(r.rel, { status: "queued", progress: null });
    if (!deps.converter) return;
    // The copies go to the Drive account the library lives on: no account, no work.
    const { remotes = [] } = await deps.rc("config/listremotes").catch(() => ({ remotes: [] as string[] }));
    if (!remotes.includes(deps.remote)) { deps.log("WARN", `video prep: rclone has no "${deps.remote}" account on this host; films are not prepared here`); return; }
    deps.log("INFO", `video prep: this host prepares films (${await pickEncoder()})`);
    void loop();
    // Checking films runs beside the converting, so work starts at once.
    const checkNow = () => { if (!scanning && deps.pool() && Date.now() - lastScanAt > 15 * 60_000) void scan().catch((e) => deps.log("WARN", `video prep: ${e?.message ?? e}`)); };
    checkNow();
    setInterval(checkNow, 60_000).unref?.();
  })();

  // ── Activity ───────────────────────────────────────────────────────────
  function counts() {
    const c = { films: 0, ok: 0, done: 0, queued: 0, failed: 0, working: 0, remux: 0, convert: 0, outBytes: 0 };
    for (const r of rows.values()) {
      c.films++;
      if (r.status in c) (c as any)[r.status]++;
      if (r.status !== "ok" && r.status !== "done" && r.kind === "remux") c.remux++;
      if (r.status !== "ok" && r.status !== "done" && r.kind === "convert") c.convert++;
      if (r.status === "done") c.outBytes += r.out_bytes ?? 0;
    }
    return c;
  }
  if (deps.converter) {
    addLiveSource(() => {
      const c = counts();
      const left = c.queued + c.working;
      if (!left && !current) return [];
      const ready = c.ok + c.done;
      return [{
        kind: "convert", title: `Preparing films for every device: ${ready} of ${c.films} ready`,
        progress: current ? current.progress : c.films ? ready / c.films : null,
        status: settings.paused ? "paused" : "running", jobId: "video-prep", actions: settings.paused ? ["resume"] : ["pause"],
        speed: current?.speedBps ?? undefined,
        eta: current?.eta ?? undefined,
        detail: settings.paused ? `Paused. ${left} film(s) still to prepare.`
          : current ? `${current.phase}: ${current.title} (${Math.round(current.progress * 100)}%${current.speed ? ` · ${current.speed}` : ""}${current.eta ? ` · ${fmtEta(current.eta)} left` : ""}). ${left - 1} more after it.`
          : deps.gameModeActive() ? `Waiting until the game closes. ${left} to go.`
          : driveFree.bytes != null && driveFree.bytes < 200 * 1024 ** 3 ? `Stopped: Google Drive has less than 200 GB free (${humanBytes(driveFree.bytes)}). ${left} to go.` : `${left} to go (${c.remux} quick repacks, ${c.convert} conversions).`,
      }];
    });
  }
  addCompletedSource(() => {
    const c = counts();
    if (!c.done && !c.failed) return [];
    const failed = [...rows.values()].filter((r) => r.status === "failed");
    return [{
      kind: "convert", id: "video-prep", title: "Films ready for every device", result: failed.length ? "warn" : "verified",
      summary: `${c.ok + c.done} of ${c.films} films play on any device (${c.done} prepared, ${humanBytes(c.outBytes)} on Drive)${failed.length ? `; ${failed.length} couldn't be prepared` : ""}.`,
      startedAt: null, finishedAt: Date.now(),
      facts: [["Played as they are", `${c.ok}`], ["Prepared copies", `${c.done}`], ["Still to do", `${c.queued + c.working}`]],
      problems: failed.length ? failed.slice(0, 50).map((r) => `${r.rel}: ${r.error ?? "failed"}`) : undefined,
      actions: failed.length ? [{ label: "Try those again", post: "/api/admin/video-prep/retry" }] : undefined,
    }];
  });

  // ── Routes ─────────────────────────────────────────────────────────────
  function register(app: express.Express) {
    app.get("/api/admin/video-prep", async (req, res) => {
      if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Admins only" });
      res.json({ converter: deps.converter, encoder, paused: settings.paused, ...counts(),
        current: current ? { title: current.title, phase: current.phase, progress: current.progress } : null,
        failed: [...rows.values()].filter((r) => r.status === "failed").slice(0, 100).map((r) => ({ rel: r.rel, error: r.error })) });
    });
    app.post("/api/admin/video-prep/:action", async (req, res) => {
      if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Admins only" });
      const act = req.params.action;
      if (act === "pause" || act === "resume") {
        settings.paused = act === "pause";
        await writeFile(settingsFile, JSON.stringify(settings)).catch(() => {});
      } else if (act === "retry") {
        for (const r of [...rows.values()].filter((x) => x.status === "failed")) await save(r.rel, { status: "queued", attempts: 0, error: null });
      } else if (act === "rescan") {
        lastScanAt = 0;
      } else return res.status(400).json({ error: "Unknown action" });
      res.json({ ok: true, paused: settings.paused });
    });
  }

  /** A film was deleted: its prepared copy's path (to delete too), and its row goes. */
  async function forget(abs: string): Promise<string | null> {
    const rel = driveRel(abs);
    const row = rel ? rows.get(rel) : null;
    if (!rel) return null;
    rows.delete(rel);
    await q("DELETE FROM video_prep WHERE rel=$1", [rel]).catch(() => {});
    return row?.out_rel ? localOf(row.out_rel) : null;
  }

  return { register, copyFor, stateOf, request, driveRel, classify, forget };
}
