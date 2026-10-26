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
import { readFile, writeFile, statfs } from "node:fs/promises";
import path from "node:path";
import type { Caller } from "./access.ts";
import { receipt, addLiveSource } from "./receipts.ts";

type ArrConfig = { radarrUrl: string; radarrApiKey: string; sonarrUrl: string; sonarrApiKey: string };
type QbtConfig = { host: string; username: string; password: string };

export type DownloaderDeps = {
  persistDir: string;
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
    // Sonarr once lost most of its program files in a failed self-update and,
    // for nine days, approved releases it could not hand to qBittorrent
    // ("Couldn't add release ... to download queue"). Nothing else showed it.
    const logs = await arrGet(url, key, "v3", "log?page=1&pageSize=100&sortKey=time&sortDirection=descending").catch(() => null);
    const cantSend = (logs?.records ?? []).filter((r: any) => /couldn't add release|could not load file or assembly/i.test(String(r.message ?? "") + String(r.exception ?? ""))
      && Date.now() - new Date(r.time).getTime() < 2 * 86400_000
      // Only since it last started: a repaired install should stop being reported.
      && (!status?.startTime || new Date(r.time).getTime() > new Date(status.startTime).getTime()));
    // A torrent site that answers "too many requests" (Knaben does when several
    // releases are grabbed at once) or hands back a bad link is not qBittorrent's
    // fault: the release is simply tried again on the next search.
    const siteRefused = (r: any) => /TooManyRequests|\b429\b|parse magnet|magnetlink|\b40[34]\b|\b50[0-9]\b/i.test(String(r.exception ?? ""));
    const fromSites = cantSend.filter(siteRefused);
    const broken = cantSend.filter((r: any) => !siteRefused(r));
    if (broken.length) {
      const why = String(broken[0].exception ?? broken[0].message ?? "").split("\n")[0].slice(0, 200);
      out.problems.unshift({ level: "bad", text: `${APPS[id].label} can't send downloads to qBittorrent (${broken.length} failed in the last 2 days): ${why}`,
        fix: /assembly|FileNotFound/i.test(why) ? `${APPS[id].label}'s program files are damaged: reinstall it from the official site (settings are kept).` : "Check the download client in its Settings > Download Clients." });
    }
    if (fromSites.length) {
      const sites = [...new Set(fromSites.map((r: any) => /from Indexer (.+?) \(Prowlarr\)/.exec(String(r.message ?? ""))?.[1]).filter(Boolean))];
      out.problems.push({ level: "warn", text: `${fromSites.length} release(s) couldn't be fetched in the last 2 days because ${sites.length ? sites.join(", ") : "a torrent site"} refused (too many requests at once, or a broken link).`,
        fix: `Nothing to do: ${APPS[id].label} tries them again on its next search (SaveState re-searches missing titles twice a day).` });
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

// ── Deep search ───────────────────────────────────────────────────────────
// Sonarr and Radarr search each site one way ("The Middle S04"). Plenty of
// good copies are only listed under other wordings ("The Middle (2009)
// Season 4 S04 ..."), so a season can sit missing for ever while dead
// single-episode releases are all that turn up (seen 2026-10-14: The Middle
// season 4, 1 of 24 episodes, while a 60-seeder season pack existed). This
// asks Prowlarr with several wordings, keeps well-seeded matches, and hands
// the best to Sonarr / Radarr's release-push API: they still parse and judge
// it against their own quality rules before anything downloads.
const MIN_SEEDERS = Number(process.env.NEXUS_MIN_SEEDERS ?? 5) || 5;
// A run grabs a few things, not a whole back catalogue: the first version sent
// fifteen Simpsons season packs in a minute (stopped before they downloaded).
const MAX_SENT_PER_RUN = Number(process.env.NEXUS_DEEP_MAX_PER_RUN ?? 3) || 3;
// Shows with an enormous backlog (The Simpsons: 800 episodes) are left to the
// owner to fetch on purpose, as retryWantedArr does.
const MAX_MISSING_PER_SHOW = Number(process.env.NEXUS_DEEP_MAX_MISSING ?? 150) || 150;
// Never let a grab eat the last of the library disk.
const KEEP_FREE_BYTES = 50 * 1024 ** 3;
// The disk guard (below): downloads pause under GUARD_LOW free, carry on above GUARD_OK.
const GUARD_LOW = 5 * 1024 ** 3;
const GUARD_OK = 15 * 1024 ** 3;
const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");

export function createDownloader(deps: DownloaderDeps) {
  const stateFile = path.join(deps.persistDir, "deep-search.json");
  let tried: Record<string, { at: number; result: string; title?: string }> = {};
  let lastRun: { at: number; checked: number; sent: string[]; running: boolean } = { at: 0, checked: 0, sent: [], running: false };
  readFile(stateFile, "utf8").then((t) => { const j = JSON.parse(t); tried = j.tried ?? {}; lastRun = { ...lastRun, ...(j.lastRun ?? {}), running: false }; }).catch(() => {});
  const saveState = () => writeFile(stateFile, JSON.stringify({ tried, lastRun })).catch(() => {});

  async function prowlarrSearch(p: { url: string; apiKey: string }, query: string, cat: string): Promise<any[]> {
    try {
      // Several categories are repeated parameters ("5000,5070" in one returned nothing).
      const cats = cat.split(",").map((c) => `&categories=${c.trim()}`).join("");
      const r = await fetch(`${p.url}/api/v1/search?query=${encodeURIComponent(query)}&type=search&limit=100${cats}`, { headers: { "X-Api-Key": p.apiKey }, signal: AbortSignal.timeout(120000) });
      return r.ok ? ((await r.json()) as any[]) : [];
    } catch { return []; }
  }
  // Some sites (Knaben) give only a Prowlarr link in the magnet field, which
  // redirects to the real magnet. Sonarr and Radarr try to read that link as a
  // magnet ("Failed to parse magnetlink") and drop the release, so the real
  // magnet is looked up first.
  async function realMagnet(link: unknown): Promise<string | null> {
    const s = String(link ?? "");
    if (!s) return null;
    if (s.startsWith("magnet:")) return s;
    try {
      const r = await fetch(s, { redirect: "manual", signal: AbortSignal.timeout(30000) });
      const loc = r.headers.get("location") ?? "";
      return loc.startsWith("magnet:") ? loc : null;
    } catch { return null; }
  }
  async function push(app: { url: string; key: string }, rel: any): Promise<{ approved: boolean; why: string }> {
    const magnet = await realMagnet(rel.magnetUrl);
    const downloadUrl = rel.downloadUrl || (magnet ? undefined : rel.magnetUrl);
    const body = { title: rel.title, downloadUrl, magnetUrl: magnet ?? undefined, protocol: "torrent", publishDate: rel.publishDate, indexer: rel.indexer, seeders: rel.seeders, size: rel.size };
    try {
      const r = await fetch(`${app.url.replace(/\/$/, "")}/api/v3/release/push`, { method: "POST", headers: { "X-Api-Key": app.key, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const out = await r.json().catch(() => null);
      const d = Array.isArray(out) ? out[0] : out;
      return { approved: !!d?.approved, why: (d?.rejections ?? []).join("; ") || (r.ok ? "" : `HTTP ${r.status}`) };
    } catch (e: any) { return { approved: false, why: e?.message ?? String(e) }; }
  }
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function arrSend(app: { url: string; key: string }, method: string, p: string, body: unknown): Promise<any> {
    const r = await fetch(`${app.url.replace(/\/$/, "")}/api/v3/${p}`, { method, headers: { "X-Api-Key": app.key, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status}`);
    return r.json().catch(() => null);
  }
  // Older shows and many films barely exist in 1080p within the size policy
  // (Shadowhunters S01, 2026-10-26: 870 releases, none approved, all 720p,
  // 480p or 3 GB 1080p). A title whose releases are refused only for quality
  // or size moves to this profile: 720p or 1080p, upgraded to 1080p later.
  const command = (app: { url: string; key: string }, body: Record<string, unknown>) => arrSend(app, "POST", "command", body).catch(() => null);
  const FALLBACK_PROFILE = "SaveState HD (720p or 1080p)";
  // Anime is Japanese audio with English subtitles: the release policy's
  // "Non-English" (-500, against foreign dubs) refused every Baki and Attack
  // on Titan release (2026-10-26). Anime shows get this one instead.
  const ANIME_PROFILE = "SaveState Anime (720p or 1080p, Japanese audio)";
  async function fallbackProfile(app: { url: string; key: string }, fromId: number, anime = false): Promise<number | null> {
    const name = anime ? ANIME_PROFILE : FALLBACK_PROFILE;
    const profiles = (await arrGet(app.url, app.key, "v3", "qualityprofile").catch(() => [])) as any[];
    const have = profiles.find((p) => p.name === name);
    if (have) return have.id;
    const base = profiles.find((p) => p.id === fromId) ?? profiles[0];
    if (!base) return null;
    const hd = (name: string) => /(^|[\s-])(720p|1080p)$/i.test(name) && !/remux/i.test(name);
    const open = (it: any): any => it.items?.length
      ? { ...it, items: it.items.map(open), allowed: it.items.some((x: any) => hd(x.quality?.name ?? x.name ?? "")) || !!it.allowed }
      : { ...it, allowed: hd(it.quality?.name ?? it.name ?? "") || !!it.allowed };
    const { id: _id, ...rest } = base;
    const formatItems = anime ? (base.formatItems ?? []).map((fi: any) => (/non-english/i.test(fi.name ?? "") ? { ...fi, score: 0 } : fi)) : base.formatItems;
    const made = await arrSend(app, "POST", "qualityprofile", { ...rest, name, upgradeAllowed: true, items: base.items.map(open), formatItems }).catch((e) => { deps.log("WARN", `Fallback profile not made: ${e.message}`); return null; });
    return made?.id ?? null;
  }
  const qualityOnly = (why: string, anime = false) => why.split("; ").filter(Boolean).every((w) => /not wanted in profile|larger than maximum|smaller than minimum|is not an upgrade|does not meet the cutoff/i.test(w) || (anime && /Non-English/i.test(w)));
  const topReason = (whys: string[]) => {
    const n = new Map<string, number>();
    for (const w of whys) for (const x of w.split("; ").filter(Boolean)) { const k = x.replace(/\d+(\.\d+)?/g, "N"); n.set(k, (n.get(k) ?? 0) + 1); }
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };

  async function deepSearch(limit = { seasons: 12, movies: 8 }) {
    if (lastRun.running) return lastRun;
    const prowlarr = await localApp("prowlarr");
    const arr = await deps.loadArr();
    if (!prowlarr || !arr) return lastRun;
    lastRun = { at: Date.now(), checked: 0, sent: [], running: true };
    const DAY = 86400_000;
    try {
      // ── TV: seasons (or single episodes) still missing ──
      if (arr.sonarrUrl && arr.sonarrApiKey) {
        const S = { url: arr.sonarrUrl, key: arr.sonarrApiKey };
        const [series, queue] = await Promise.all([
          arrGet(S.url, S.key, "v3", "series", 30000).catch(() => []),
          arrGet(S.url, S.key, "v3", "queue?pageSize=500", 30000).catch(() => ({ records: [] })),
        ]);
        const busy = new Set((queue.records ?? []).map((q: any) => `${q.seriesId}:${q.seasonNumber}`));
        const roots = (await arrGet(S.url, S.key, "v3", "rootfolder").catch(() => [])) as any[];
        const freeFor = (p: string) => roots.filter((r) => p.toLowerCase().startsWith(String(r.path).toLowerCase())).map((r) => Number(r.freeSpace) || 0)[0] ?? Infinity;
        let budget = limit.seasons;
        for (const s of series as any[]) {
          if (budget <= 0) break;
          if (!s.monitored || lastRun.sent.length >= MAX_SENT_PER_RUN) continue;
          const eps = await arrGet(S.url, S.key, "v3", `episode?seriesId=${s.id}`, 30000).catch(() => []);
          const allMissing = (eps as any[]).filter((e) => e.monitored && !e.hasFile && e.seasonNumber > 0 && e.airDateUtc && new Date(e.airDateUtc).getTime() < Date.now()).length;
          if (allMissing > MAX_MISSING_PER_SHOW) continue;
          const now = Date.now();
          const bySeason = new Map<number, any[]>();
          for (const e of eps as any[]) {
            if (!e.monitored || e.hasFile || e.seasonNumber === 0 || !e.airDateUtc || new Date(e.airDateUtc).getTime() > now - DAY) continue;
            bySeason.set(e.seasonNumber, [...(bySeason.get(e.seasonNumber) ?? []), e]);
          }
          for (const [season, missing] of bySeason) {
            if (budget <= 0 || lastRun.sent.length >= MAX_SENT_PER_RUN) break;
            const key = `tv:${s.id}:${season}`;
            if (busy.has(`${s.id}:${season}`) || (tried[key] && now - tried[key].at < DAY)) continue;
            budget--; lastRun.checked++;
            const title = s.title.replace(/\s*\(\d{4}\)$/, "");
            const one = missing.length === 1 ? missing[0] : null;
            // Anime numbers episodes straight through ("Baki - 01"); Sonarr
            // only reads that in anime mode ("Unable to identify correct
            // episode(s)" for Baki, 2026-10-26).
            const anime = s.seriesType === "anime" || (s.genres ?? []).some((g: string) => /anime/i.test(g));
            if (anime && s.seriesType !== "anime") {
              await arrSend(S, "PUT", `series/${s.id}`, { ...s, seriesType: "anime" }).then(() => { s.seriesType = "anime"; deps.log("INFO", `${s.title}: switched to anime episode numbering`); }).catch(() => {});
            }
            const queries = one
              ? [`${title} S${pad(season)}E${pad(one.episodeNumber)}`, `${title} ${s.year} S${pad(season)}E${pad(one.episodeNumber)}`]
              : [`${title} S${pad(season)}`, `${title} Season ${season}`, `${title} ${s.year} S${pad(season)}`, `${title} (${s.year}) Season ${season}`];
            if (anime) queries.push(season === 1 ? title : `${title} ${season}`, `${title} Batch`);
            const seen = new Map<string, any>();
            // 5070 = TV/Anime: where nyaa and the anime sites file it.
            for (const q of queries) { for (const r of await prowlarrSearch(prowlarr, q, anime ? "5000,5070" : "5000")) seen.set(r.guid ?? r.title, r); await pause(1500); }
            const t = norm(title);
            const seasonRe = one ? new RegExp(`\\bs0?${season}e0?${one.episodeNumber}\\b`, "i") : new RegExp(`\\b(s0?${season}(?!\\s?e\\d)|season\\s?0?${season})\\b`, "i");
            const otherSeason = /\bs(\d{1,2})\b|season\s?(\d{1,2})\b/gi;
            const candidates = [...seen.values()].filter((r) => {
              const n = norm(r.title);
              // Anime release names often carry a fansub tag first ("[SubsPlease] Baki - 01") and no season.
              const bare = norm(r.title.replace(/^\s*\[[^\]]*\]\s*/, ""));
              if ((r.seeders ?? 0) < MIN_SEEDERS || !(n.startsWith(t + " ") || (anime && bare.startsWith(t + " ")))) return false;
              if (!anime && !seasonRe.test(r.title.replace(/[._]/g, " "))) return false;
              // A pack of several seasons, or of another season, is not this one.
              const seasons = new Set([...r.title.replace(/[._]/g, " ").matchAll(otherSeason)].map((m) => Number(m[1] ?? m[2])));
              return seasons.size <= 1;
            }).filter((r) => (Number(r.size) || 0) < freeFor(s.path) - KEEP_FREE_BYTES).sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
            let result = candidates.length ? "nothing approved" : "no well-seeded copy found (or not enough disk space)";
            const whys: string[] = [];
            const tryPush = async () => {
              for (const c of candidates.slice(0, 4)) {
                const d = await push(S, c);
                if (d.approved) { result = `sent: ${c.title} (${c.seeders} seeders)`; lastRun.sent.push(`${s.title} S${pad(season)}${one ? `E${pad(one.episodeNumber)}` : ""}`); receipt({ kind: "search", title: `Found and sent to Sonarr: ${s.title} season ${season}${one ? ` episode ${one.episodeNumber}` : ""}`, detail: `${c.title} · ${c.seeders} seeders · ${(Number(c.size || 0) / 1024 ** 3).toFixed(1)} GB · ${c.indexer}` }); return true; }
                whys.push(d.why);
              }
              return false;
            };
            if (!(await tryPush()) && whys.length && (whys.every((w) => qualityOnly(w, anime)) || (anime && whys.some((w) => /Non-English/i.test(w))))) {
              const fb = await fallbackProfile(S, s.qualityProfileId, anime);
              if (fb && fb !== s.qualityProfileId) {
                await arrSend(S, "PUT", `series/${s.id}`, { ...s, qualityProfileId: fb }).then(() => { s.qualityProfileId = fb; deps.log("INFO", anime ? `${s.title}: anime profile (Japanese audio with subtitles, 720p or 1080p)` : `${s.title}: no 1080p copy within the size policy; now accepts 720p too (upgrades to 1080p later)`); }).catch(() => {});
                whys.length = 0;
                await tryPush();
                // Sonarr searches the rest of the show with the new profile itself.
                await command(S, { name: "SeriesSearch", seriesId: s.id });
              }
            }
            if (!result.startsWith("sent") && whys.length) result = `nothing approved (${topReason(whys)})`;
            // Part of the season is already there, so whole-season packs are refused:
            // Sonarr's own search goes episode by episode (Modern Family S07-S10).
            if (!result.startsWith("sent") && !one && whys.some((w) => /meets cutoff|wasn't requested|is not an upgrade/i.test(w))) {
              await command(S, { name: "EpisodeSearch", episodeIds: missing.map((e: any) => e.id) });
              result += "; asked Sonarr to search the missing episodes one by one";
            }
            tried[key] = { at: Date.now(), result, title: `${s.title} season ${season}${one ? ` episode ${one.episodeNumber}` : ""}` };
            deps.log("INFO", `Deep search ${s.title} S${pad(season)} (${missing.length} missing): ${result}`);
          }
        }
      }
      // ── Films still missing ──
      if (arr.radarrUrl && arr.radarrApiKey) {
        const R = { url: arr.radarrUrl, key: arr.radarrApiKey };
        const [movies, queue] = await Promise.all([
          arrGet(R.url, R.key, "v3", "movie", 30000).catch(() => []),
          arrGet(R.url, R.key, "v3", "queue?pageSize=500", 30000).catch(() => ({ records: [] })),
        ]);
        const busy = new Set((queue.records ?? []).map((q: any) => q.movieId));
        const roots = (await arrGet(R.url, R.key, "v3", "rootfolder").catch(() => [])) as any[];
        const freeFor = (p: string) => roots.filter((r) => p.toLowerCase().startsWith(String(r.path).toLowerCase())).map((r) => Number(r.freeSpace) || 0)[0] ?? Infinity;
        let budget = limit.movies;
        for (const m of movies as any[]) {
          if (budget <= 0 || lastRun.sent.length >= MAX_SENT_PER_RUN) break;
          const key = `movie:${m.id}`;
          if (!m.monitored || m.hasFile || !m.isAvailable || busy.has(m.id) || (tried[key] && Date.now() - tried[key].at < DAY)) continue;
          budget--; lastRun.checked++;
          const seen = new Map<string, any>();
          // Films are also released under their original and other titles
          // (the Attack on Titan films as "Shingeki no Kyojin ...": 2026-10-26).
          const names = [...new Set([m.title, m.originalTitle, ...(m.alternateTitles ?? []).map((a: any) => a.title)]
            .filter((x): x is string => !!x && /[a-z]/i.test(x)).map((x) => x.trim()))].slice(0, 4);
          const ts = names.map(norm).filter(Boolean);
          const anime = (m.genres ?? []).some((g: string) => /anim/i.test(g)) && /^ja/i.test(m.originalLanguage?.name ?? m.originalLanguage ?? "");
          const pick = () => [...seen.values()].filter((r) => (r.seeders ?? 0) >= MIN_SEEDERS && ts.some((t) => norm(r.title.replace(/^\s*\[[^\]]*\]\s*/, "")).startsWith(t + " ")) && r.title.includes(String(m.year)) && (Number(r.size) || 0) < freeFor(m.path ?? "") - KEEP_FREE_BYTES)
            .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
          for (const n of names) {
            for (const q of [`${n} ${m.year}`, `${n} (${m.year})`]) { for (const r of await prowlarrSearch(prowlarr, q, anime ? "2000,5070" : "2000")) seen.set(r.guid ?? r.title, r); await pause(1500); }
            if (pick().length >= 3) break;
          }
          // Shorts and TV films are often filed as TV ("Too Many Cooks (2014
          // Adult Swim) ... TV Short"), where Radarr never looks.
          if (!pick().length) { for (const r of await prowlarrSearch(prowlarr, `${m.title} ${m.year}`, "5000")) seen.set(r.guid ?? r.title, r); await pause(1500); }
          const candidates = pick();
          let result = candidates.length ? "nothing approved" : "no well-seeded copy found (or not enough disk space)";
          const whys: string[] = [];
          const tryPush = async () => {
            for (const c of candidates.slice(0, 4)) {
              const d = await push(R, c);
              if (d.approved) { result = `sent: ${c.title} (${c.seeders} seeders)`; lastRun.sent.push(`${m.title} (${m.year})`); receipt({ kind: "search", title: `Found and sent to Radarr: ${m.title} (${m.year})`, detail: `${c.title} · ${c.seeders} seeders · ${(Number(c.size || 0) / 1024 ** 3).toFixed(1)} GB · ${c.indexer}` }); return true; }
              whys.push(d.why);
            }
            return false;
          };
          if (!(await tryPush()) && whys.length && whys.every((w) => qualityOnly(w))) {
            const fb = await fallbackProfile(R, m.qualityProfileId);
            if (fb && fb !== m.qualityProfileId) {
              await arrSend(R, "PUT", `movie/${m.id}`, { ...m, qualityProfileId: fb }).then(() => { m.qualityProfileId = fb; deps.log("INFO", `${m.title}: no 1080p copy within the size policy; now accepts 720p too (upgrades to 1080p later)`); }).catch(() => {});
              whys.length = 0;
              if (!(await tryPush())) await command(R, { name: "MoviesSearch", movieIds: [m.id] });
            }
          }
          if (!result.startsWith("sent") && whys.length) result = `nothing approved (${topReason(whys)})`;
          tried[key] = { at: Date.now(), result, title: `${m.title} (${m.year})` };
          deps.log("INFO", `Deep search ${m.title} (${m.year}): ${result}`);
        }
      }
    } finally {
      lastRun.running = false;
      lastRun.at = Date.now();
      for (const [k, v] of Object.entries(tried)) if (Date.now() - v.at > 30 * DAY) delete tried[k];
      await saveState();
    }
    return lastRun;
  }
  addLiveSource(async () => {
    const out: any[] = [];
    if (lastRun.running) out.push({ kind: "search", title: "Deep search for missing seasons and films", progress: null, detail: `${lastRun.checked} checked, ${lastRun.sent.length} found so far` });
    const cfg = await deps.loadQbt().catch(() => null);
    const cookie = cfg ? await deps.qbtLogin(cfg).catch(() => null) : null;
    if (cfg && cookie !== null) {
      const list = await fetch(`${cfg.host}/api/v2/torrents/info?filter=downloading`, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(6000) }).then((r) => r.json()).catch(() => []);
      const low = guard.free != null && guard.free < GUARD_OK;
      const doing = (t: any) => t.state === "stalledDL" ? "Waiting for people to download from"
        : t.state === "error" || t.state === "missingFiles" ? (low ? "Stopped: the download disk is full" : "Stopped with an error")
        : /^(paused|stopped)DL$/.test(t.state) ? (guard.paused.includes(t.hash) ? `Paused until the download disk has room (${((guard.free ?? 0) / 1024 ** 3).toFixed(0)} GB free)` : "Paused")
        : /^(queued|checking)/.test(t.state) ? "Waiting its turn" : "Downloading";
      for (const t of list as any[]) out.push({ kind: "download", title: t.name, progress: t.progress,
        detail: `${doing(t)} · ${t.num_seeds} seeding · ${(t.size / 1024 ** 3).toFixed(1)} GB`, speed: t.dlspeed, eta: t.eta > 0 && t.eta < 8640000 ? t.eta : null, status: t.state });
    }
    return out;
  });
  setTimeout(() => void deepSearch().catch(() => {}), 20 * 60_000).unref?.();
  setInterval(() => void deepSearch().catch(() => {}), 6 * 3600_000).unref?.();

  // ── Disk guard ──
  // qBittorrent writes until its disk is full, and then every download stops
  // with an error (F: filled on 2026-10-19 once the speed limit came off).
  // Below 5 GB free SaveState pauses the downloads; with 15 GB free they carry
  // on, and ones the full disk stopped are started again.
  const guardFile = path.join(deps.persistDir, "disk-guard.json");
  const guard: { paused: string[]; free: number | null } = { paused: [], free: null };
  readFile(guardFile, "utf8").then((t) => { guard.paused = JSON.parse(t).paused ?? []; }).catch(() => {});
  const saveGuard = () => writeFile(guardFile, JSON.stringify({ paused: guard.paused })).catch(() => {});
  async function diskGuard() {
    const cfg = await deps.loadQbt().catch(() => null);
    const cookie = cfg ? await deps.qbtLogin(cfg).catch(() => null) : null;
    if (!cfg || cookie === null) return;
    const headers: Record<string, string> = { Referer: cfg.host, ...(cookie ? { Cookie: cookie } : {}) };
    const get = (p: string) => fetch(`${cfg.host}/api/v2/${p}`, { headers, signal: AbortSignal.timeout(10000) }).then((r) => r.json());
    // qBittorrent 5 calls them stop/start; 4 called them pause/resume.
    const act = async (verb: "stop" | "start", hashes: string[]) => {
      const body = new URLSearchParams({ hashes: hashes.join("|") });
      const r = await fetch(`${cfg.host}/api/v2/torrents/${verb}`, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (!r || r.status === 404) await fetch(`${cfg.host}/api/v2/torrents/${verb === "stop" ? "pause" : "resume"}`, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) }).catch(() => {});
    };
    const prefs = await get("app/preferences").catch(() => null);
    const info = prefs?.save_path ? await statfs(prefs.save_path).catch(() => null) : null;
    if (!info) return;
    const free = info.bavail * info.bsize;
    guard.free = free;
    const list = ((await get("torrents/info").catch(() => [])) as any[]);
    if (free < GUARD_LOW) {
      const busy = list.filter((t) => t.amount_left > 0 && !/^(paused|stopped)/.test(t.state)).map((t) => t.hash);
      if (!busy.length) return;
      await act("stop", busy);
      guard.paused = [...new Set([...guard.paused, ...busy])];
      void saveGuard();
      deps.log("WARN", `Download disk nearly full (${(free / 1024 ** 3).toFixed(1)} GB free): paused ${busy.length} download(s)`);
      receipt({ kind: "download", status: "warn", title: "Downloads paused: the download disk is nearly full", detail: `${(free / 1024 ** 3).toFixed(1)} GB free on ${prefs.save_path}. They carry on by themselves at ${GUARD_OK / 1024 ** 3} GB free (Cloud Drives > Upload & verify frees space).` });
    } else if (free > GUARD_OK) {
      const stuck = list.filter((t) => t.amount_left > 0 && (t.state === "error" || guard.paused.includes(t.hash))).map((t) => t.hash);
      if (stuck.length) {
        await act("start", stuck);
        deps.log("INFO", `Download disk has room again (${(free / 1024 ** 3).toFixed(0)} GB free): started ${stuck.length} download(s)`);
      }
      if (guard.paused.length) { guard.paused = []; void saveGuard(); }
    }
  }
  setTimeout(() => void diskGuard().catch(() => {}), 60_000).unref?.();
  setInterval(() => void diskGuard().catch(() => {}), 2 * 60_000).unref?.();

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
      const recent = Object.entries(tried).sort((a, b) => b[1].at - a[1].at).slice(0, 12).map(([k, v]) => ({ key: k, ...v }));
      // Entries from before names were kept: look the names up once.
      if (recent.some((r) => !r.title) && arr) {
        const [series, movies] = await Promise.all([
          recent.some((r) => r.key.startsWith("tv:")) && arr.sonarrUrl ? arrGet(arr.sonarrUrl, arr.sonarrApiKey, "v3", "series", 30000).catch(() => []) : [],
          recent.some((r) => r.key.startsWith("movie:")) && arr.radarrUrl ? arrGet(arr.radarrUrl, arr.radarrApiKey, "v3", "movie", 30000).catch(() => []) : [],
        ]);
        for (const r of recent) {
          if (r.title) continue;
          const [kind, id, season] = r.key.split(":");
          const hit = (kind === "tv" ? (series as any[]) : (movies as any[])).find((x) => String(x.id) === id);
          if (!hit) continue;
          r.title = kind === "tv" ? `${hit.title} season ${season}` : `${hit.title} (${hit.year})`;
          tried[r.key].title = r.title;
        }
        void saveState();
      }
      res.json({ apps: [qbittorrent, prowlarr, sonarr, radarr], deep: { ...lastRun, recent } });
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

    // Look for missing seasons and films under other wordings now.
    app.post("/api/admin/downloader/deep-search", async (req, res) => {
      if (!(await admin(req, res))) return;
      if (lastRun.running) return res.json({ ok: true, running: true });
      // Asked for by hand: everything is due again.
      tried = {};
      void deepSearch({ seasons: 30, movies: 20 }).catch(() => {});
      res.json({ ok: true, started: true });
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
