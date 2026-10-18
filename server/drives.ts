/**
 * Cloud Drives: the host's Google Drive accounts and local disks in one file
 * manager, and "move this folder to Drive" jobs that survive interruptions.
 *
 * Engine: rclone, which already holds a sign-in for each Google account
 * (remotes in %APPDATA%\rclone\rclone.conf). Browsing and quick operations go
 * through a private `rclone rcd` (localhost, random password per start).
 * Upload jobs run `rclone copy` as their own process so they can be paused,
 * resumed and restarted after a reboot: rclone skips files that are already
 * on Drive, so a job carries on where it stopped.
 *
 * A job never deletes anything by itself. When the copy finishes, every file
 * is checked against Drive with `rclone check` (size and MD5 checksum). Only
 * then does the Cloud page offer to delete the local copies, and only the
 * files that check confirmed, unchanged since, are deleted.
 *
 * All routes are under /api/admin/ (admins only, see access.ts).
 */
import type express from "express";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, createWriteStream } from "node:fs";
import { readFile, writeFile, stat, unlink, readdir, rmdir, mkdir, rm, rename, copyFile } from "node:fs/promises";
import { receipt, addLiveSource, addCompletedSource, humanBytes, type CompletedItem } from "./receipts.ts";
const gbs = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export type DrivesDeps = {
  persistDir: string;
  log: (level: string, msg: string) => void;
  /** Called when an upload into the media library or ROM folders has been verified. */
  onUploaded?: (kind: OffloadKind) => void;
  /** No new jobs start while a game is running on the host. */
  gameModeActive?: () => boolean;
  /** Someone is watching, listening or browsing right now (uploads hold back). */
  siteBusy?: () => boolean;
  /** Someone is watching, listening or playing right now (that needs the upload line). */
  streamingNow?: () => boolean;
  /** Who is calling (members' own drives are checked against it). */
  callerOf?: (req: express.Request) => Promise<{ userId: string | null; admin: boolean }>;
  /** Folders on this PC worth moving to Drive (ROM and music folders), with where each should go. */
  suggestions?: () => Promise<Array<{ label: string; source: string; kind: OffloadKind; dest: string }>>;
  /** Returns true if a local file is currently downloading (e.g. sparse torrent file). */
  isIncomplete?: (filePath: string) => boolean;
};

export type OffloadKind = "movies" | "tv" | "music" | "roms" | "files";
type JobStatus = "queued" | "copying" | "verifying" | "verified" | "incomplete" | "paused" | "failed" | "deleting" | "done" | "kept";
type OffloadJob = {
  id: string; label: string; kind: OffloadKind;
  source: string; remote: string; dest: string;
  status: JobStatus; createdAt: number; startedAt: number | null; finishedAt: number | null;
  stats: { bytes: number; totalBytes: number; transfers: number; totalTransfers: number; checks: number; totalChecks: number; errors: number; speed: number; eta: number | null; current: string[] };
  lastError: string | null;
  verify: null | { at: number; matched: number; missing: number; differ: number; errors: number; matchedBytes: number; problems: string[] };
  deleted: null | { at: number; files: number; bytes: number; skipped: number };
  /** Re-run every day so files added to the folder later get backed up too (copy only, never deletes). */
  keepSynced?: boolean;
  /** Delete the confirmed files from this PC as soon as the check passes (the owner's choice per job). */
  autoFree?: boolean;
  nextSyncAt?: number | null;
  attempts?: number;
  retryAt?: number | null;
  lastProgressAt?: number | null;
  /** Time spent actually copying (not queued or paused), for "took" in the Activity log. */
  activeMs?: number;
  tickAt?: number;
  /** [time, bytes] over the last few minutes: the speed "time left" is worked out from. */
  speedWin?: Array<[number, number]>;
  /** rclone is still finding out what there is to send; no honest "time left" yet. */
  counting?: boolean;
  /** Sent in earlier runs of this copy (before a restart), so progress carries on instead of starting at 0. */
  carriedBytes?: number;
  /** Files already on Drive somewhere else in the archive (same name and size): not sent again. */
  dupes?: { count: number; bytes: number; at: number; file: string; examples: string[] } | null;
  /** Files changed in the last half hour (still downloading): left for a later run. */
  stillChanging?: { count: number; bytes: number; at: number } | null;
};

