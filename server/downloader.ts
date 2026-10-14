/**
 * Downloader setup and health: Sonarr, Radarr, Prowlarr and qBittorrent.
 *
 * Downloads that "just sit there" are nearly always one of a few things: the
 * indexers are failing (Prowlarr benches a site that blocks it), Sonarr or
 * Radarr have no download client or no indexers, qBittorrent is unreachable,
 * or the library disk is full. This module asks each app and puts those
 * answers in one place, finds the apps on this PC (their config.xml holds the
 * port and API key), and can push Prowlarr's indexers to Sonarr and Radarr.
 *
 * Connection settings stay where they already live (arr-config.json and
 * qbt-config.json in server.ts); this only reads and fills them.
 */
import type express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Caller } from "./access.ts";

type ArrConfig = { radarrUrl: string; radarrApiKey: string; sonarrUrl: string; sonarrApiKey: string };
type QbtConfig = { host: string; username: string; password: string };

export type DownloaderDeps = {
  callerOf: (req: express.Request) => Promise<Caller>;
  loadArr: () => Promise<ArrConfig | null>;
  saveArr: (cfg: ArrConfig) => Promise<void>;
  loadQbt: () => Promise<QbtConfig | null>;
  qbtLogin: (cfg: QbtConfig) => Promise<string | null>;
  log: (level: string, msg: string) => void;
};

const APPS = {
  sonarr: { label: "Sonarr", port: 8989, api: "v3", download: "https://sonarr.tv/#downloads-windows", what: "Finds and downloads TV shows." },
  radarr: { label: "Radarr", port: 7878, api: "v3", download: "https://radarr.video/#downloads", what: "Finds and downloads films." },
  prowlarr: { label: "Prowlarr", port: 9696, api: "v1", download: "https://prowlarr.com/#downloads", what: "Keeps the list of torrent sites and shares it with Sonarr and Radarr." },
} as const;
type AppId = keyof typeof APPS;
/** Public sites worth having, by Prowlarr definition. Knaben searches many others at once. */
const RECOMMENDED_SITES = ["Knaben", "thepiratebay", "limetorrents", "uindex", "kickasstorrents-to", "yts", "eztv", "nyaasi"];

// Sonarr 4 sometimes sends the untranslated key instead of the message.
const HEALTH_KEYS: Array<[RegExp, string | null]> = [
  [/UpdateUiNotWritable/i, null],
  [/IndexerLongTermStatusUnavailable/i, "Some torrent sites have been failing for more than 6 hours."],
  [/IndexerStatus(Check)?(All)?Unavailable/i, "Some torrent sites are failing right now."],
  [/DownloadClientStatus/i, "The download client (qBittorrent) isn't answering."],
  [/RootFolder(Missing)?/i, "A library folder is missing."],
  [/ImportMechanism/i, "Completed download handling is off, so finished downloads aren't moved into the library."],
];
function plainHealth(message: string): string | null {
  for (const [re, text] of HEALTH_KEYS) if (re.test(message) && !/\s/.test(message.trim())) return text;
  return message;
}

const QBT = { label: "qBittorrent", download: "https://www.qbittorrent.org/download", what: "Does the downloading." };

/** Port, URL base and API key from an app's own config.xml on this PC. */
async function localApp(id: AppId): Promise<{ url: string; apiKey: string } | null> {
  const root = process.env.ProgramData ?? "C:\\ProgramData";
  const label = APPS[id].label;
  for (const file of [path.join(root, label, "config.xml"), path.join(process.env.APPDATA ?? "", label, "config.xml")]) {
    try {
      const xml = await readFile(file, "utf8");
      const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`, "i").exec(xml)?.[1]?.trim() ?? "";
      const apiKey = tag("ApiKey");
      if (!apiKey) continue;
      const ssl = /^true$/i.test(tag("EnableSsl"));
      const port = Number(ssl ? tag("SslPort") || tag("Port") : tag("Port")) || APPS[id].port;
      const base = tag("UrlBase").replace(/^\/?/, "/").replace(/\/$/, "");
      return { url: `${ssl ? "https" : "http"}://127.0.0.1:${port}${base === "/" ? "" : base}`, apiKey };
    } catch { /* not here */ }
  }
  return null;
}

