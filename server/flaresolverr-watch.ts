// FlareSolverr watchdog (Windows host). FlareSolverr solves the Cloudflare
// challenges for several indexers. One browser session that hangs (it did
// just after the PC restarted, 2026-11-16) holds every later request in its
// queue: searches waited 28-45 minutes ("Response in 2687 s"). Every 5
// minutes it is asked something that needs no browser (sessions.list); when
// two checks in a row get no answer, FlareSolverr and its Chrome are
// restarted. It is started the way Windows starts it at sign-in, without
// SaveState's own settings (a PORT=3000 from here would take SaveState's port).
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { readdir, stat, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { cleanEnv } from "./model-server.ts";

export function watchFlareSolverr(deps: {
  url?: string;
  /** Skip while everything is paused or a game runs (it is idle then anyway). */
  hold: () => boolean;
  log: (level: string, msg: string) => void;
}) {
  if (process.platform !== "win32") return;
  const url = (deps.url ?? process.env.NEXUS_FLARESOLVERR_URL ?? "http://127.0.0.1:8191").replace(/\/+$/, "");
  const exe = process.env.NEXUS_FLARESOLVERR_EXE ?? "C:\\ProgramData\\FlareSolverr\\flaresolverr\\flaresolverr.exe";
  let misses = 0;
  let restartingUntil = 0;

  const answers = () => fetch(`${url}/v1`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "sessions.list" }), signal: AbortSignal.timeout(30_000),
  }).then((r) => r.ok, () => false);

  const stopAll = () => new Promise<void>((done) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-Process flaresolverr -ErrorAction SilentlyContinue | Stop-Process -Force; Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*FlareSolverr*' } | Stop-Process -Force"],
    { windowsHide: true, timeout: 30_000 }, () => done()));

  async function check() {
    if (Date.now() < restartingUntil || deps.hold() || !existsSync(exe)) return;
    if (await answers()) { misses = 0; return; }
    if (++misses < 2) return;
    misses = 0;
    restartingUntil = Date.now() + 3 * 60_000;
    deps.log("WARN", "FlareSolverr stopped answering (searches on Cloudflare-protected sites would wait); restarting it");
    await stopAll();
    try {
      spawn(exe, [], { cwd: path.dirname(exe), detached: true, windowsHide: true, stdio: "ignore", env: await cleanEnv() }).unref();
    } catch (e: any) { deps.log("WARN", `FlareSolverr could not be started: ${e?.message ?? e}`); return; }
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      if (await answers()) { deps.log("INFO", "FlareSolverr is answering again"); return; }
    }
    deps.log("WARN", "FlareSolverr did not come back within 2 minutes; trying again next check");
  }

  setInterval(() => { void check().catch(() => {}); }, 5 * 60_000).unref?.();

  // Every challenge left a whole Chrome profile in %TEMP% ("tmpab12cd34",
  // 70-260 MB each): 560 of them filled C: to 0 MB (2026-11-16). With the
  // owner's go-ahead, FlareSolverr's own leftovers are removed once a day old:
  // only "tmp" + random name folders holding a Chrome profile (Default\).
  async function sweepProfiles() {
    const dir = os.tmpdir();
    const names = await readdir(dir).catch(() => [] as string[]);
    let removed = 0, bytes = 0;
    for (const name of names) {
      if (!/^tmp[a-z0-9_]{6,12}$/i.test(name)) continue;
      const full = path.join(dir, name);
      const st = await stat(full).catch(() => null);
      if (!st?.isDirectory() || Date.now() - st.mtimeMs < 24 * 3600_000) continue;
      if (!existsSync(path.join(full, "Default"))) continue;
      const size = await folderSize(full);
      try { await rm(full, { recursive: true, force: true }); removed++; bytes += size; } catch { /* in use: next time */ }
    }
    if (removed) deps.log("INFO", `Removed ${removed} of FlareSolverr's leftover browser profiles (${(bytes / 1e9).toFixed(1)} GB) from the temp folder`);
  }
  async function folderSize(p: string): Promise<number> {
    let total = 0;
    for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
      const f = path.join(p, e.name);
      total += e.isDirectory() ? await folderSize(f) : (await stat(f).catch(() => null))?.size ?? 0;
    }
    return total;
  }
  setTimeout(() => { void sweepProfiles().catch(() => {}); }, 10 * 60_000).unref?.();
  setInterval(() => { void sweepProfiles().catch(() => {}); }, 60 * 60_000).unref?.();
}
