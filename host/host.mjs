#!/usr/bin/env node
// SaveState Host for Windows: everything a host needs, with nothing else to
// install (no Docker, no database setup). It runs SaveState's own private
// PostgreSQL (official binaries from the embedded-postgres package, kept in
// <data>/pg and reachable only from this PC), then the SaveState server, and
// restarts the server if it stops. scripts/install-host.ps1 sets it up.
//
//   node host.mjs              start (the installer's scheduled task does this)
//   node host.mjs --stop       stop a running host
//
// Settings live in <data>/host.json (the installer writes the folders and
// port; secrets are made here on first start and never leave this PC).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const home = path.dirname(appDir); // <install>/app -> <install>
const dataDir = process.env.SAVESTATE_HOST_DATA || path.join(home, "data");
const cfgFile = path.join(dataDir, "host.json");
const logDir = path.join(dataDir, "logs");
const pidFile = path.join(dataDir, "host.pid");
// Windows has no polite "please stop" signal between processes, so --stop
// leaves this file and the running host shuts down cleanly when it sees it.
const stopFile = path.join(dataDir, "stop.request");
fs.mkdirSync(logDir, { recursive: true });

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const hostLog = fs.createWriteStream(path.join(logDir, "host.log"), { flags: "a" });
const say = (m) => { hostLog.write(`${stamp()}  ${m}\n`); if (process.stdout.isTTY) console.log(m); };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runningPid = () => { try { const p = Number(fs.readFileSync(pidFile, "utf8")); return p && p !== process.pid && alive(p) ? p : 0; } catch { return 0; } };

if (process.argv.includes("--stop")) {
  const p = runningPid();
  if (!p) { console.log("SaveState Host isn't running."); process.exit(0); }
  fs.writeFileSync(stopFile, String(Date.now()));
  for (let i = 0; i < 40 && alive(p); i++) await new Promise((r) => setTimeout(r, 500));
  if (alive(p)) { try { process.kill(p); } catch { /* gone */ } }
  console.log("SaveState Host stopped.");
  process.exit(0);
}
fs.rmSync(stopFile, { force: true });
if (runningPid()) { say("already running; not starting a second copy"); process.exit(0); }
fs.writeFileSync(pidFile, String(process.pid));

// Settings, with secrets made once.
// (PowerShell writes a byte-order mark first, which JSON.parse refuses: the
// port and folders the installer chose were being ignored.)
const cfg = (() => { try { return JSON.parse(fs.readFileSync(cfgFile, "utf8").replace(/^\uFEFF/, "")); } catch { return {}; } })();
let changed = false;
const need = (k, make) => { if (!cfg[k]) { cfg[k] = make(); changed = true; } };
need("jwtSecret", () => crypto.randomBytes(48).toString("base64url"));
need("dbPassword", () => crypto.randomBytes(24).toString("base64url"));
need("port", () => 3000);

const freePort = (start) => new Promise((resolve) => {
  const tryPort = (p) => {
    const s = net.createServer().once("error", () => tryPort(p + 1)).once("listening", () => s.close(() => resolve(p)));
    s.listen(p, "127.0.0.1");
  };
  tryPort(start);
});
if (!cfg.dbPort) { cfg.dbPort = await freePort(5433); changed = true; }
if (changed) fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

// 1. The database.
const pgDir = path.join(dataDir, "pg");
// Loaded only when starting: importing it also hooks the process exit, which
// printed a warning on every "--stop".
const { default: EmbeddedPostgres } = await import("embedded-postgres");
const db = new EmbeddedPostgres({
  databaseDir: pgDir, user: "savestate", password: cfg.dbPassword, port: cfg.dbPort, persistent: true,
  // UTF-8 whatever Windows' own language is (it defaulted to WIN1252, and the
  // server's setup failed on its first non-English character).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  // Small and quiet: a home host, not a data centre.
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "shared_buffers=128MB", "-c", "max_connections=40", "-c", "log_min_messages=warning"],
  onLog: () => {}, onError: (e) => say(`database: ${String(e).trim().slice(0, 300)}`),
});
// A database left running by a host that was killed holds its port and
// folder; it is stopped first (its process id is the first line of postmaster.pid).
try {
  const old = Number(fs.readFileSync(path.join(pgDir, "postmaster.pid"), "utf8").split(/\r?\n/)[0]);
  if (old && alive(old)) { say(`stopping a database left running (pid ${old})`); spawn("taskkill", ["/PID", String(old), "/T", "/F"], { windowsHide: true }); await new Promise((r) => setTimeout(r, 3000)); }
} catch { /* none */ }
try {
  if (!fs.existsSync(path.join(pgDir, "PG_VERSION"))) { say("setting up the database (first start only)"); await db.initialise(); }
  await db.start();
  await db.createDatabase("savestate").catch(() => { /* already there */ });
  say(`database ready on 127.0.0.1:${cfg.dbPort}`);
} catch (e) {
  say(`the database could not start: ${e?.message ?? e}`);
  fs.rmSync(pidFile, { force: true });
  process.exit(1);
}

