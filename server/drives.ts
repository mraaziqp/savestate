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
import { readFile, writeFile, stat, unlink, readdir, rmdir, mkdir, rm } from "node:fs/promises";

export type DrivesDeps = {
  persistDir: string;
  log: (level: string, msg: string) => void;
  /** Called when an upload into the media library or ROM folders has been verified. */
  onUploaded?: (kind: OffloadKind) => void;
  /** No new jobs start while a game is running on the host. */
  gameModeActive?: () => boolean;
  /** Folders on this PC worth moving to Drive (ROM and music folders), with where each should go. */
  suggestions?: () => Promise<Array<{ label: string; source: string; kind: OffloadKind; dest: string }>>;
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
};

const EXCLUDES = ["desktop.ini", "Thumbs.db", ".DS_Store", "$RECYCLE.BIN/**", "System Volume Information/**", "*.partial", "*.!qB", "*.crdownload", "*.tmp"];
const excludeArgs = () => EXCLUDES.flatMap((e) => ["--exclude", e]);
const LOCAL_DRIVES = "CDEFGH".split("").map((d) => `${d}:`);
const isLocalFs = (fs_: string) => /^[A-Za-z]:$/.test(fs_);
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
      const proc = spawn(bin, ["rcd", `--rc-addr=127.0.0.1:${port}`, "--rc-user=nx", `--rc-pass=${pass}`, "--rc-job-expire-duration=6h",
        "--log-level=ERROR"], { windowsHide: true, stdio: "ignore" });
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
    const drives = remotes.filter((r) => (types[r]?.type ?? "drive") === "drive");
    return Promise.all(drives.map(async (name) => {
      const [about, email] = await Promise.all([rc("operations/about", { fs: `${name}:` }, 30_000).catch(() => null), emailOf(name)]);
      return { name, email, total: about?.total ?? null, used: about?.used ?? null, free: about?.free ?? null, trashed: about?.trashed ?? null };
    }));
  }

  // ── Jobs: persistence ─────────────────────────────────────────────────
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeFile(jobsFile, JSON.stringify(jobs, null, 1)).catch(() => {});
    }, 1000);
  };
  const saveNow = () => writeFile(jobsFile, JSON.stringify(jobs, null, 1)).catch(() => {});
  const newStats = (): OffloadJob["stats"] => ({ bytes: 0, totalBytes: 0, transfers: 0, totalTransfers: 0, checks: 0, totalChecks: 0, errors: 0, speed: 0, eta: null, current: [] });

  // ── Jobs: running ─────────────────────────────────────────────────────
  // One upload at a time: they share the host's uplink, and one at full
  // speed finishes everything sooner than several fighting.
  function pump() {
    if ([...jobs].some((j) => j.status === "copying" || j.status === "verifying" || j.status === "deleting")) return;
    if (deps.gameModeActive?.()) return;
    const next = jobs.find((j) => j.status === "queued");
    if (next) void runCopy(next);
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
  function desiredRate(): string {
    if (deps.gameModeActive?.()) return process.env.NEXUS_UPLOAD_BWLIMIT_GAMING?.trim() || "64k";
    const [from, to] = (process.env.NEXUS_UPLOAD_FULL_HOURS?.trim() || "1-7").split("-").map(Number);
    const h = new Date().getHours();
    const full = from <= to ? h >= from && h < to : h >= from || h < to;
    return full ? "off" : process.env.NEXUS_UPLOAD_BWLIMIT?.trim() || "650k";
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
      job.stats = {
        bytes: Number(s.bytes) || 0, totalBytes: Number(s.totalBytes) || 0,
        transfers: Number(s.transfers) || 0, totalTransfers: Number(s.totalTransfers) || 0,
        checks: Number(s.checks) || 0, totalChecks: Number(s.totalChecks) || 0,
        errors: Number(s.errors) || 0, speed: Number(s.speed) || 0, eta: s.eta == null ? null : Number(s.eta),
        current: Array.isArray(s.transferring) ? s.transferring.slice(0, 4).map((t: any) => `${t.name} ${Math.round(t.percentage ?? 0)}%`) : [],
      };
      save();
    } else if (entry?.level === "error" && entry?.msg) {
      job.lastError = String(entry.msg).slice(0, 300);
      save();
    }
  }

  async function runCopy(job: OffloadJob) {
    const bin = await findRclone();
    if (!bin) { job.status = "failed"; job.lastError = "rclone is not installed on the host"; return saveNow(); }
    if (!existsSync(job.source)) { job.status = "failed"; job.lastError = `The folder ${job.source} is not there any more`; return saveNow(); }
    job.status = "copying";
    job.startedAt ??= Date.now();
    job.lastError = null;
    saveNow();
    deps.log("INFO", `Upload ${job.id}: ${job.source} -> ${job.remote}:${job.dest}`);
    const rcPort = 6100 + Math.floor(Math.random() * 800);
    const rcPass = crypto.randomBytes(12).toString("hex");
    const rate = desiredRate();
    jobRc.set(job.id, { url: `http://127.0.0.1:${rcPort}`, auth: "Basic " + Buffer.from(`nx:${rcPass}`).toString("base64"), rate });
    const args = ["copy", job.source, `${job.remote}:${job.dest}`, `--bwlimit=${rate}`, "--rc", `--rc-addr=127.0.0.1:${rcPort}`, "--rc-user=nx", `--rc-pass=${rcPass}`,
      "--transfers=4", "--checkers=8", "--drive-chunk-size=64M",
      "--retries=10", "--low-level-retries=20", "--use-json-log", "--log-level=NOTICE", "--stats=4s", "--stats-log-level=NOTICE",
      ...excludeArgs()];
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
      if (code === 0) { void runVerify(job); return; }
      job.status = "failed";
      job.lastError = job.lastError ?? `rclone stopped with code ${code}`;
      saveNow();
      deps.log("WARN", `Upload ${job.id} failed: ${job.lastError}`);
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
      "--use-json-log", "--log-level=ERROR", ...excludeArgs()], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
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
      job.finishedAt = Date.now();
      saveNow();
      deps.log("INFO", `Upload ${job.id} checked: ${v.matched} file(s) confirmed on Drive${v.missing + v.differ + v.errors ? `, ${v.missing + v.differ + v.errors} problem(s)` : ""}`);
      if (job.status === "verified") deps.onUploaded?.(job.kind);
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
  }

  // Jobs interrupted by a restart pick up where they were.
  void (async () => {
    try { jobs = JSON.parse(await readFile(jobsFile, "utf8")); } catch { jobs = []; }
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

    app.get("/api/admin/drives/list", async (req, res) => {
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

    app.post("/api/admin/drives/mkdir", async (req, res) => {
      try { await rc("operations/mkdir", { fs: fsSpec(String(req.body?.fs)), remote: cleanRel(req.body?.path) }); res.json({ ok: true }); }
      catch (e) { fail(res, e); }
    });

    app.post("/api/admin/drives/delete", async (req, res) => {
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

    app.post("/api/admin/drives/rename", async (req, res) => {
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
    app.post("/api/admin/drives/transfer", async (req, res) => {
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
        transfers.unshift({ id: out.jobid, label: `${move ? "Move" : "Copy"} ${path.posix.basename(src) || src} to ${to}${dst ? `:${dst}` : ""}`, startedAt: Date.now() });
        transfers.splice(20);
        res.json({ ok: true, jobid: out.jobid });
      } catch (e) { fail(res, e); }
    });
    const transfers: Array<{ id: number; label: string; startedAt: number }> = [];
    app.get("/api/admin/drives/transfers", async (_req, res) => {
      const out = await Promise.all(transfers.map(async (t) => {
        const [st, stats] = await Promise.all([
          rc("job/status", { jobid: t.id }, 10_000).catch(() => null),
          rc("core/stats", { group: `job/${t.id}` }, 10_000).catch(() => null),
        ]);
        return { ...t, finished: st?.finished ?? true, success: st?.success ?? false, error: st?.error || null,
          bytes: stats?.bytes ?? 0, totalBytes: stats?.totalBytes ?? 0, speed: stats?.speed ?? 0 };
      }));
      res.json({ transfers: out });
    });

    app.get("/api/admin/drives/download", async (req, res) => {
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

    // Browser uploads: 8 MB chunks (under Cloudflare's request limit) into a
    // temp file, then one move onto Drive.
    const uploads = new Map<string, { file: string; fs: string; dest: string; size: number; got: number }>();
    app.post("/api/admin/drives/upload/init", async (req, res) => {
      try {
        const fs_ = String(req.body?.fs);
        if (isLocalFs(fs_)) return res.status(400).json({ error: "Uploads go to a Google Drive." });
        const name = String(req.body?.name ?? "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
        if (!name) return res.status(400).json({ error: "No file name" });
        await mkdir(uploadDir, { recursive: true });
        const id = crypto.randomBytes(12).toString("hex");
        uploads.set(id, { file: path.join(uploadDir, id), fs: fs_, dest: joinRemote(cleanRel(req.body?.path), name), size: Number(req.body?.size) || 0, got: 0 });
        res.json({ id });
      } catch (e) { fail(res, e); }
    });
    app.put("/api/admin/drives/upload/:id", (req, res) => {
      const u = uploads.get(req.params.id);
      if (!u) return res.status(404).json({ error: "Upload not found; start again." });
      const out = createWriteStream(u.file, { flags: "a" });
      req.pipe(out);
      out.on("finish", async () => { u.got = (await stat(u.file).catch(() => null))?.size ?? u.got; res.json({ ok: true, received: u.got }); });
      out.on("error", (e) => fail(res, e));
    });
    app.post("/api/admin/drives/upload/:id/complete", async (req, res) => {
      const u = uploads.get(req.params.id);
      if (!u) return res.status(404).json({ error: "Upload not found; start again." });
      try {
        await rc("operations/movefile", { srcFs: `${uploadDir}${path.sep}`, srcRemote: path.basename(u.file), dstFs: fsSpec(u.fs), dstRemote: u.dest }, 6 * 3600_000);
        uploads.delete(req.params.id);
        res.json({ ok: true });
      } catch (e) { await rm(u.file, { force: true }).catch(() => {}); uploads.delete(req.params.id); fail(res, e); }
    });

    // ── Upload & verify jobs ─────────────────────────────────────────────
    app.get("/api/admin/offload", (_req, res) => { res.json({ jobs, gameMode: !!deps.gameModeActive?.(), speedLimit: desiredRate() }); });

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
        if (!remotes.includes(remote)) return res.status(400).json({ error: "Unknown Drive account." });
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

  return { register, findRclone, jobs: () => jobs };
}