const EXCLUDES = ["desktop.ini", "Thumbs.db", ".DS_Store", "$RECYCLE.BIN/**", "System Volume Information/**", "*.partial", "*.!qB", "*.crdownload", "*.tmp"];
// A file changed in the last 30 minutes is probably still being written (a
// torrent still downloading into the folder): copying it would send half a
// game. It waits for a later run instead.
const SETTLE = "30m";
const SETTLE_MS = 30 * 60_000;
const excludeArgs = () => [...EXCLUDES.flatMap((e) => ["--exclude", e]), `--min-age=${SETTLE}`];
const LOCAL_DRIVES = "CDEFGH".split("").map((d) => `${d}:`);
const isLocalFs = (fs_: string) => /^[A-Za-z]:$/.test(fs_);
/** A member's own connected drive: "u_<user id without dashes>_<n>". */
export const isPersonalRemote = (name: string) => /^u_[0-9a-f]{32}_\d+$/.test(name);
export const ownerOfRemote = (name: string) => (isPersonalRemote(name) ? name.split("_")[1] : null);
const fsSpec = (fs_: string) => (isLocalFs(fs_) ? `${fs_}/` : `${fs_}:`);
const joinRemote = (...parts: string[]) => parts.map((p) => String(p ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
// Paths come from the page; nothing may climb out of the root it names.
const cleanRel = (p: unknown) => {
  const s = String(p ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (s.split("/").some((seg) => seg === "..")) throw new Error("Invalid path");
  return s;
};

export function createDrives(deps: DrivesDeps) {
  const jobsFile = path.join(deps.persistDir, "offload-jobs.json");
  const reportsDir = path.join(deps.persistDir, "offload-reports");
  const uploadDir = path.join(deps.persistDir, "tmp", "drive-uploads");
  let rclone: string | null = process.env.RCLONE_BIN?.trim() || null;
  let jobs: OffloadJob[] = [];
  const running = new Map<string, ChildProcess>();
  let saveTimer: NodeJS.Timeout | null = null;

  // ── rclone binary and remote-control daemon ───────────────────────────
  async function findRclone(): Promise<string | null> {
    if (rclone && existsSync(rclone)) return rclone;
    const found = await new Promise<string>((resolve) => execFile(process.platform === "win32" ? "where" : "which", ["rclone"], { windowsHide: true },
      (err, out) => resolve(err ? "" : String(out).split(/\r?\n/)[0].trim())));
    if (found) return (rclone = found);
    const winget = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Packages");
    try {
      for (const d of await readdir(winget)) {
        if (!/^Rclone\.Rclone/i.test(d)) continue;
        for (const sub of await readdir(path.join(winget, d))) {
          const exe = path.join(winget, d, sub, "rclone.exe");
          if (existsSync(exe)) return (rclone = exe);
        }
      }
    } catch { /* no winget folder */ }
    return null;
  }

  let rcd: { proc: ChildProcess; url: string; auth: string } | null = null;
  let rcdStarting: Promise<typeof rcd> | null = null;
  async function startRcd() {
    if (rcd && rcd.proc.exitCode === null) return rcd;
    rcdStarting ??= (async () => {
      const bin = await findRclone();
      if (!bin) throw new Error("rclone is not installed on the host (winget install Rclone.Rclone)");
      const port = 5572 + Math.floor(Math.random() * 400);
      const pass = crypto.randomBytes(18).toString("hex");
      // 64M chunks: a browser upload's last step (onto Drive) took 34 s for
      // 20 MB with the default 8M, 7 s with these.
      const proc = spawn(bin, ["rcd", `--rc-addr=127.0.0.1:${port}`, "--rc-user=nx", `--rc-pass=${pass}`, "--rc-job-expire-duration=6h",
        "--drive-chunk-size=64M", "--log-level=ERROR"], { windowsHide: true, stdio: "ignore" });
      const next = { proc, url: `http://127.0.0.1:${port}`, auth: "Basic " + Buffer.from(`nx:${pass}`).toString("base64") };
      proc.on("exit", () => { if (rcd === next) rcd = null; });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const ok = await fetch(`${next.url}/rc/noop`, { method: "POST", headers: { Authorization: next.auth, "Content-Type": "application/json" }, body: "{}" })
          .then((r) => r.ok).catch(() => false);
        if (ok) { rcd = next; return next; }
      }
      proc.kill();
      throw new Error("rclone did not start");
    })().finally(() => { rcdStarting = null; });
    return rcdStarting;
  }
  async function rc<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const d = await startRcd();
    const r = await fetch(`${d!.url}/${method}`, {
      method: "POST", headers: { Authorization: d!.auth, "Content-Type": "application/json" },
      body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(body?.error ?? `rclone ${method} failed (${r.status})`).replace(/^.*?: /, ""));
    return body as T;
  }
  process.once("exit", () => { try { rcd?.proc.kill(); } catch { /* gone */ } for (const p of running.values()) { try { p.kill(); } catch { /* gone */ } } });

  // ── Accounts ──────────────────────────────────────────────────────────
  const emailCache = new Map<string, { at: number; email: string | null }>();
  async function emailOf(remote: string): Promise<string | null> {
    const hit = emailCache.get(remote);
    if (hit && Date.now() - hit.at < 3600_000) return hit.email;
    let email: string | null = null;
    try {
      // rclone refreshes the token as it uses it; read the current one and ask Google whose it is.
      await rc("operations/about", { fs: `${remote}:` });
      const cfg = await rc<Record<string, string>>("config/get", { name: remote });
      const token = JSON.parse(cfg.token ?? "{}").access_token;
      if (token) {
        const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        email = (await r.json().catch(() => null))?.user?.emailAddress ?? null;
      }
    } catch { /* label falls back to the remote name */ }
    emailCache.set(remote, { at: Date.now(), email });
    return email;
  }
  async function accounts() {
    const { remotes = [] } = await rc<{ remotes: string[] }>("config/listremotes");
    const types = await rc<Record<string, any>>("config/dump").catch(() => ({}));
    const drives = remotes.filter((r) => !isPersonalRemote(r) && ["drive", "webdav", "onedrive", "dropbox"].includes(types[r]?.type ?? "drive"));
    return Promise.all(drives.map(async (name) => {
      const [about, email] = await Promise.all([rc("operations/about", { fs: `${name}:` }, 30_000).catch(() => null), emailOf(name)]);
      return { name, email, total: about?.total ?? null, used: about?.used ?? null, free: about?.free ?? null, trashed: about?.trashed ?? null };
    }));
  }

  // ── Jobs: persistence ─────────────────────────────────────────────────
  // Written to a temp file and renamed into place, with the previous copy kept
  // as .bak: a crash or power cut mid-write must not lose the record of which
  // uploads are finished and verified.
  let writing: Promise<void> = Promise.resolve();
  const saveNow = () => (writing = writing.then(async () => {
    const tmp = `${jobsFile}.tmp`;
    await writeFile(tmp, JSON.stringify(jobs, null, 1));
    if (existsSync(jobsFile)) await copyFile(jobsFile, `${jobsFile}.bak`).catch(() => {});
    await rename(tmp, jobsFile);
  }).catch((e) => deps.log("WARN", `Could not save the upload list: ${e?.message ?? e}`)));
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; void saveNow(); }, 1000);
  };
  const newStats = (): OffloadJob["stats"] => ({ bytes: 0, totalBytes: 0, transfers: 0, totalTransfers: 0, checks: 0, totalChecks: 0, errors: 0, speed: 0, eta: null, current: [] });

  // ── Jobs: running ─────────────────────────────────────────────────────
  // One upload at a time: they share the host's uplink, and one at full
  // speed finishes everything sooner than several fighting.
  function pump() {
    const now = Date.now();
    // Failed uploads try again by themselves: 5 min, 15 min, 1 h, then every 6 h.
    for (const j of jobs) {
      if (j.status === "failed" && j.retryAt && now >= j.retryAt) { j.status = "queued"; j.retryAt = null; save(); }
      // Kept-up-to-date folders are copied again once a day for anything new.
      if ((j.keepSynced || j.stillChanging?.count) && j.nextSyncAt && now >= j.nextSyncAt && ["verified", "kept", "done", "incomplete"].includes(j.status) && existsSync(j.source)) {
        j.status = "queued"; j.nextSyncAt = null; j.stats = newStats(); save();
      }
    }
    // A copy that has moved no data for 30 minutes is stuck (a hung
    // connection, a sleeping disk); restart it, and rclone skips what is done.
    for (const j of jobs) {
      if (j.status !== "copying") continue;
      const proc = running.get(j.id);
      if (proc && j.lastProgressAt && now - j.lastProgressAt > 30 * 60_000) {
        deps.log("WARN", `Upload ${j.id} made no progress for 30 minutes; restarting it`);
        j.lastError = "Stalled; restarted automatically";
        j.status = "queued";
        restarting.add(j.id);
        proc.kill();
      }
    }
    if ([...jobs].some((j) => j.status === "copying" || j.status === "verifying" || j.status === "deleting")) return;
    if (deps.gameModeActive?.()) return;
    const next = jobs.find((j) => j.status === "queued");
    if (next) void runCopy(next);
  }
  const restarting = new Set<string>();
  const RETRY_DELAYS = [5, 15, 60, 360].map((m) => m * 60_000);
  function failed(job: OffloadJob, why: string) {
    job.status = "failed";
    job.lastError = why;
    job.attempts = (job.attempts ?? 0) + 1;
    job.retryAt = Date.now() + RETRY_DELAYS[Math.min(job.attempts - 1, RETRY_DELAYS.length - 1)];
    deps.log("WARN", `Upload ${job.id} failed (attempt ${job.attempts}): ${why}; retrying ${new Date(job.retryAt).toLocaleTimeString()}`);
  }
  const pumpTimer = setInterval(pump, 15_000);
  pumpTimer.unref?.();

  // ── Upload speed ──────────────────────────────────────────────────────
  // An upload at full speed fills the host's uplink, and a full uplink
  // delays everything else: on 2026-10-14 page requests took 6-8 s and the
  // app showed "offline" while 1.1 MB/s of ROMs went up. So uploads are
  // capped during the day, run flat out overnight, and nearly stop while a
  // game is being played on the PC. The cap is changed on the running rclone
  // through its own remote control, so nothing restarts.
  //   NEXUS_UPLOAD_BWLIMIT        daytime cap (default 650k)
  //   NEXUS_UPLOAD_FULL_HOURS     hours at full speed (default 1-7)
  //   NEXUS_UPLOAD_BWLIMIT_GAMING cap while gaming (default 64k)
  const jobRc = new Map<string, { url: string; auth: string; rate: string }>();
  //   Idle boost (2026-10-15): the cap is only needed while someone is using
  //   the site. At 650k a 500 GB backlog took months; with nobody watching or
  //   browsing, uploads run flat out (NEXUS_UPLOAD_BWLIMIT_IDLE, default off)
  //   and drop back to the cap within seconds of someone arriving.
  //   Browsing (2026-10-16): the cap was also applied when someone was only
  //   browsing, which barely uses the upload line, so uploads crawled all day
  //   (31 GB took 8 h at 1.1 MB/s). Now the 650k cap is for streaming; while
  //   someone browses, uploads take 70% of the line's speed, learned from
  //   uncapped runs (NEXUS_UPLOAD_BROWSING_SHARE to change the share).
  let handovers = 0; // browser uploads being moved onto Drive right now
  const capacityFile = path.join(deps.persistDir, "upload-capacity.json");
  let capacity = 0; // bytes/s the line managed uncapped (slowly forgets peaks)
  readFile(capacityFile, "utf8").then((t) => { capacity = Number(JSON.parse(t).bytesPerSecond) || 0; }).catch(() => {});
  function learnCapacity(speed: number) {
    if (!(speed > 0)) return;
    const next = speed > capacity ? capacity * 0.7 + speed * 0.3 : capacity * 0.999 + speed * 0.001;
    if (Math.abs(next - capacity) / Math.max(1, capacity) > 0.02) {
      capacity = next;
      writeFile(capacityFile, JSON.stringify({ bytesPerSecond: Math.round(capacity), at: new Date().toISOString() })).catch(() => {});
    } else capacity = next;
  }
  function desiredRate(): string {
    if (deps.gameModeActive?.()) return process.env.NEXUS_UPLOAD_BWLIMIT_GAMING?.trim() || "64k";
    const [from, to] = (process.env.NEXUS_UPLOAD_FULL_HOURS?.trim() || "1-7").split("-").map(Number);
    const h = new Date().getHours();
    const full = from <= to ? h >= from && h < to : h >= from || h < to;
    if (full) return "off";
    // Someone's own upload is going onto Drive: they are waiting for it, the
    // background copies are not. Measured: 20 MB took 99 s behind a running
    // folder copy, 7 s on its own.
    if (handovers > 0) return capacity > 0 ? `${Math.max(650, Math.round((capacity * 0.3) / 1024))}k` : "650k";
    if (deps.siteBusy && !deps.siteBusy()) return process.env.NEXUS_UPLOAD_BWLIMIT_IDLE?.trim() || "off";
    // While someone streams: leave 60% of the measured line for them (a
    // film needs ~1 MB/s; this line measured ~24 MB/s, where a flat 650k
    // left uploads crawling during every evening's viewing).
    const floor = process.env.NEXUS_UPLOAD_BWLIMIT?.trim() || "650k";
    const streamKib = capacity > 0 ? Math.round((capacity * 0.4) / 1024) : 0;
    const capped = streamKib > 650 ? `${streamKib}k` : floor;
    if (deps.streamingNow && !deps.streamingNow() && capacity > 0) {
      const share = Math.min(0.95, Math.max(0.2, Number(process.env.NEXUS_UPLOAD_BROWSING_SHARE) || 0.7));
      const kib = Math.round((capacity * share) / 1024);
      return kib > 650 ? `${kib}k` : capped;
    }
    return capped;
  }
  /** Apply the current limit to every running upload now (someone just arrived). */
  function applyRate() {
    const rate = desiredRate();
    for (const [id, c] of jobRc) {
      if (c.rate === rate) continue;
      fetch(`${c.url}/core/bwlimit`, { method: "POST", headers: { Authorization: c.auth, "Content-Type": "application/json" }, body: JSON.stringify({ rate }) })
        .then((r) => { if (r.ok) { c.rate = rate; deps.log("INFO", `Upload ${id}: speed limit now ${rate}`); } }).catch(() => {});
    }
  }
  const bwTimer = setInterval(() => {
    const rate = desiredRate();
    for (const [id, c] of jobRc) {
      if (c.rate === rate) continue;
      fetch(`${c.url}/core/bwlimit`, { method: "POST", headers: { Authorization: c.auth, "Content-Type": "application/json" }, body: JSON.stringify({ rate }) })
        .then((r) => { if (r.ok) { c.rate = rate; deps.log("INFO", `Upload ${id}: speed limit now ${rate}`); } }).catch(() => {});
    }
  }, 15_000);
  bwTimer.unref?.();

  function parseStats(job: OffloadJob, line: string) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { return; }
    const s = entry?.stats;
    if (s) {
      if ((Number(s.bytes) || 0) !== job.stats.bytes || (Number(s.checks) || 0) !== job.stats.checks) job.lastProgressAt = Date.now();
      const now = Date.now();
      const bytes = Number(s.bytes) || 0;
      const totalBytes = Number(s.totalBytes) || 0;
      if (job.tickAt && now - job.tickAt < 60_000) job.activeMs = (job.activeMs ?? 0) + (now - job.tickAt);
      job.tickAt = now;
      // "Time left" from the last five minutes of real progress. rclone's own
      // figure follows the speed of the moment, which jumps every time the
      // limit changes (someone arrives, leaves, the night window opens).
      const win = (job.speedWin ??= []);
      if (win.length && bytes < win[win.length - 1][1]) win.length = 0; // rclone restarted its count
      // A new run after a restart counts from 0: keep what the last run sent.
      if (bytes < job.stats.bytes && job.stats.bytes > 0) job.carriedBytes = (job.carriedBytes ?? 0) + job.stats.bytes;
      win.push([now, bytes]);
      while (win.length > 2 && now - win[0][0] > 5 * 60_000) win.shift();
      const span = (now - win[0][0]) / 1000;
      const speed = span >= 20 ? Math.max(0, (bytes - win[0][1]) / span) : Number(s.speed) || 0;
      // Still listing: files to check are still being found, so the total is not known yet.
      job.counting = (Number(s.totalChecks) || 0) > (Number(s.checks) || 0) || (span < 20 && bytes === 0);
      const left = Math.max(0, totalBytes - bytes);
      if (jobRc.get(job.id)?.rate === "off" && span >= 60) learnCapacity(speed);
      job.stats = {
        bytes, totalBytes,
        transfers: Number(s.transfers) || 0, totalTransfers: Number(s.totalTransfers) || 0,
        checks: Number(s.checks) || 0, totalChecks: Number(s.totalChecks) || 0,
        errors: Number(s.errors) || 0, speed,
        eta: job.counting || !(speed > 0) ? null : Math.round(left / speed),
        current: Array.isArray(s.transferring) ? s.transferring.slice(0, 4).map((t: any) => `${t.name} ${Math.round(t.percentage ?? 0)}%`) : [],
      };
      save();
    } else if (entry?.level === "error" && entry?.msg) {
      job.lastError = String(entry.msg).slice(0, 300);
      save();
    }
  }

  // ── Duplicates already on Drive ──────────────────────────────────────
  // rclone skips a file that is already at the same place on Drive. A film
  // copied earlier from another folder (E:\Movies, then F:\movies) would be
  // sent again, so before a copy the archive on Drive is listed once and any
  // file here with the same name and size as one there (5 MB or more) is
  // left out of the copy and of the check. Left-out files are never deleted
  // from this PC: only files the check confirmed at this job's destination are.
  const driveListing = new Map<string, { at: number; files: Map<string, string> }>();
  async function listDrive(bin: string, remote: string, root: string): Promise<Map<string, string>> {
    const key = `${remote}:${root}`;
    const hit = driveListing.get(key);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.files;
    const out = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["lsjson", "-R", "--files-only", "--fast-list", "--no-mimetype", "--no-modtime", key],
        { windowsHide: true, maxBuffer: 512 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const files = new Map<string, string>();
    for (const e of JSON.parse(out || "[]") as Array<{ Path: string; Name: string; Size: number }>) {
      if (e.Size >= 5 * 1024 * 1024) files.set(`${e.Name.toLowerCase()}|${e.Size}`, `${root}/${e.Path}`);
    }
    driveListing.set(key, { at: Date.now(), files });
    return files;
  }
  async function walkLocal(root: string): Promise<Array<{ rel: string; name: string; size: number; mtimeMs: number }>> {
    const out: Array<{ rel: string; name: string; size: number; mtimeMs: number }> = [];
    const visit = async (dir: string, rel: string) => {
      for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (/^(\$RECYCLE\.BIN|System Volume Information)$/i.test(d.name)) continue;
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) await visit(path.join(dir, d.name), r);
        else if (d.isFile()) { const st = await stat(path.join(dir, d.name)).catch(() => null); if (st) out.push({ rel: r, name: d.name, size: st.size, mtimeMs: st.mtimeMs }); }
      }
    };
    await visit(root, "");
    return out;
  }
  const globEscape = (p: string) => p.replace(/[\\*?[\]{}]/g, (c) => `\\${c}`);
  async function findDupes(job: OffloadJob, bin: string) {
    const root = job.dest.split("/")[0] || job.dest;
    const [onDrive, here] = await Promise.all([listDrive(bin, job.remote, root), walkLocal(job.source)]);
    const dest = job.dest.replace(/\/+$/, "");
    const skip: string[] = []; const examples: string[] = [];
    let bytes = 0;
    const recent = here.filter((f) => Date.now() - f.mtimeMs < SETTLE_MS || Boolean(deps.isIncomplete?.(path.join(job.source, f.rel))));
    job.stillChanging = recent.length ? { count: recent.length, bytes: recent.reduce((n, f) => n + f.size, 0), at: Date.now() } : null;
    if (recent.length) deps.log("INFO", `Upload ${job.id}: ${recent.length} file(s) changed in the last half hour or still downloading; they go in a later run`);
    for (const f of recent) {
      skip.push(`- /${globEscape(f.rel)}`);
    }
    for (const f of here) {
      if (recent.includes(f)) continue;
      if (f.size < 5 * 1024 * 1024) continue;
      const there = onDrive.get(`${f.name.toLowerCase()}|${f.size}`);
      // Not on Drive, or at this job's own place (rclone skips those itself).
      if (!there || there.toLowerCase() === `${dest}/${f.rel}`.toLowerCase()) continue;
      skip.push(`- /${globEscape(f.rel)}`);
      bytes += f.size;
      if (examples.length < 20) examples.push(`${f.rel} = ${there}`);
    }
    await mkdir(reportsDir, { recursive: true });
    const file = path.join(reportsDir, `${job.id}.dupes.txt`);
    await writeFile(file, skip.join("\n") + (skip.length ? "\n" : ""));
    job.dupes = { count: skip.length, bytes, at: Date.now(), file, examples };
    if (skip.length) deps.log("INFO", `Upload ${job.id}: ${skip.length} file(s), ${gbs(bytes)}, are already on Drive elsewhere; not sending them again`);
    saveNow();
  }
  const dupeArgs = (job: OffloadJob) => (job.dupes?.count && existsSync(job.dupes.file) ? [`--exclude-from=${job.dupes.file}`] : []);

  async function runCopy(job: OffloadJob) {
    const bin = await findRclone();
    if (!bin) { job.status = "failed"; job.lastError = "rclone is not installed on the host"; return saveNow(); }
    if (!existsSync(job.source)) { failed(job, `The folder ${job.source} is not reachable (disk asleep or unplugged?)`); return saveNow(); }
    job.status = "copying";
    job.startedAt ??= Date.now();
    job.lastProgressAt = Date.now();
    if (job.lastError !== "Stalled; restarted automatically") job.lastError = null;
    saveNow();
    await findDupes(job, bin).catch((e) => deps.log("WARN", `Upload ${job.id}: duplicate check skipped: ${e?.message ?? e}`));
    if (job.status !== "copying") return; // paused or removed while looking
    deps.log("INFO", `Upload ${job.id}: ${job.source} -> ${job.remote}:${job.dest}`);
    const rcPort = 6100 + Math.floor(Math.random() * 800);
    const rcPass = crypto.randomBytes(12).toString("hex");
    const rate = desiredRate();
    jobRc.set(job.id, { url: `http://127.0.0.1:${rcPort}`, auth: "Basic " + Buffer.from(`nx:${rcPass}`).toString("base64"), rate });
    const args = ["copy", job.source, `${job.remote}:${job.dest}`, `--bwlimit=${rate}`, "--rc", `--rc-addr=127.0.0.1:${rcPort}`, "--rc-user=nx", `--rc-pass=${rcPass}`,
      // ROM and music folders are thousands of small files, where Drive's
      // per-file overhead, not the line, sets the pace: send more at once.
      // --fast-list reads the folder on Drive in a few big requests.
      `--transfers=${job.kind === "movies" || job.kind === "tv" ? 4 : 8}`, "--checkers=16", "--fast-list", "--drive-chunk-size=64M",
      "--retries=10", "--low-level-retries=20", "--use-json-log", "--log-level=NOTICE", "--stats=4s", "--stats-log-level=NOTICE",
      ...excludeArgs(), ...dupeArgs(job)];
    const proc = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    running.set(job.id, proc);
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { parseStats(job, buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("close", (code) => {
      running.delete(job.id);
      jobRc.delete(job.id);
      if (job.status === "paused") { saveNow(); return pump(); }
      if (restarting.delete(job.id)) { job.status = "queued"; saveNow(); return pump(); }
      if (code === 0) { job.attempts = 0; job.carriedBytes = 0; job.stats = { ...job.stats, bytes: 0 }; void runVerify(job); return; }
      failed(job, job.lastError ?? `rclone stopped with code ${code}`);
      saveNow();
      pump();
    });
  }

  async function runVerify(job: OffloadJob) {
    const bin = await findRclone();
    if (!bin) return;
    job.status = "verifying";
    saveNow();
    await mkdir(reportsDir, { recursive: true });
    const report = path.join(reportsDir, `${job.id}.txt`);
    // One-way: every file in the folder on this PC must be on Drive with the
    // same size and MD5. Files only on Drive are fine.
    const proc = spawn(bin, ["check", job.source, `${job.remote}:${job.dest}`, "--one-way", `--combined=${report}`, "--checkers=8",
      "--use-json-log", "--log-level=ERROR", ...excludeArgs(), ...dupeArgs(job)], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    running.set(job.id, proc);
    proc.stderr!.on("data", () => {});
    proc.on("close", async () => {
      running.delete(job.id);
      if (job.status === "paused") { saveNow(); return pump(); }
      const lines = (await readFile(report, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
      const v = { at: Date.now(), matched: 0, missing: 0, differ: 0, errors: 0, matchedBytes: 0, problems: [] as string[] };
      for (const l of lines) {
        const mark = l[0], rel = l.slice(2);
        if (mark === "=") v.matched++;
        else if (mark === "+") { v.missing++; if (v.problems.length < 50) v.problems.push(`Not on Drive: ${rel}`); }
        else if (mark === "*") { v.differ++; if (v.problems.length < 50) v.problems.push(`Different on Drive: ${rel}`); }
        else if (mark === "!") { v.errors++; if (v.problems.length < 50) v.problems.push(`Could not check: ${rel}`); }
      }
      for (const l of lines) if (l[0] === "=") v.matchedBytes += (await stat(path.join(job.source, l.slice(2))).catch(() => null))?.size ?? 0;
      job.verify = v;
      job.status = v.missing || v.differ || v.errors ? "incomplete" : "verified";
      job.lastError = null;
      job.finishedAt = Date.now();
      saveNow();
      deps.log("INFO", `Upload ${job.id} checked: ${v.matched} file(s) confirmed on Drive${v.missing + v.differ + v.errors ? `, ${v.missing + v.differ + v.errors} problem(s)` : ""}`);
      receipt(job.status === "verified"
        ? { kind: "upload", title: `On Google Drive: ${job.label}`, detail: `${v.matched} file(s), ${gbs(v.matchedBytes)}, every checksum matched (${job.remote}:${job.dest})`, bytes: v.matchedBytes, data: { job: job.id, source: job.source } }
        : { kind: "upload", status: "warn", title: `Upload not complete yet: ${job.label}`, detail: `${v.matched} confirmed, ${v.missing + v.differ + v.errors} still to retry`, data: { job: job.id } });
      if (job.status === "verified") deps.onUploaded?.(job.kind);
      // The owner asked for this folder to be cleared once it is safely on Drive.
      if (job.status === "verified" && job.autoFree && (job.verify?.matched ?? 0) > 0) {
        deps.log("INFO", `Upload ${job.id}: verified, freeing this PC as asked`);
        await deleteVerified(job).catch((e) => deps.log("WARN", `Upload ${job.id}: freeing space failed: ${e?.message ?? e}`));
      }
      if (job.status === "incomplete") failed(job, `${v.missing + v.differ + v.errors} file(s) not confirmed on Drive yet`);
      if (job.keepSynced) job.nextSyncAt = Date.now() + 24 * 3600_000;
      // Files that were still downloading: back in a few hours for them.
      if (job.stillChanging?.count) job.nextSyncAt = Math.min(job.nextSyncAt ?? Infinity, Date.now() + 3 * 3600_000);
      pump();
    });
  }

  /** Delete the local files the last check confirmed, if they have not changed since. */
  async function deleteVerified(job: OffloadJob) {
    const report = path.join(reportsDir, `${job.id}.txt`);
    const lines = (await readFile(report, "utf8").catch(() => "")).split(/\r?\n/).filter((l) => l.startsWith("= "));
    job.status = "deleting";
    saveNow();
    let files = 0, bytes = 0, skipped = 0;
    const dirs = new Set<string>();
    const root = path.resolve(job.source);
    for (const l of lines) {
      const full = path.resolve(root, l.slice(2));
      if (!full.startsWith(root + path.sep)) { skipped++; continue; }
      const st = await stat(full).catch(() => null);
      // Changed after the check (or gone): leave it.
      if (!st || st.mtimeMs > (job.verify?.at ?? 0)) { skipped++; continue; }
      try { await unlink(full); files++; bytes += st.size; dirs.add(path.dirname(full)); } catch { skipped++; }
    }
    // Folders left empty, deepest first; the source folder itself stays.
    const sorted = [...dirs].sort((a, b) => b.length - a.length);
    for (let d of sorted) {
      while (d.startsWith(root + path.sep)) {
        const left = await readdir(d).catch(() => ["?"]);
        if (left.length) break;
        await rmdir(d).catch(() => {});
        d = path.dirname(d);
      }
    }
    job.deleted = { at: Date.now(), files, bytes, skipped };
    job.status = "done";
    saveNow();
    deps.log("INFO", `Upload ${job.id}: deleted ${files} local file(s), ${(bytes / 1e9).toFixed(1)} GB freed${skipped ? `, ${skipped} left (changed or locked)` : ""}`);
    receipt({ kind: "freed", title: `Freed ${gbs(bytes)} on this PC`, detail: `${files} file(s) from ${job.source}, safe on Google Drive (${job.remote}:${job.dest})${skipped ? `; ${skipped} left because they changed or were in use` : ""}`, bytes, data: { job: job.id } });
  }

  addLiveSource(() => jobs.filter((j) => ["copying", "verifying", "deleting", "queued", "paused"].includes(j.status)).map((j) => ({
    kind: "upload", title: j.label, status: j.status, jobId: j.id,
    actions: j.status === "paused" ? ["resume"] : j.status === "deleting" ? [] : ["pause"],
    progress: j.status === "copying" && j.stats.totalBytes ? ((j.carriedBytes ?? 0) + j.stats.bytes) / ((j.carriedBytes ?? 0) + j.stats.totalBytes) : j.status === "verifying" && j.stats.totalChecks ? j.stats.checks / j.stats.totalChecks : null,
    detail: j.status === "copying" ? `Uploading to ${j.remote}: ${gbs((j.carriedBytes ?? 0) + j.stats.bytes)} of ${gbs((j.carriedBytes ?? 0) + j.stats.totalBytes)}${j.counting ? " so far (still counting what's left)" : ""}${j.carriedBytes ? " · carried on after a restart" : ""}${j.stats.checks ? ` · ${j.stats.checks} file(s) already on Drive skipped` : ""}${j.dupes?.count ? ` · ${j.dupes.count} duplicate(s) already on Drive elsewhere (${gbs(j.dupes.bytes)}) not sent again` : ""}${j.stillChanging?.count ? ` · ${j.stillChanging.count} file(s) still downloading, sent in a later run` : ""}${deps.gameModeActive?.() ? " · held back while a game is running on this PC (carries on at full speed when you close it)" : jobRc.get(j.id)?.rate && jobRc.get(j.id)!.rate !== "off" ? ` · limited to ${jobRc.get(j.id)!.rate}/s while the site is in use` : ""}`
      : j.status === "verifying" ? "Checking every file against Drive" : j.status === "deleting" ? "Freeing space on this PC" : j.status === "paused" ? "Paused. Press Continue to carry on where it stopped." : "Waiting for its turn",
    speed: j.status === "copying" ? j.stats.speed : null, eta: j.status === "copying" ? j.stats.eta : null,
  })));

  // Finished copies for the Activity log's "Completed" list: what was copied
  // where, and what the file-by-file check against Drive found.
  addCompletedSource(() => jobs.filter((j) => j.verify || j.status === "failed").map((j) => {
    const v = j.verify;
    const bad = v ? v.missing + v.differ + v.errors : 0;
    const checked = v ? v.matched + bad : 0;
    // Time actually spent copying; older jobs only have start and finish.
    const took = j.activeMs && j.activeMs > 0 ? j.activeMs : j.startedAt && j.finishedAt && j.finishedAt > j.startedAt ? j.finishedAt - j.startedAt : 0;
    const dur = took >= 3600_000 ? `${Math.floor(took / 3600_000)} h ${Math.round((took % 3600_000) / 60_000)} min` : took >= 60_000 ? `${Math.round(took / 60_000)} min` : took ? `${Math.round(took / 1000)} s` : "";
    const result: "verified" | "warn" | "failed" = !v ? "failed" : bad ? "warn" : "verified";
    const facts: Array<[string, string]> = [];
    if (v) {
      facts.push(["Files checked", `${checked}`], ["Matched on Drive", `${v.matched} (${humanBytes(v.matchedBytes)})`]);
      if (v.missing) facts.push(["Not on Drive yet", `${v.missing}`]);
      if (v.differ) facts.push(["Different on Drive", `${v.differ}`]);
      if (v.errors) facts.push(["Couldn't check", `${v.errors}`]);
      facts.push(["Checked", new Date(v.at).toLocaleString("en-ZA")]);
    }
    if (j.stillChanging?.count) facts.push(["Still downloading", `${j.stillChanging.count} file(s), ${humanBytes(j.stillChanging.bytes)}: copied in a later run once they stop changing${j.nextSyncAt ? ` (next ${new Date(j.nextSyncAt).toLocaleString("en-ZA")})` : ""}`]);
    if (j.dupes?.count) facts.push(["Already on Drive elsewhere", `${j.dupes.count} file(s), ${humanBytes(j.dupes.bytes)}, not sent again (kept on this PC)`]);
    if (dur) facts.push(["Took", `${dur}${took && v ? ` (about ${humanBytes(v.matchedBytes / (took / 1000))}/s)` : ""}`]);
    if (j.deleted) facts.push(["Freed on this PC", `${j.deleted.files} file(s), ${humanBytes(j.deleted.bytes)}${j.deleted.skipped ? `, ${j.deleted.skipped} left (changed or in use)` : ""}`]);
    facts.push(["Kept in step", j.keepSynced ? `yes, rechecked daily${j.nextSyncAt ? ` (next ${new Date(j.nextSyncAt).toLocaleDateString("en-ZA")})` : ""}` : "no"]);
    if (existsSync(path.join(reportsDir, `${j.id}.txt`))) facts.push(["Full report", `/api/admin/offload/${j.id}/report`]);
    // Every file confirmed on Drive and the folder still here: offer to free it.
    // Only files checked before (and unchanged since) are deleted; anything
    // still downloading or skipped as a duplicate stays.
    const actions: NonNullable<CompletedItem["actions"]> = [];
    if (v && !bad && j.status === "verified" && !j.deleted && v.matched > 0 && existsSync(j.source)) {
      const stays = [j.stillChanging?.count ? `${j.stillChanging.count} still downloading` : "", j.dupes?.count ? `${j.dupes.count} already on Drive elsewhere` : ""].filter(Boolean).join(" and ");
      actions.push({
        label: "Delete the local folder", danger: true, post: `/api/admin/offload/${j.id}/delete-local`,
        ask: `Delete ${v.matched} file(s) (${humanBytes(v.matchedBytes)}) in ${j.source} from this PC?\n\nEvery one is on Google Drive (${j.remote}:${j.dest}) and its checksum matched. Files changed since the check are kept${stays ? `, and so are ${stays}` : ""}.`,
      });
    }
    if (v && ["verified", "incomplete", "kept"].includes(j.status) && !running.has(j.id)) actions.push({ label: "Check against Drive again", post: `/api/admin/offload/${j.id}/verify` });
    return {
      actions: actions.length ? actions : undefined,
      kind: "upload", id: j.id, title: j.label, result,
      summary: !v ? `Stopped: ${j.lastError ?? "the copy failed"}`
        : bad ? `${v.matched} of ${checked} files confirmed on Drive; ${bad} will be retried`
        : `All ${v.matched} files are on Google Drive and every checksum matched (${humanBytes(v.matchedBytes)}).`,
      startedAt: j.startedAt, finishedAt: j.finishedAt ?? v?.at ?? null,
      from: j.source, to: `${j.remote}:${j.dest}`, facts, problems: v?.problems?.length ? v.problems : undefined,
    };
  }));

  // Jobs interrupted by a restart pick up where they were.
  void (async () => {
    try { jobs = JSON.parse(await readFile(jobsFile, "utf8")); }
    catch {
      try { jobs = JSON.parse(await readFile(`${jobsFile}.bak`, "utf8")); deps.log("WARN", "Upload list restored from its backup copy"); }
      catch { jobs = []; }
    }
    for (const j of jobs) if (j.kind === "roms" && j.keepSynced === undefined) j.keepSynced = true;
    let resumed = 0;
    for (const j of jobs) {
      if (j.status === "copying" || j.status === "verifying") { j.status = "queued"; resumed++; }
      if (j.status === "deleting") j.status = "verified";
    }
    if (resumed) deps.log("INFO", `Resuming ${resumed} interrupted upload(s)`);
    saveNow();
    setTimeout(pump, 30_000).unref?.();
  })();

  // ── Routes ────────────────────────────────────────────────────────────
  function register(app: express.Express) {
    const fail = (res: express.Response, e: any, status = 500) => res.status(status).json({ error: String(e?.message ?? e).slice(0, 300) });

    // Sizes of six local disks (some asleep) and two Google accounts: kept a
    // minute, and fetched once shortly after start-up so the page opens fast.
    let drivesCache: { at: number; body: any } | null = null;
    const summary = async () => {
      if (drivesCache && Date.now() - drivesCache.at < 60_000) return drivesCache.body;
      const local = await Promise.all(LOCAL_DRIVES.map(async (d) => {
        const about = existsSync(`${d}\\`) ? await rc("operations/about", { fs: `${d}/` }, 15_000).catch(() => null) : null;
        return about ? { name: d, total: about.total ?? null, used: about.used ?? null, free: about.free ?? null } : null;
      }));
      const body = { ok: true, accounts: await accounts(), local: local.filter(Boolean) };
      drivesCache = { at: Date.now(), body };
      return body;
    };
    setTimeout(() => { void findRclone().then((b) => b && summary()).catch(() => {}); }, 30_000).unref?.();
    app.get("/api/admin/drives", async (req, res) => {
      try {
        const bin = await findRclone();
        if (!bin) return res.json({ ok: false, error: "rclone is not installed on the host", accounts: [], local: [] });
        if (req.query.fresh === "1") drivesCache = null;
        res.json(await summary());
      } catch (e) { fail(res, e); }
    });

    // ── File manager routes, mounted once per audience ─────────────────────
    // allow(req, fs) says whether the caller may touch that drive; every
    // route below names its drive(s) in fs / fromFs / toFs, and the
    // middleware checks them all before the route runs.
    const transfers: Array<{ owner: string; id: number; label: string; startedAt: number }> = [];
    // A browser upload in progress: parts arrive in any order (several at
    // once, some retried), each written at its own offset, so a retried part
    // simply overwrites itself. `parts` maps offset -> length.
    const uploads = new Map<string, { owner: string; file: string; fs: string; dest: string; size: number; got: number; parts: Map<number, number>; name: string; startedAt: number; lastAt: number }>();
    // Parts of uploads that were abandoned (tab closed, connection lost for
    // good) are removed after a day.
    const sweepUploads = async () => {
      const now = Date.now();
      for (const [id, u] of uploads) if (now - u.lastAt > 24 * 3600_000) { uploads.delete(id); await rm(u.file, { force: true }).catch(() => {}); }
      for (const f of await readdir(uploadDir).catch(() => [] as string[])) {
        if ([...uploads.values()].some((u) => path.basename(u.file) === f)) continue;
        const st = await stat(path.join(uploadDir, f)).catch(() => null);
        if (st && now - st.mtimeMs > 24 * 3600_000) await rm(path.join(uploadDir, f), { force: true }).catch(() => {});
      }
    };
    setInterval(() => { void sweepUploads(); }, 3600_000).unref();
    // Browser uploads that arrived and are now going on to Drive.
    const savingToDrive = new Set<{ name: string; size: number; fs: string; dest: string; startedAt: number }>();
    addLiveSource(() => [...savingToDrive].map((u) => ({
      kind: "upload", title: `Saving ${u.name} to Drive`, progress: null, status: "copying",
      detail: `${humanBytes(u.size)} uploaded from a browser; now going to ${u.fs}:${u.dest}`,
    })));
    const registerBrowse = (base: string, allow: (req: express.Request, fs: string) => Promise<boolean>, ownerOf: (req: express.Request) => Promise<string>) => {
      app.use(base, async (req, res, next) => {
        try {
          const named = [req.query.fs, req.body?.fs, req.body?.fromFs, req.body?.toFs].filter((x) => x != null && x !== "").map(String);
          for (const fsName of named) if (!(await allow(req, fsName))) return res.status(403).json({ error: "That drive isn't one of yours." });
          const up = /^\/upload\/([a-f0-9]+)/.exec(req.path);
          if (up && uploads.has(up[1]) && uploads.get(up[1])!.owner !== (await ownerOf(req))) return res.status(403).json({ error: "Not your upload." });
          next();
        } catch (e) { fail(res, e); }
      });

      app.get(`${base}/list`, async (req, res) => {
        try {
          const fs_ = String(req.query.fs ?? "");
          const dir = cleanRel(req.query.path);
          const out = await rc<{ list: any[] }>("operations/list", { fs: fsSpec(fs_), remote: dir, opt: { noMimeType: true } }, 120_000);
          const items = (out.list ?? []).map((x) => ({ name: x.Name, path: x.Path, size: x.IsDir ? null : x.Size, modified: x.ModTime, isDir: !!x.IsDir }))
            .filter((x) => !(isLocalFs(fs_) && /^(\$RECYCLE\.BIN|System Volume Information|pagefile\.sys|hiberfil\.sys|swapfile\.sys|DumpStack\.log\.tmp)$/i.test(x.name)))
            .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
          res.json({ items });
        } catch (e) { fail(res, e); }
      });
  
      app.post(`${base}/mkdir`, async (req, res) => {
        try { await rc("operations/mkdir", { fs: fsSpec(String(req.body?.fs)), remote: cleanRel(req.body?.path) }); res.json({ ok: true }); }
        catch (e) { fail(res, e); }
      });
  
      app.post(`${base}/delete`, async (req, res) => {
        try {
          const fs_ = String(req.body?.fs);
          // Local deletes go through the job flow (verify first), never from here.
          if (isLocalFs(fs_)) return res.status(400).json({ error: "Files on this PC are only deleted after an upload has verified them." });
          const p = cleanRel(req.body?.path);
          if (!p) return res.status(400).json({ error: "Refusing to delete the whole drive." });
          // Google Drive keeps these in its trash for 30 days.
          await rc(req.body?.isDir ? "operations/purge" : "operations/deletefile", { fs: fsSpec(fs_), remote: p }, 300_000);
          res.json({ ok: true });
        } catch (e) { fail(res, e); }
      });
  
      app.post(`${base}/rename`, async (req, res) => {
        try {
          const fs_ = String(req.body?.fs);
          if (isLocalFs(fs_)) return res.status(400).json({ error: "Rename files on this PC in Explorer." });
          const from = cleanRel(req.body?.from), to = cleanRel(req.body?.to);
          if (!from || !to) return res.status(400).json({ error: "Give a name." });
          if (req.body?.isDir) await rc("sync/move", { srcFs: `${fsSpec(fs_)}${from}`, dstFs: `${fsSpec(fs_)}${to}`, deleteEmptySrcDirs: true }, 600_000);
          else await rc("operations/movefile", { srcFs: fsSpec(fs_), srcRemote: from, dstFs: fsSpec(fs_), dstRemote: to });
          res.json({ ok: true });
        } catch (e) { fail(res, e); }
      });
  
      // Drive to Drive (or Drive to this PC): an rclone background job.
      app.post(`${base}/transfer`, async (req, res) => {
        try {
          const from = String(req.body?.fromFs), to = String(req.body?.toFs);
          const src = cleanRel(req.body?.fromPath), dst = cleanRel(req.body?.toPath);
          const move = !!req.body?.move;
          if (isLocalFs(from)) return res.status(400).json({ error: "Use 'Upload & verify' to send files from this PC." });
          const params = req.body?.isDir
            ? { srcFs: `${fsSpec(from)}${src}`, dstFs: `${fsSpec(to)}${dst}`, _async: true, ...(move ? { deleteEmptySrcDirs: true } : {}) }
            : { srcFs: fsSpec(from), srcRemote: src, dstFs: fsSpec(to), dstRemote: dst, _async: true };
          const method = req.body?.isDir ? (move ? "sync/move" : "sync/copy") : (move ? "operations/movefile" : "operations/copyfile");
          const out = await rc<{ jobid: number }>(method, params);
          transfers.unshift({ owner: await ownerOf(req), id: out.jobid, label: `${move ? "Move" : "Copy"} ${path.posix.basename(src) || src} to ${to}${dst ? `:${dst}` : ""}`, startedAt: Date.now() });
          transfers.splice(20);
          res.json({ ok: true, jobid: out.jobid });
        } catch (e) { fail(res, e); }
      });
      app.get(`${base}/transfers`, async (req, res) => {
        const me = await ownerOf(req);
        const out = await Promise.all(transfers.filter((t) => t.owner === me).map(async (t) => {
          const [st, stats] = await Promise.all([
            rc("job/status", { jobid: t.id }, 10_000).catch(() => null),
            rc("core/stats", { group: `job/${t.id}` }, 10_000).catch(() => null),
          ]);
          return { ...t, finished: st?.finished ?? true, success: st?.success ?? false, error: st?.error || null,
            bytes: stats?.bytes ?? 0, totalBytes: stats?.totalBytes ?? 0, speed: stats?.speed ?? 0 };
        }));
        res.json({ transfers: out });
      });
  
      app.get(`${base}/download`, async (req, res) => {
        try {
          const fs_ = String(req.query.fs), p = cleanRel(req.query.path);
          const bin = await findRclone();
          if (!bin || !p) return res.status(404).end();
          const name = path.posix.basename(p).replace(/[\r\n"]/g, "_");
          res.setHeader("Content-Disposition", `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
          res.setHeader("Content-Type", "application/octet-stream");
          const proc = spawn(bin, ["cat", `${fsSpec(fs_)}${p}`], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
          proc.stdout!.pipe(res);
          res.on("close", () => { try { proc.kill(); } catch { /* done */ } });
        } catch (e) { fail(res, e); }
      });
  
      // Browser uploads: 8 MB parts (under Cloudflare's request limit), sent
      // several at a time and retried by the page, each written at its offset
      // into a temp file; then one move onto Drive, which rclone checks by
      // hash. Until 2026-10-16 the page sent parts without the sign-in, so
      // every upload was refused, and parts were appended blindly, so a
      // retried part would have corrupted the file.
      app.post(`${base}/upload/init`, async (req, res) => {
        try {
          const fs_ = String(req.body?.fs);
          if (isLocalFs(fs_)) return res.status(400).json({ error: "Uploads go to a Google Drive." });
          const name = String(req.body?.name ?? "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
          if (!name) return res.status(400).json({ error: "No file name" });
          await mkdir(uploadDir, { recursive: true });
          void sweepUploads();
          const id = crypto.randomBytes(12).toString("hex");
          const file = path.join(uploadDir, id);
          await writeFile(file, "");
          uploads.set(id, { owner: await ownerOf(req), file, fs: fs_, dest: joinRemote(cleanRel(req.body?.path), name), size: Math.max(0, Number(req.body?.size) || 0), got: 0, parts: new Map(), name, startedAt: Date.now(), lastAt: Date.now() });
          res.json({ id, partSize: 8 * 1024 * 1024 });
        } catch (e) { fail(res, e); }
      });
      app.put(`${base}/upload/:id`, async (req, res) => {
        const u = uploads.get(req.params.id);
        if (!u) return res.status(404).json({ error: "Upload not found; start again." });
        if (u.owner !== await ownerOf(req)) return res.status(403).json({ error: "Not your upload." });
        const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
        if (u.size && offset >= u.size && !(offset === 0 && u.size === 0)) return res.status(400).json({ error: "That part is past the end of the file." });
        let len = 0;
        const out = createWriteStream(u.file, { flags: "r+", start: offset });
        req.on("data", (c: Buffer) => { len += c.length; });
        req.pipe(out);
        out.on("finish", () => {
          u.parts.set(offset, len);
          u.got = [...u.parts.values()].reduce((a, b) => a + b, 0);
          u.lastAt = Date.now();
          res.json({ ok: true, received: u.got });
        });
        out.on("error", (e) => fail(res, e));
        req.on("aborted", () => out.destroy());
      });
      app.post(`${base}/upload/:id/complete`, async (req, res) => {
        const u = uploads.get(req.params.id);
        if (!u) return res.status(404).json({ error: "Upload not found; start again." });
        if (u.owner !== await ownerOf(req)) return res.status(403).json({ error: "Not your upload." });
        // Every byte must be here, with no gaps, before it goes to Drive.
        const ordered = [...u.parts.entries()].sort((a, b) => a[0] - b[0]);
        let end = 0;
        for (const [off, len] of ordered) { if (off > end) break; end = Math.max(end, off + len); }
        const onDisk = (await stat(u.file).catch(() => null))?.size ?? -1;
        if (end < u.size || onDisk !== u.size) return res.status(409).json({ error: `Only ${end} of ${u.size} bytes arrived; the page will resend the rest.`, received: end });
        uploads.delete(req.params.id);
        const toDrive = async () => {
          handovers++; applyRate();
          try {
            await rc("operations/movefile", { srcFs: `${uploadDir}${path.sep}`, srcRemote: path.basename(u.file), dstFs: fsSpec(u.fs), dstRemote: u.dest }, 6 * 3600_000);
          } finally { handovers--; applyRate(); }
          const secs = Math.max(1, (Date.now() - u.startedAt) / 1000);
          receipt({ kind: "upload", title: `Uploaded to Drive: ${u.name}`, detail: `${humanBytes(u.size)} to ${u.fs}:${u.dest} in ${secs >= 90 ? `${Math.round(secs / 60)} min` : `${Math.round(secs)} s`} (checked by Drive's hash)`, bytes: u.size, userId: u.owner === "admin" ? null : u.owner, data: { fs: u.fs, path: u.dest } });
        };
        // Big files go on to Drive in the background (Activity log > Happening
        // now), so the page isn't left at 100% while gigabytes cross the line.
        if (u.size > 100 * 1024 * 1024) {
          savingToDrive.add(u);
          toDrive().catch(async (e) => {
            receipt({ kind: "upload", status: "failed", title: `Couldn't save to Drive: ${u.name}`, detail: String(e?.message ?? e).slice(0, 300), bytes: u.size, userId: u.owner === "admin" ? null : u.owner });
            await rm(u.file, { force: true }).catch(() => {});
          }).finally(() => savingToDrive.delete(u));
          return res.json({ ok: true, background: true });
        }
        try {
          await toDrive();
          res.json({ ok: true });
        } catch (e) { await rm(u.file, { force: true }).catch(() => {}); fail(res, e); }
      });
      app.delete(`${base}/upload/:id`, async (req, res) => {
        const u = uploads.get(req.params.id);
        if (u && u.owner === await ownerOf(req)) { uploads.delete(req.params.id); await rm(u.file, { force: true }).catch(() => {}); }
        res.json({ ok: true });
      });
  
      };
    // Admins: the host's own drives (not members' personal ones) and the PC's disks.
    registerBrowse("/api/admin/drives", async (_req, fsName) => isLocalFs(fsName) || !isPersonalRemote(fsName), async () => "admin");
    // Members: only the drives they connected themselves (see connect.ts).
    registerBrowse("/api/drives/my", async (req, fsName) => {
      const caller = await deps.callerOf?.(req);
      return !!caller?.userId && ownerOfRemote(fsName) === caller.userId.replace(/-/g, "");
    }, async (req) => (await deps.callerOf?.(req))?.userId ?? "anon");

    // ── Upload & verify jobs ─────────────────────────────────────────────
    app.get("/api/admin/offload", (_req, res) => {
      const protectedFiles = jobs.reduce((n, j) => n + (j.verify && ["verified", "kept", "done"].includes(j.status) ? j.verify.matched : 0), 0);
      const protectedBytes = jobs.reduce((n, j) => n + (j.verify && ["verified", "kept", "done"].includes(j.status) ? j.verify.matchedBytes : 0), 0);
      res.json({ jobs, gameMode: !!deps.gameModeActive?.(), speedLimit: desiredRate(), protectedFiles, protectedBytes });
    });

    // The file-by-file check of a copy (rclone's report: "= file" matched,
    // "+" not on Drive, "*" different, "!" couldn't be read), with a key on top.
    app.get("/api/admin/offload/:id/report", async (req, res) => {
      const job = jobs.find((j) => j.id === req.params.id);
      if (!job) return res.status(404).json({ error: "No such upload." });
      const body = await readFile(path.join(reportsDir, `${job.id}.txt`), "utf8").catch(() => null);
      if (body == null) return res.status(404).json({ error: "This upload hasn't been checked yet." });
      const head = `SaveState check report: ${job.label}\r\nFrom ${job.source} to ${job.remote}:${job.dest}\r\n`
        + `Checked ${job.verify ? new Date(job.verify.at).toLocaleString("en-ZA") : "?"}\r\n`
        + `Key: "=" on Drive and identical, "+" not on Drive, "*" different on Drive, "!" could not be checked\r\n\r\n`;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="check-${job.id}.txt"`);
      res.send(head + body.replace(/\r?\n/g, "\r\n"));
    });

    app.get("/api/admin/offload/suggestions", async (_req, res) => {
      const list = (await deps.suggestions?.().catch(() => [])) ?? [];
      const out = list.filter((s) => existsSync(s.source)).map((s) => {
        const job = jobs.find((j) => j.source.toLowerCase() === path.resolve(s.source).toLowerCase());
        return { ...s, status: job?.status ?? null };
      });
      res.json({ suggestions: out });
    });

    app.post("/api/admin/offload", async (req, res) => {
      try {
        // Given in full, always: path.resolve("") is the app's own folder, and a
        // test once started uploading this project (secrets and all) that way.
        const raw = String(req.body?.source ?? "").trim();
        if (!raw || !path.isAbsolute(raw)) return res.status(400).json({ error: "Give the folder's full path, for example E:\\Music." });
        const source = path.resolve(raw);
        const fold = (p: string) => path.resolve(p).toLowerCase();
        const forbidden = [process.cwd(), deps.persistDir, os.homedir(), process.env.SystemRoot ?? "C:\\Windows", process.env.ProgramFiles ?? "C:\\Program Files",
          process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"].map(fold);
        const s = fold(source);
        if (forbidden.some((f) => s === f || s.startsWith(f + path.sep) && f !== fold(os.homedir())) || s === fold(os.homedir())
          || forbidden.slice(0, 2).some((f) => f.startsWith(s + path.sep))) {
          return res.status(400).json({ error: "That folder holds the app, its data or the system. Choose a folder of media, games or files." });
        }
        const st = await stat(source).catch(() => null);
        if (!st?.isDirectory()) return res.status(400).json({ error: "Choose a folder on this PC." });
        if (/^[A-Za-z]:\\?$/.test(source)) return res.status(400).json({ error: "Choose a folder, not a whole disk." });
        const remote = String(req.body?.remote ?? "");
        const { remotes = [] } = await rc<{ remotes: string[] }>("config/listremotes");
        if (!remotes.includes(remote) || isPersonalRemote(remote)) return res.status(400).json({ error: "Unknown Drive account." });
        const dest = cleanRel(req.body?.dest);
        if (!dest) return res.status(400).json({ error: "Choose where on Drive it goes." });
        const kind = (["movies", "tv", "music", "roms", "files"].includes(req.body?.kind) ? req.body.kind : "files") as OffloadKind;
        if (jobs.some((j) => j.source.toLowerCase() === source.toLowerCase() && !["done", "kept", "failed"].includes(j.status))) {
          return res.status(409).json({ error: "That folder already has an upload in progress." });
        }
        const job: OffloadJob = {
          id: `up_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`, label: String(req.body?.label ?? path.basename(source)).slice(0, 80),
          kind, source, remote, dest, status: "queued", createdAt: Date.now(), startedAt: null, finishedAt: null,
          stats: newStats(), lastError: null, verify: null, deleted: null,
          // ROM folders are irreplaceable: keep them backed up as they grow.
          keepSynced: req.body?.keepSynced ?? kind === "roms", autoFree: req.body?.autoFree === true, nextSyncAt: null, attempts: 0, retryAt: null, lastProgressAt: null,
        };
        jobs.unshift(job);
        saveNow();
        pump();
        res.json({ ok: true, job });
      } catch (e) { fail(res, e); }
    });

    app.post("/api/admin/offload/:id/:action", async (req, res) => {
      const job = jobs.find((j) => j.id === req.params.id);
      if (!job) return res.status(404).json({ error: "No such upload." });
      const act = req.params.action;
      if (act === "pause") {
        if (job.status === "queued" || job.status === "copying" || job.status === "verifying") {
          job.status = "paused";
          running.get(job.id)?.kill();
        }
      } else if (act === "resume" || act === "retry") {
        if (["paused", "failed", "incomplete"].includes(job.status)) { job.status = "queued"; job.lastError = null; }
      } else if (act === "verify") {
        if (["verified", "incomplete", "kept"].includes(job.status) && !running.has(job.id)) void runVerify(job);
      } else if (act === "delete-local") {
        if (job.status !== "verified") return res.status(400).json({ error: "Only an upload whose every file was confirmed on Drive can delete local copies." });
        if (req.body?.confirm !== job.id) return res.status(400).json({ error: "Confirmation missing." });
        void deleteVerified(job);
      } else if (act === "autofree-on" || act === "autofree-off") {
        // On: this folder empties itself onto Drive. Needs the same confirmation
        // as deleting by hand, and frees what is already verified straight away.
        if (act === "autofree-on" && req.body?.confirm !== job.id) return res.status(400).json({ error: "Confirmation missing." });
        job.autoFree = act === "autofree-on";
        if (job.autoFree && job.status === "verified" && (job.verify?.matched ?? 0) > 0) void deleteVerified(job);
      } else if (act === "sync-on" || act === "sync-off") {
        job.keepSynced = act === "sync-on";
        job.nextSyncAt = job.keepSynced && ["verified", "kept", "done"].includes(job.status) ? Date.now() + 24 * 3600_000 : null;
      } else if (act === "sync-now") {
        if (["verified", "kept", "done"].includes(job.status)) { job.status = "queued"; job.stats = newStats(); }
      } else if (act === "keep") {
        if (job.status === "verified" || job.status === "incomplete") job.status = "kept";
      } else if (act === "remove") {
        if (running.has(job.id)) return res.status(400).json({ error: "Pause it first." });
        jobs = jobs.filter((j) => j !== job);
      } else return res.status(400).json({ error: "Unknown action" });
      saveNow();
      pump();
      res.json({ ok: true, job });
    });
  }

  return { register, findRclone, rc, emailOf, applyRate, jobs: () => jobs, invalidateSummary: () => { emailCache.clear(); } };
}