// 2. The server, restarted if it stops (waiting longer each time it falls over quickly).
const env = {
  // Only what SaveState needs; nothing of the PC's own environment leaks in
  // beyond the basics Windows programs expect.
  SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP,
  PATH: [path.join(home, "ffmpeg"), path.dirname(process.execPath), process.env.SystemRoot && path.join(process.env.SystemRoot, "System32")].filter(Boolean).join(path.delimiter),
  USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH,
  NODE_ENV: "production",
  PORT: String(cfg.port),
  DATABASE_URL: `postgres://savestate:${encodeURIComponent(cfg.dbPassword)}@127.0.0.1:${cfg.dbPort}/savestate?sslmode=disable`,
  NEXUS_DB_SSL: "0",
  JWT_SECRET: cfg.jwtSecret,
  NEXUS_DATA_DIR: path.join(dataDir, "app"),
  NEXUS_PUBLIC_URL: cfg.publicUrl || `http://localhost:${cfg.port}`,
  NEXUS_CLOUD_FIRST: "0",
  NEXUS_STREAM_ONLY: "0",
  ...(cfg.mediaDir ? { NEXUS_MEDIA_ROOT: cfg.mediaDir } : {}),
  ...(cfg.musicDir ? { NEXUS_MUSIC_ROOTS: cfg.musicDir } : {}),
  ...(cfg.gamesDir ? { VAULT_ROOT: cfg.gamesDir } : {}),
  ...(fs.existsSync(path.join(home, "ffmpeg", "ffmpeg.exe")) ? { NEXUS_FFMPEG_PATH: path.join(home, "ffmpeg", "ffmpeg.exe"), FFPROBE_PATH: path.join(home, "ffmpeg", "ffprobe.exe") } : {}),
};
fs.mkdirSync(env.NEXUS_DATA_DIR, { recursive: true });

let server = null, stopping = false, backoff = 0, startedAt = 0;
const startServer = () => {
  const out = fs.openSync(path.join(logDir, "server.log"), "a");
  startedAt = Date.now();
  server = spawn(process.execPath, ["--max-old-space-size=1024", "dist/server.mjs"], { cwd: appDir, env, stdio: ["ignore", out, out], windowsHide: true });
  say(`server started (pid ${server.pid}) on port ${cfg.port}`);
  server.once("exit", (code) => {
    fs.closeSync(out);
    server = null;
    if (stopping) return;
    // Up for 10 minutes: a fresh start. Otherwise wait 2, 4, 8 ... up to 60 s.
    backoff = Date.now() - startedAt > 10 * 60_000 ? 0 : Math.min(60, backoff * 2 || 2);
    say(`server stopped (code ${code}); starting again in ${backoff} s`);
    setTimeout(startServer, backoff * 1000);
  });
};
startServer();

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  say("stopping");
  if (server) { server.kill(); await new Promise((r) => { const t = setTimeout(r, 10_000); server?.once("exit", () => { clearTimeout(t); r(); }); }); }
  await db.stop().catch(() => {});
  fs.rmSync(pidFile, { force: true });
  say("stopped");
  process.exit(0);
};
setInterval(() => { if (fs.existsSync(stopFile)) { fs.rmSync(stopFile, { force: true }); void shutdown(); } }, 1500);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGBREAK", shutdown);
