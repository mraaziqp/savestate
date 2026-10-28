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
//   - (2026-10-28, "genuinely shut all services so I can game") Sonarr,
//     Radarr and Prowlarr are shut down through their own API (closed if
//     they don't go), qBittorrent itself is closed after its torrents stop,
//     and the public site moves to the NAS while it's up (server/serving.ts),
//     so this PC serves, streams and converts nothing for visitors. Resume
//     starts exactly those apps again and brings the site back.
// Watching and playing are not touched. The state is kept on disk, so a
// restart while paused stays paused.
import type express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { addLiveSource } from "./receipts.ts";

type Qbt = { host: string; cookie: string };
type State = { paused: boolean; since: number | null; torrents: string[]; model: "stopped" | null;
  /** Apps closed by the pause (their programs, to start again), and whether the site moved to the NAS. */
  apps?: Array<{ name: string; exe: string; args: string[] }>; site?: "nas" | null };
const OFF: State = { paused: false, since: null, torrents: [], model: null, apps: [], site: null };

export function createPauseAll(deps: {
  persistDir: string;
  isAdmin: (req: express.Request) => Promise<boolean>;
  qbt: () => Promise<Qbt | null>;
  ollamaUrl: string;
  /** The Agent Builder's folder, for its hold file (data/host-holds.json); null when it is not on this PC. */
  agentBuilderDir: string | null;
  /** Called after every change (uploads stop at once rather than at their next turn). */
  changed: (paused: boolean) => void;
  /** Moves savestate.co.za to the NAS or back (server/serving.ts); null where there's no NAS. */
  moveSite?: ((to: "pc" | "nas", auth: string) => Promise<unknown>) | null;
  /** Whether the NAS is up and able to take the site. */
  nasUp?: () => Promise<boolean>;
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
      env: { ...(await cleanEnv()), OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_NUM_CTX || "16384", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_MAX_LOADED_MODELS: "1" },
    });
    child.unref();
  }

  // ── Apps on this PC (Windows) ────────────────────────────────────────
  const ps = (cmd: string, timeout = 30_000) => new Promise<string>((resolve) =>
    execFile("powershell", ["-NoProfile", "-Command", cmd], { windowsHide: true, timeout }, (_e, out) => resolve(String(out ?? "").trim())));
  /** Running program path of a process name, or null. */
  const exeOf = async (name: string) => (await ps(`(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`)) || null;
  const running = async (name: string) => (await ps(`@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue).Count`)) !== "0";
  // Sonarr, Radarr, Prowlarr: their API key and port are in their config.xml.
  const ARR = [{ name: "Sonarr", api: "v3" }, { name: "Radarr", api: "v3" }, { name: "Prowlarr", api: "v1" }];
  async function arrShutdown(name: string, api: string) {
    const xml = await readFile(path.join(process.env.ProgramData || "C:\\ProgramData", name, "config.xml"), "utf8").catch(() => "");
    const key = /<ApiKey>([^<]+)<\/ApiKey>/.exec(xml)?.[1], port = /<Port>(\d+)<\/Port>/.exec(xml)?.[1];
    if (key && port) await fetch(`http://127.0.0.1:${port}/api/${api}/system/shutdown`, { method: "POST", headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  }
  async function closeApps(): Promise<string[]> {
    if (process.platform !== "win32") return [];
    const closed: string[] = [];
    const apps: NonNullable<State["apps"]> = [];
    for (const a of ARR) {
      const exe = await exeOf(a.name);
      if (!exe) continue;
      await arrShutdown(a.name, a.api);
      for (let i = 0; i < 10 && (await running(a.name)); i++) await new Promise((r) => setTimeout(r, 2000));
      if (await running(a.name)) await ps(`Stop-Process -Name '${a.name}' -Force -ErrorAction SilentlyContinue`);
      apps.push({ name: a.name, exe, args: ["/nobrowser"] });
      closed.push(a.name);
    }
    // qBittorrent last: its torrents are already stopped and remembered.
    const qexe = await exeOf("qbittorrent");
    if (qexe) {
      const q = await deps.qbt().catch(() => null);
      if (q) await fetch(`${q.host}/api/v2/app/shutdown`, { method: "POST", headers: q.cookie ? { Cookie: q.cookie } : {}, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      for (let i = 0; i < 15 && (await running("qbittorrent")); i++) await new Promise((r) => setTimeout(r, 2000));
      if (await running("qbittorrent")) await ps("Stop-Process -Name 'qbittorrent' -ErrorAction SilentlyContinue");
      apps.push({ name: "qBittorrent", exe: qexe, args: [] });
      closed.push("qBittorrent");
    }
    state.apps = apps;
    return closed;
  }
  // The apps start without SaveState's own settings. Started with this
  // server's environment, Sonarr took its PORT=3000 and listened on 3000
  // beside SaveState, and the public site answered with Sonarr's login
  // (2026-10-28). Nothing from .env (keys, secrets) goes to them either.
  async function cleanEnv() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const dotenv = await readFile(path.join(process.cwd(), ".env"), "utf8").catch(() => "");
    for (const line of dotenv.split(/\r?\n/)) { const k = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]; if (k) delete env[k]; }
    for (const k of Object.keys(env)) if (/^(PORT|HOST|URLS|HTTPS?_PORTS|ASPNETCORE_.*|DOTNET_URLS|NODE_.*|NEXUS_.*|UV_THREADPOOL_SIZE)$/i.test(k)) delete env[k];
    return env;
  }
  async function openApps() {
    const env = await cleanEnv();
    for (const a of state.apps ?? []) {
      if (await running(path.basename(a.exe, ".exe"))) continue;
      try { spawn(a.exe, a.args, { cwd: path.dirname(a.exe), detached: true, windowsHide: false, stdio: "ignore", env }).unref(); }
      catch (e: any) { deps.log("WARN", `Resume: couldn't start ${a.name}: ${e?.message ?? e}`); }
    }
    // The torrents are started once qBittorrent answers again.
    if ((state.apps ?? []).some((a) => a.name === "qBittorrent")) {
      for (let i = 0; i < 30; i++) { if (await deps.qbt().catch(() => null)) break; await new Promise((r) => setTimeout(r, 2000)); }
    }
  }

  async function pause(auth = "") {
    if (state.paused) return [];
    state = { ...OFF, paused: true, since: Date.now(), torrents: [] };
    deps.changed(true);
    const stopped = ["uploads", "conversions", "scans and artwork"];
    const n = await stopTorrents();
    if (n) stopped.push(`${n} torrent(s)`);
    const m = await modelOff();
    if (m) stopped.push(m);
    stopped.push(...(await closeApps()));
    await save();
    // The site moves to the NAS in the background (about a minute).
    if (deps.moveSite && auth && (await deps.nasUp?.().catch(() => false))) {
      stopped.push("the public site (moving to the NAS)");
      void deps.moveSite("nas", auth).then(() => { if (state.paused) { state.site = "nas"; void save(); } })
        .catch((e) => deps.log("WARN", `Pause all: the site stays on this PC: ${e?.message ?? e}`));
    }
    deps.log("INFO", `Paused all: ${stopped.join(", ")}`);
    return stopped;
  }
  async function resume(auth = "") {
    if (!state.paused) return;
    state.paused = false;
    deps.changed(false);
    await openApps();
    await startTorrents();
    const wasModel = state.model === "stopped";
    const apps = (state.apps ?? []).map((a) => a.name);
    deps.log("INFO", `Resumed after ${Math.round((Date.now() - (state.since ?? Date.now())) / 60_000)} min: ${state.torrents.length} torrent(s)${apps.length ? `, ${apps.join(", ")}` : ""}${wasModel ? " and the AI model server" : ""} started again`);
    if (wasModel) void modelOn().catch(() => {});
    if (state.site === "nas" && deps.moveSite && auth) void deps.moveSite("pc", auth).catch((e) => deps.log("WARN", `Resume: the site stays on the NAS: ${e?.message ?? e}`));
    state = { ...OFF };
    await save();
  }
  // Torrents the Arr apps add while paused are stopped too, and the model
  // server again if something starts it.
  setInterval(() => { if (state.paused) void stopTorrents().then((n) => { if (n) void save(); }); }, 60_000).unref?.();
  setInterval(() => { if (state.paused) void modelOff().then((m) => { if (m) void save(); }); }, 20_000).unref?.();

  // The Activity page shows the pause (and its Resume) while it lasts.
  addLiveSource(() => state.paused ? [{
    kind: "system", title: "Everything is paused", status: "paused", jobId: "pause-all", actions: ["resume"], progress: null,
    detail: `Since ${new Date(state.since ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: uploads, conversions, ${state.torrents.length} torrent(s)${(state.apps ?? []).length ? `, ${(state.apps ?? []).map((a) => a.name).join(", ")}` : ""}${state.model ? ", the AI model server" : ""}${state.site === "nas" ? "; the NAS serves the site" : ""}. Continue starts exactly these again.`,
  }] : []);

  function register(app: express.Express) {
    app.get("/api/admin/pause-all", async (req, res) => {
      if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Admins only." });
      res.json({ paused: state.paused, since: state.since, torrents: state.torrents.length, model: state.model, apps: (state.apps ?? []).map((a) => a.name), site: state.site ?? null });
    });
    app.post("/api/admin/pause-all", async (req, res) => {
      if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Admins only." });
      const want = req.body?.paused === true;
      const auth = String(req.headers.authorization || "");
      const stopped = want ? await pause(auth) : (await resume(auth), []);
      res.json({ paused: state.paused, since: state.since, torrents: state.torrents.length, model: state.model, apps: (state.apps ?? []).map((a) => a.name), site: state.site ?? null, stopped });
    });
  }
  return { register, active: () => state.paused };
}
