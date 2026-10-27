// Pause all (admins): the PC back for its owner in one press. Stops what
// SaveState does in the background and remembers exactly what it stopped, so
// Resume starts that again and nothing else:
//   - Drive uploads (the copy running now stops; it carries on from where it
//     was) and conversions (video prep), through holdBackground();
//   - library scans, artwork, wanted-retries and the media warm-up, which ask
//     holdBackground() before they start;
//   - every active torrent in qBittorrent (new ones the Arr apps add while
//     paused are stopped too, and resumed with the rest);
//   - the AI model Ollama keeps loaded (10-17 GB of memory): let go, and let
//     go again every 15 s while paused, since Jarvis and the Agent Builder
//     load it again within seconds. Not the Agent Builder's own game mode:
//     that also has its Host Manager stop SaveState hosting, which would take
//     the site down from its own button.
// Watching and playing are not touched. The state is kept on disk, so a
// restart while paused stays paused.
import type express from "express";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

type Qbt = { host: string; cookie: string };
type State = { paused: boolean; since: number | null; torrents: string[]; model: "unloaded" | null; modelNames: string[] };

export function createPauseAll(deps: {
  persistDir: string;
  isAdmin: (req: express.Request) => Promise<boolean>;
  qbt: () => Promise<Qbt | null>;
  ollamaUrl: string;
  /** Called after every change (uploads stop at once rather than at their next turn). */
  changed: (paused: boolean) => void;
  log: (level: string, msg: string) => void;
}) {
  const file = path.join(deps.persistDir, "pause-all.json");
  let state: State = { paused: false, since: null, torrents: [], model: null, modelNames: [] };
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

  async function modelOff(): Promise<string> {
    const loaded = await fetch(`${deps.ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).then((j: any) => (j.models ?? []).map((m: any) => String(m.name))).catch(() => [] as string[]);
    for (const name of loaded) {
      await fetch(`${deps.ollamaUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(20_000) }).catch(() => null);
    }
    if (loaded.length) { state.model = "unloaded"; state.modelNames = [...new Set([...state.modelNames, ...loaded])]; }
    return loaded.length ? `the AI model (${loaded.join(", ")})` : "";
  }

  async function pause() {
    if (state.paused) return [];
    state = { paused: true, since: Date.now(), torrents: [], model: null, modelNames: [] };
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
    // The model needs nothing: Ollama loads it again when it is next asked.
    await startTorrents();
    deps.log("INFO", `Resumed after ${Math.round((Date.now() - (state.since ?? Date.now())) / 60_000)} min: ${state.torrents.length} torrent(s) started again`);
    state = { paused: false, since: null, torrents: [], model: null, modelNames: [] };
    await save();
  }
  // Torrents the Arr apps add while paused are stopped too.
  setInterval(() => { if (state.paused) void stopTorrents().then((n) => { if (n) void save(); }); }, 60_000).unref?.();
  // The model, again whenever something has loaded it.
  setInterval(() => { if (state.paused) void modelOff(); }, 15_000).unref?.();

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
