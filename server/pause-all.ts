// Pause all (admins): the PC back for its owner in one press. Stops what
// SaveState does in the background and remembers exactly what it stopped, so
// Resume starts that again and nothing else:
//   - Drive uploads (the copy running now stops; it carries on from where it
//     was) and conversions (video prep), through holdBackground();
//   - library scans, artwork, wanted-retries and the media warm-up, which ask
//     holdBackground() before they start;
//   - every active torrent in qBittorrent (new ones the Arr apps add while
//     paused are stopped too, and resumed with the rest);
//   - the AI model server (Ollama, 10-17 GB of memory): stopped the way the
//     Agent Builder's Host Manager stops it, with its "model-server" hold set
//     so the Agent Builder's launcher leaves it off; Resume lifts the hold and
//     starts it again. Letting go of the model alone wasn't enough: Jarvis
//     and the Agent Builder loaded it again within seconds. Not the Agent
//     Builder's own game mode: that also has its Host Manager stop SaveState
//     hosting, which would take the site down from its own button.
// Watching and playing are not touched. The state is kept on disk, so a
// restart while paused stays paused.
import type express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";

type Qbt = { host: string; cookie: string };
type State = { paused: boolean; since: number | null; torrents: string[]; model: "stopped" | null };
const OFF: State = { paused: false, since: null, torrents: [], model: null };