async function arrGet(url: string, key: string, api: string, p: string, ms = 8000): Promise<any> {
  const r = await fetch(`${url.replace(/\/$/, "")}/api/${api}/${p}`, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(ms) });
  if (r.status === 401) throw new Error("The API key was refused");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

type Problem = { level: "bad" | "warn"; text: string; fix?: string };

async function arrHealth(id: "sonarr" | "radarr", url: string, key: string) {
  const out: any = { id, ...APPS[id], url, configured: !!(url && key), connected: false, problems: [] as Problem[] };
  if (!out.configured) {
    out.problems.push({ level: "bad", text: `${APPS[id].label} isn't connected to SaveState yet.`, fix: "Press \"Find on this PC\", or enter its address and API key." });
    return out;
  }
  try {
    const [status, health, indexers, clients, roots, queue] = await Promise.all([
      arrGet(url, key, "v3", "system/status"),
      arrGet(url, key, "v3", "health").catch(() => []),
      arrGet(url, key, "v3", "indexer").catch(() => []),
      arrGet(url, key, "v3", "downloadclient").catch(() => []),
      arrGet(url, key, "v3", "rootfolder").catch(() => []),
      arrGet(url, key, "v3", "queue?pageSize=200&includeUnknownMovieItems=true&includeUnknownSeriesItems=true").catch(() => null),
    ]);
    out.connected = true;
    out.version = status?.version ?? null;
    out.indexers = (indexers as any[]).filter((i) => i.enableAutomaticSearch || i.enableRss).length;
    out.downloadClients = (clients as any[]).filter((c) => c.enable).length;
    out.rootFolders = (roots as any[]).map((r) => ({ path: r.path, freeGb: r.freeSpace != null ? Math.round(r.freeSpace / 1024 ** 3) : null, ok: r.accessible !== false }));
    const items: any[] = queue?.records ?? [];
    out.queue = { total: queue?.totalRecords ?? items.length, stuck: items.filter((q) => q.trackedDownloadState === "importBlocked" || q.trackedDownloadStatus === "warning" || q.status === "warning").length };
    if (!out.indexers) out.problems.push({ level: "bad", text: "No torrent sites (indexers), so searches find nothing.", fix: "In Prowlarr add indexers, then press \"Send indexers to Sonarr and Radarr\"." });
    if (!out.downloadClients) out.problems.push({ level: "bad", text: "No download client, so nothing it finds can download.", fix: `In ${APPS[id].label}: Settings > Download Clients > + > qBittorrent (host 127.0.0.1, port 8080).` });
    for (const r of out.rootFolders) {
      if (!r.ok) out.problems.push({ level: "bad", text: `${APPS[id].label} can't reach its library folder ${r.path}.` });
      else if (r.freeGb != null && r.freeGb < 20) out.problems.push({ level: r.freeGb < 5 ? "bad" : "warn", text: `Only ${r.freeGb} GB free on ${r.path}.`, fix: "Free some space (Cloud Drives > Upload & verify) or add a root folder on a bigger disk." });
    }
    if (out.queue.stuck) out.problems.push({ level: "warn", text: `${out.queue.stuck} download(s) need attention in ${APPS[id].label}'s queue (import blocked or warning).`, fix: `Open ${APPS[id].label} > Activity > Queue.` });
    for (const h of health as any[]) {
      if (h.type === "notice") continue;
      // Already said above in plainer words.
      if (/no indexers available|no download client/i.test(h.message ?? "")) continue;
      const text = plainHealth(String(h.message ?? h.source ?? ""));
      if (text && !out.problems.some((p: Problem) => p.text === text)) out.problems.push({ level: h.type === "error" ? "bad" : "warn", text: text.slice(0, 300), fix: /torrent sites|indexers/i.test(text) ? "See Prowlarr: \"Retry failing sites\" or \"Add more sites\"." : undefined });
    }
  } catch (e: any) {
    out.problems.push({ level: "bad", text: `Can't reach ${APPS[id].label} at ${url}: ${e?.message ?? e}.`, fix: `Start ${APPS[id].label} on the host PC (it should start with Windows).` });
  }
  return out;
}

async function prowlarrHealth() {
  const local = await localApp("prowlarr");
  const out: any = { id: "prowlarr", ...APPS.prowlarr, url: local?.url ?? `http://127.0.0.1:${APPS.prowlarr.port}`, configured: !!local, connected: false, problems: [] as Problem[] };
  if (!local) {
    out.problems.push({ level: "warn", text: "Prowlarr isn't installed on this PC (or its settings could not be read).", fix: "Install it (button below); it saves adding every torrent site to Sonarr and Radarr by hand." });
    return out;
  }
  try {
    const [status, indexers, statuses, apps, health] = await Promise.all([
      arrGet(local.url, local.apiKey, "v1", "system/status"),
      arrGet(local.url, local.apiKey, "v1", "indexer").catch(() => []),
      arrGet(local.url, local.apiKey, "v1", "indexerstatus").catch(() => []),
      arrGet(local.url, local.apiKey, "v1", "applications").catch(() => []),
      arrGet(local.url, local.apiKey, "v1", "health").catch(() => []),
    ]);
    out.connected = true;
    out.version = status?.version ?? null;
    const now = Date.now();
    const benched = new Map((statuses as any[]).filter((s) => s.disabledTill && new Date(s.disabledTill).getTime() > now).map((s) => [s.indexerId, s.disabledTill]));
    out.indexerList = (indexers as any[]).map((i) => ({ name: i.name, enabled: !!i.enable, benchedUntil: benched.get(i.id) ?? null }));
    out.indexers = out.indexerList.filter((i: any) => i.enabled && !i.benchedUntil).length;
    out.apps = (apps as any[]).map((a) => a.name);
    if (out.indexers < 5) out.problems.push({ level: "warn", text: `Only ${out.indexers} working site${out.indexers === 1 ? "" : "s"}: with more, a search still finds seeded copies when one site is down.`, fix: "Press \"Add more sites\"." });
    if (!out.indexerList.length) out.problems.push({ level: "bad", text: "Prowlarr has no torrent sites.", fix: "Prowlarr > Indexers > Add Indexer: add a few public ones (e.g. 1337x, The Pirate Bay, YTS, EZTV, Nyaa)." });
    else if (!out.indexers) out.problems.push({ level: "bad", text: "Every torrent site in Prowlarr is failing or switched off, so nothing can be found.", fix: "They usually recover on their own within hours; adding one or two more sites avoids the gap." });
    for (const i of out.indexerList.filter((x: any) => x.benchedUntil)) {
      out.problems.push({ level: "warn", text: `${i.name} is failing; Prowlarr retries it after ${new Date(i.benchedUntil).toLocaleTimeString()}.` });
    }
    if (!out.apps.length) out.problems.push({ level: "bad", text: "Prowlarr isn't linked to Sonarr or Radarr, so they never see its sites.", fix: "Prowlarr > Settings > Apps > + Sonarr and + Radarr (API keys from each app's Settings > General)." });
    for (const h of health as any[]) {
      if (h.type === "notice" || /indexers (are )?unavailable due to failures/i.test(h.message ?? "")) continue;
      const text = plainHealth(String(h.message ?? ""));
      if (text) out.problems.push({ level: h.type === "error" ? "bad" : "warn", text: text.slice(0, 300) });
    }
  } catch (e: any) {
    out.problems.push({ level: "bad", text: `Can't reach Prowlarr at ${out.url}: ${e?.message ?? e}.`, fix: "Start Prowlarr on the host PC." });
  }
  return out;
}