export function createPauseAll(deps: {
  persistDir: string;
  isAdmin: (req: express.Request) => Promise<boolean>;
  qbt: () => Promise<Qbt | null>;
  ollamaUrl: string;
  /** The Agent Builder's folder, for its hold file (data/host-holds.json); null when it is not on this PC. */
  agentBuilderDir: string | null;
  /** Called after every change (uploads stop at once rather than at their next turn). */
  changed: (paused: boolean) => void;
  log: (level: string, msg: string) => void;
}) {
  const file = path.join(deps.persistDir, "pause-all.json");
  let state: State = { ...OFF };
  readFile(file, "utf8").then((t) => { state = { ...state, ...JSON.parse(t) }; if (state.paused) deps.changed(true); }).catch(() => {});
  const save = () => writeFile(file, JSON.stringify(state)).catch(() => {});

  // qBittorrent 5 calls it stop/start, 4 pause/resume.
  async function qbtCall(q: Qbt, verbs: [string, string], hashes: string[]) {
    if (!hashes.length) return;
    for (const verb of verbs) {
      const r = await fetch(`${q.host}/api/v2/torrents/${verb}`, {
        method: "POST", headers: { Cookie: q.cookie, Referer: q.host, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ hashes: hashes.join("|") }), signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (r && r.status !== 404) return;
    }
  }
  const RUNNING = /^(downloading|uploading|stalledDL|stalledUP|queuedDL|queuedUP|forcedDL|forcedUP|checkingDL|checkingUP|metaDL|forcedMetaDL|checkingResumeData|moving)$/;
  async function stopTorrents(): Promise<number> {
    const q = await deps.qbt().catch(() => null);
    if (!q) return 0;
    const list = (await fetch(`${q.host}/api/v2/torrents/info`, { headers: { Cookie: q.cookie }, signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json()).catch(() => [])) as { hash: string; state: string }[];
    const fresh = list.filter((t) => RUNNING.test(t.state) && !state.torrents.includes(t.hash)).map((t) => t.hash);
    await qbtCall(q, ["stop", "pause"], fresh);
    state.torrents.push(...fresh);
    return fresh.length;
  }
  async function startTorrents() {
    const q = await deps.qbt().catch(() => null);
    if (q) await qbtCall(q, ["start", "resume"], state.torrents);
  }

  // ── The AI model server ───────────────────────────────────────────────
  const holdsFile = deps.agentBuilderDir ? path.join(deps.agentBuilderDir, "data", "host-holds.json") : null;
  async function setHold(on: boolean) {
    if (!holdsFile) return;
    const holds = await readFile(holdsFile, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
    if (on) holds["model-server"] = { since: new Date().toISOString(), by: "SaveState pause all" };
    else delete holds["model-server"];
    await writeFile(holdsFile, JSON.stringify(holds)).catch(() => {});
  }
  const ollamaUp = () => fetch(`${deps.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
  const killOllama = () => new Promise<void>((done) => {
    if (process.platform !== "win32") return done();
    // Every Ollama process (the server, its tray app) and the model runner.
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Where-Object { $_.Name -match '^(ollama|llama-server)' } | Stop-Process -Force -ErrorAction SilentlyContinue"],
      { windowsHide: true, timeout: 20_000 }, () => done());
  });
  async function modelOff(): Promise<string> {
    if (!(await ollamaUp())) return "";
    // Let go of the model first (a clean unload), then stop the server.
    const loaded = await fetch(`${deps.ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).then((j: any) => (j.models ?? []).map((m: any) => String(m.name))).catch(() => [] as string[]);
    for (const name of loaded) {
      await fetch(`${deps.ollamaUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(20_000) }).catch(() => null);
    }
    await setHold(true);
    await killOllama();
    state.model = "stopped";
    return "the AI model server";
  }
  async function modelOn() {
    await setHold(false);
    // The Agent Builder's launcher brings it back once the hold is gone; when
    // nothing does within 40 s, it is started here, set up as its Host Manager does.
    for (let i = 0; i < 8; i++) { if (await ollamaUp()) return; await new Promise((r) => setTimeout(r, 5000)); }
    const exe = [path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe"), "C:\\Program Files\\Ollama\\ollama.exe"].find((p) => existsSync(p));
    if (!exe) return;
    const child = spawn(exe, ["serve"], {
      cwd: path.dirname(exe), detached: true, windowsHide: true, stdio: "ignore",
      env: { ...process.env, OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_NUM_CTX || "16384", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_MAX_LOADED_MODELS: "1" },
    });
    child.unref();
  }

  async function pause() {
    if (state.paused) return [];
    state = { ...OFF, paused: true, since: Date.now(), torrents: [] };
    deps.changed(true);
    const stopped = ["uploads", "conversions", "scans and artwork"];
    const n = await stopTorrents();
    if (n) stopped.push(`${n} torrent(s)`);
    const m = await modelOff();
    if (m) stopped.push(m);
    await save();
    deps.log("INFO", `Paused all: ${stopped.join(", ")}`);
    return stopped;
  }
  async function resume() {
    if (!state.paused) return;
    state.paused = false;
    deps.changed(false);
    await startTorrents();
    const wasModel = state.model === "stopped";
    deps.log("INFO", `Resumed after ${Math.round((Date.now() - (state.since ?? Date.now())) / 60_000)} min: ${state.torrents.length} torrent(s)${wasModel ? " and the AI model server" : ""} started again`);
    if (wasModel) void modelOn().catch(() => {});
    state = { ...OFF };
    await save();
  }
  // Torrents the Arr apps add while paused are stopped too, and the model
  // server again if something starts it.
  setInterval(() => { if (state.paused) void stopTorrents().then((n) => { if (n) void save(); }); }, 60_000).unref?.();
  setInterval(() => { if (state.paused) void modelOff().then((m) => { if (m) void save(); }); }, 20_000).unref?.();

  function register(app: express.Express) {
    app.get("/api/admin/pause-all", async (req, res) => {
      if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Admins only." });
      res.json({ paused: state.paused, since: state.since, torrents: state.torrents.length, model: state.model });
    });
    app.post("/api/admin/pause-all", async (req, res) => {
      if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Admins only." });
      const want = req.body?.paused === true;
      const stopped = want ? await pause() : (await resume(), []);
      res.json({ paused: state.paused, since: state.since, torrents: state.torrents.length, model: state.model, stopped });
    });
  }
  return { register, active: () => state.paused };
}