export function createDownloader(deps: DownloaderDeps) {
  async function qbtHealth() {
    const cfg = await deps.loadQbt();
    const out: any = { id: "qbittorrent", ...QBT, url: cfg?.host ?? "", configured: !!cfg, connected: false, problems: [] as Problem[] };
    if (!cfg) {
      out.problems.push({ level: "bad", text: "qBittorrent isn't connected to SaveState yet.", fix: "In qBittorrent: Tools > Options > Web UI > tick \"Web User Interface\", then enter its address (http://127.0.0.1:8080) and login here." });
      return out;
    }
    const cookie = await deps.qbtLogin(cfg).catch(() => null);
    if (cookie === null) {
      out.problems.push({ level: "bad", text: `Can't sign in to qBittorrent at ${cfg.host}.`, fix: "Check qBittorrent is running with its Web UI on, and the username and password here." });
      return out;
    }
    out.connected = true;
    const headers = cookie ? { Cookie: cookie } : {};
    try {
      const [version, torrents, transfer] = await Promise.all([
        fetch(`${cfg.host}/api/v2/app/version`, { headers, signal: AbortSignal.timeout(6000) }).then((r) => r.text()),
        fetch(`${cfg.host}/api/v2/torrents/info?filter=downloading`, { headers, signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
        fetch(`${cfg.host}/api/v2/transfer/info`, { headers, signal: AbortSignal.timeout(6000) }).then((r) => r.json()),
      ]);
      out.version = String(version).trim();
      const list = torrents as any[];
      out.downloading = list.length;
      out.stalled = list.filter((t) => t.state === "stalledDL" || t.state === "metaDL").length;
      out.speedKBs = Math.round((transfer?.dl_info_speed ?? 0) / 1024);
      out.connection = transfer?.connection_status ?? null;
      if (out.connection === "disconnected") out.problems.push({ level: "bad", text: "qBittorrent reports no internet connection." });
      else if (out.connection === "firewalled") out.problems.push({ level: "warn", text: "qBittorrent is firewalled, so fewer people can connect to it and downloads are slower.", fix: "qBittorrent > Options > Connection: tick \"Use UPnP / NAT-PMP port forwarding\", or forward its port on the router." });
      if (out.stalled) out.problems.push({ level: "warn", text: `${out.stalled} of ${out.downloading} download(s) have no one to download from right now. SaveState removes ones that stay stuck and searches for a better copy.` });
    } catch { /* connected but slow: the status above is enough */ }
    return out;
  }

  function register(app: express.Express) {
    const admin = async (req: express.Request, res: express.Response) => {
      const c = await deps.callerOf(req);
      if (!c.admin) { res.status(403).json({ error: "admin_only", message: "Only the host's admins can do this." }); return false; }
      return true;
    };

    app.get("/api/admin/downloader", async (req, res) => {
      if (!(await admin(req, res))) return;
      const arr = await deps.loadArr();
      const [sonarr, radarr, prowlarr, qbittorrent] = await Promise.all([
        arrHealth("sonarr", arr?.sonarrUrl ?? "", arr?.sonarrApiKey ?? ""),
        arrHealth("radarr", arr?.radarrUrl ?? "", arr?.radarrApiKey ?? ""),
        prowlarrHealth(),
        qbtHealth(),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ apps: [qbittorrent, prowlarr, sonarr, radarr] });
    });

    // Fills Sonarr and Radarr's address and API key from their own settings on this PC.
    app.post("/api/admin/downloader/detect", async (req, res) => {
      if (!(await admin(req, res))) return;
      const prev = await deps.loadArr();
      const next: ArrConfig = { radarrUrl: prev?.radarrUrl ?? "", radarrApiKey: prev?.radarrApiKey ?? "", sonarrUrl: prev?.sonarrUrl ?? "", sonarrApiKey: prev?.sonarrApiKey ?? "" };
      const found: string[] = [];
      for (const id of ["sonarr", "radarr"] as const) {
        const local = await localApp(id);
        if (!local) continue;
        const works = await arrGet(local.url, local.apiKey, "v3", "system/status", 5000).then(() => true, () => false);
        if (!works) continue;
        next[`${id}Url` as "sonarrUrl"] = local.url;
        next[`${id}ApiKey` as "sonarrApiKey"] = local.apiKey;
        found.push(APPS[id].label);
      }
      if (found.length) await deps.saveArr(next);
      const prowlarr = await localApp("prowlarr");
      if (prowlarr) found.push("Prowlarr");
      deps.log("INFO", `Downloader detect: ${found.join(", ") || "nothing found"}`);
      res.json({ ok: true, found });
    });

    // Prowlarr pushes its sites to every linked app.
    app.post("/api/admin/downloader/prowlarr-sync", async (req, res) => {
      if (!(await admin(req, res))) return;
      const local = await localApp("prowlarr");
      if (!local) return res.status(404).json({ error: "Prowlarr isn't installed on this PC." });
      try {
        const r = await fetch(`${local.url}/api/v1/command`, { method: "POST", headers: { "X-Api-Key": local.apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ name: "ApplicationIndexerSync" }), signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        res.json({ ok: true });
      } catch (e: any) { res.status(502).json({ error: `Prowlarr didn't accept that: ${e?.message ?? e}` }); }
    });

    // More sources: adds the recommended public sites Prowlarr does not have
    // yet. Prowlarr tests each one before saving it, so only sites that answer
    // from this connection are added; then they are sent to Sonarr and Radarr.
    app.post("/api/admin/downloader/prowlarr-add-sites", async (req, res) => {
      if (!(await admin(req, res))) return;
      const local = await localApp("prowlarr");
      if (!local) return res.status(404).json({ error: "Prowlarr isn't installed on this PC." });
      const hdr = { "X-Api-Key": local.apiKey, "Content-Type": "application/json" };
      try {
        const [schema, have, profiles] = await Promise.all([
          arrGet(local.url, local.apiKey, "v1", "indexer/schema", 30000),
          arrGet(local.url, local.apiKey, "v1", "indexer"),
          arrGet(local.url, local.apiKey, "v1", "appprofile"),
        ]);
        const haveDefs = new Set((have as any[]).map((i) => String(i.definitionName).toLowerCase()));
        const profileId = (profiles as any[])[0]?.id ?? 1;
        const added: string[] = [], skipped: string[] = [];
        for (const def of RECOMMENDED_SITES) {
          if (haveDefs.has(def.toLowerCase())) continue;
          const s = (schema as any[]).find((x) => String(x.definitionName).toLowerCase() === def.toLowerCase());
          if (!s) continue;
          const body = { ...s, enable: true, appProfileId: profileId, priority: 25, tags: [] };
          const r = await fetch(`${local.url}/api/v1/indexer`, { method: "POST", headers: hdr, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
          if (r.ok) added.push(s.name); else skipped.push(s.name);
        }
        if (added.length) {
          await fetch(`${local.url}/api/v1/command`, { method: "POST", headers: hdr, body: JSON.stringify({ name: "ApplicationIndexerSync" }), signal: AbortSignal.timeout(10000) }).catch(() => {});
        }
        deps.log("INFO", `Prowlarr sites added: ${added.join(", ") || "none"}${skipped.length ? `; not reachable: ${skipped.join(", ")}` : ""}`);
        res.json({ ok: true, added, skipped });
      } catch (e: any) { res.status(502).json({ error: `Prowlarr didn't answer: ${e?.message ?? e}` }); }
    });

    // Retry the failing sites now instead of waiting out Prowlarr's back-off.
    app.post("/api/admin/downloader/prowlarr-retest", async (req, res) => {
      if (!(await admin(req, res))) return;
      const local = await localApp("prowlarr");
      if (!local) return res.status(404).json({ error: "Prowlarr isn't installed on this PC." });
      try {
        const r = await fetch(`${local.url}/api/v1/indexer/testall`, { method: "POST", headers: { "X-Api-Key": local.apiKey }, signal: AbortSignal.timeout(90000) });
        const body = await r.json().catch(() => []);
        const failed = Array.isArray(body) ? body.filter((x: any) => x.isValid === false).length : 0;
        res.json({ ok: true, tested: Array.isArray(body) ? body.length : 0, failed });
      } catch (e: any) { res.status(502).json({ error: `Prowlarr didn't answer: ${e?.message ?? e}` }); }
    });
  }

  return { register };
}
