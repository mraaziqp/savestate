/**
 * Household profiles: one account, several people.
 *
 * The account holder adds profiles (a child, a partner, the lounge TV). Each
 * profile has its own name, avatar and watch history, and the account holder
 * decides for each one:
 *
 *   - which sections it may open (Movies & TV, Music, Books, Games, Photos);
 *   - the highest age rating it may watch (certifications come from TMDB and
 *     are cached in certifications.json; a title without one is hidden from a
 *     capped profile unless "allow unrated" is on);
 *   - a daily screen-time allowance and the hours it may be used;
 *   - a PIN to open it, and a parent PIN to leave it for the full account.
 *
 * A profile can also be handed to another device as a link
 * (https://<site>/?profile=<token>). Sessions started from a link can never
 * become the account, and revoking the link (or "sign out everywhere") ends
 * every session of that profile at once (the token's `pv` must match).
 *
 * None of this is decoration in the browser: a profile session is a token the
 * server recognises (access.ts), and `gate` below refuses every request outside
 * the profile's sections, over its rating or past its time, before any route
 * runs.
 */
import type express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { readFile, writeFile, rename } from "node:fs/promises";
import jwt from "jsonwebtoken";
import type { Caller, ProfileSession } from "./access.ts";
import { receipt } from "./receipts.ts";

type MediaItem = { kind: string; category?: string | null; seriesTitle?: string | null; name: string; relPath: string };

export type HouseholdDeps = {
  persistDir: string;
  jwtSecret: string;
  tmdbKey: string;
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[] | null>;
  dbUp: () => boolean;
  callerOf: (req: express.Request) => Promise<Caller>;
  /** The account's own session token (as at sign-in). */
  sessionFor: (req: express.Request, res: express.Response, u: { id: string; username: string }) => string;
  setSessionCookie: (req: express.Request, res: express.Response, token: string | null) => void;
  /** Household profiles the caller's plan allows (null: no limit). */
  maxProfiles: (caller: Caller) => number | null;
  media: () => MediaItem[];
  /** Title (and year) TMDB knows a library item by. */
  titleOf: (item: MediaItem) => { type: "movie" | "tv"; title: string; year?: string } | null;
  publicUrl: () => string;
  log: (level: string, msg: string) => void;
};

// ── Sections and what each one opens ──────────────────────────────────────
type Pattern = string | RegExp;
const SECTIONS: Record<string, { label: string; tabs: string[]; api: Pattern[] }> = {
  media: {
    label: "Movies & TV",
    tabs: ["media", "matchmaker", "discover", "party"],
    api: [
      /^\/api\/media\/(library|details|file|stream|hls\/|info|thumbnail|intro-markers|progress|continue-watching|recommendations|subtitles\/|title-info|prewarm)/,
      "/api/watch/", "/api/taste", "/api/discover/", "/api/watch-party/", /^\/api\/stream\/(gdrive|media)\//,
    ],
  },
  music: { label: "Music", tabs: ["music"], api: ["/api/music/", "/api/playlists"] },
  books: { label: "Books & comics", tabs: ["codex"], api: ["/api/codex/"] },
  games: {
    label: "Games",
    tabs: ["library", "consoles", "minigames", "multiplayer", "handheld", "manual", "remoteplay"],
    api: [
      "/api/games", "/api/minigames", "/api/roms/", "/api/emulator/", "/api/bios/", "/api/cores", "/api/coop/", "/api/remote-play/",
      /^\/api\/stream\/(check|start|stop|feed|input|hls\/)/, "/api/pc-games/", "/api/steam/", "/api/manual-library",
      /^\/api\/profiles\/[^/]+\/(games|saves|favorites|ratings|achievements|trophies|dashboard)/,
    ],
  },
  photos: { label: "Photos", tabs: ["gallery", "photos"], api: ["/api/photos/"] },
};
const SECTION_KEYS = Object.keys(SECTIONS);
/** Kids' caps also close Discover and What to Watch, which show what is in cinemas, not what is in the library. */
const OPEN_WORLD_TABS = new Set(["discover", "matchmaker"]);

// Whatever the profile: the app must load, sign in and out, and draw covers.
const ALWAYS: Pattern[] = [
  "/api/auth/me", "/api/auth/verify", "/api/auth/session", "/api/auth/logout", "/api/auth/refresh", "/api/auth/config",
  "/api/auth/media-access", "/api/auth/login", "/api/auth/register", "/api/auth/forgot", "/api/auth/reset", "/api/auth/check-username",
  /^\/api\/plans(\/me)?$/, "/api/health", "/api/household/", "/api/art/", "/api/media/img-proxy", "/api/media/poster", "/api/media/backdrop",
  "/api/media/episode-poster", "/api/client-issues/report", "/api/host/info", "/api/host/public-profile", "/api/host/readiness",
  "/api/torrent/download-status", "/api/updates/", "/api/downloads/", "/api/music/cover", "/api/music/scan-progress",
  "/api/system/stats", "/api/hosts/my-requests",
];
// Requests that mean someone is watching, listening or playing (time allowance).
const ACTIVITY = /^\/api\/(media\/(stream|file|hls\/segment|progress)|music\/stream|emulator\/|games\/[^/]+\/(launch|play)|codex\/books\/[^/]+\/file)/;

// ── Age ratings ───────────────────────────────────────────────────────────
// 0 all ages · 1 PG · 2 PG-13 / 12-14 · 3 R / 15-16 · 4 18+
export const RATINGS = [
  { id: "all", label: "Everything", max: null as number | null },
  { id: "mature", label: "Up to 16 (R, TV-MA, 16)", max: 3 },
  { id: "teen", label: "Up to 13 (PG-13, TV-14, 12)", max: 2 },
  { id: "kids", label: "Up to PG (PG, TV-PG, TV-Y7)", max: 1 },
  { id: "little", label: "All ages only (G, TV-Y, TV-G)", max: 0 },
];
const CERT_LEVEL: Record<string, number> = {
  "G": 0, "TV-Y": 0, "TV-G": 0, "U": 0, "A": 0, "0": 0, "ALL": 0, "TP": 0, "AL": 0, "6": 0,
  "PG": 1, "TV-Y7": 1, "TV-Y7-FV": 1, "TV-PG": 1, "7": 1, "7-9PG": 1, "8": 1, "10": 1, "PG10": 1,
  "PG-13": 2, "TV-14": 2, "12": 2, "12A": 2, "13": 2, "14": 2, "10-12PG": 2, "PG13": 2, "M": 2, "12+": 2,
  "R": 3, "TV-MA": 3, "15": 3, "16": 3, "MA15+": 3, "M15+": 3, "16+": 3, "13-15": 3,
  "NC-17": 4, "18": 4, "R18": 4, "X18": 4, "R18+": 4, "18+": 4, "X": 4,
};
const CERT_COUNTRIES = ["US", "GB", "ZA", "AU", "CA", "IE", "NZ", "DE"];
const levelOfCert = (c: string): number | null => {
  const k = c.trim().toUpperCase();
  return k in CERT_LEVEL ? CERT_LEVEL[k] : null;
};

// ── Rows ──────────────────────────────────────────────────────────────────
type Row = {
  id: string; owner_id: string; name: string; avatar: string; color: string; pin_hash: string | null;
  rating: string; allow_unrated: boolean; sections: string[]; daily_minutes: number | null;
  allowed_from: number | null; allowed_to: number | null; share_hash: string | null; version: number;
};
type Profile = ProfileSession & {
  rating: string; maxLevel: number | null; allowUnrated: boolean; hasPin: boolean;
  dailyMinutes: number | null; allowedFrom: number | null; allowedTo: number | null; shared: boolean;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS household_profiles (
    id UUID PRIMARY KEY, owner_id UUID NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#22d3ee', pin_hash TEXT, rating TEXT NOT NULL DEFAULT 'all',
    allow_unrated BOOLEAN NOT NULL DEFAULT FALSE, sections TEXT[] NOT NULL DEFAULT '{media,music,books,games}',
    daily_minutes INTEGER, allowed_from SMALLINT, allowed_to SMALLINT, share_hash TEXT,
    version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_household_profiles_owner ON household_profiles(owner_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_household_profiles_share ON household_profiles(share_hash) WHERE share_hash IS NOT NULL;
  CREATE TABLE IF NOT EXISTS household_parent_pin (owner_id UUID PRIMARY KEY, pin_hash TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS household_usage (profile_id UUID NOT NULL, day DATE NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, day));
  CREATE TABLE IF NOT EXISTS household_progress (
    profile_id UUID NOT NULL, rel_path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', watch_time INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 0, ended BOOLEAN NOT NULL DEFAULT FALSE, updated_at BIGINT NOT NULL, PRIMARY KEY (profile_id, rel_path)
  );
`;

const AVATARS = ["🦊", "🐼", "🦁", "🐸", "🐙", "🦄", "🐯", "🐨", "🐵", "🐧", "🚀", "⭐", "🎮", "🎧", "🌈", "⚽"];
const COLOURS = ["#22d3ee", "#a855f7", "#f59e0b", "#10b981", "#f43f5e", "#4d7cff", "#ec4899", "#84cc16"];

const hashPin = (pin: string) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(pin, salt, 32).toString("hex")}`;
};
const pinMatches = (pin: string, stored: string | null) => {
  if (!stored) return false;
  const [, salt, hex] = stored.split("$");
  if (!salt || !hex) return false;
  const got = crypto.scryptSync(pin, salt, 32);
  const want = Buffer.from(hex, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const validPin = (pin: unknown) => typeof pin === "string" && /^\d{4,8}$/.test(pin);
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const matches = (p: Pattern, x: string) => (typeof p === "string" ? x === p || x.startsWith(p) : p.test(x));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const normTitle = (t: string) => t.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

function tabsFor(sections: string[], maxLevel: number | null): string[] {
  const tabs = new Set<string>(["household"]);
  for (const k of sections) for (const t of SECTIONS[k]?.tabs ?? []) tabs.add(t);
  if (maxLevel != null && maxLevel <= 2) for (const t of OPEN_WORLD_TABS) tabs.delete(t);
  return [...tabs];
}

function toProfile(r: Row): Profile {
  const sections = (r.sections ?? []).filter((s) => SECTION_KEYS.includes(s));
  const maxLevel = RATINGS.find((x) => x.id === r.rating)?.max ?? null;
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, avatar: r.avatar, color: r.color, sections,
    tabs: tabsFor(sections, maxLevel), via: "picker", version: Number(r.version) || 1,
    rating: r.rating, maxLevel, allowUnrated: !!r.allow_unrated, hasPin: !!r.pin_hash,
    dailyMinutes: r.daily_minutes == null ? null : Number(r.daily_minutes),
    allowedFrom: r.allowed_from == null ? null : Number(r.allowed_from),
    allowedTo: r.allowed_to == null ? null : Number(r.allowed_to),
    shared: !!r.share_hash,
  };
}
const publicProfile = (p: Profile) => ({
  id: p.id, name: p.name, avatar: p.avatar, color: p.color, sections: p.sections, rating: p.rating, allowUnrated: p.allowUnrated,
  hasPin: p.hasPin, dailyMinutes: p.dailyMinutes, allowedFrom: p.allowedFrom, allowedTo: p.allowedTo, shared: p.shared, tabs: p.tabs,
});

export function createHousehold(deps: HouseholdDeps) {
  let schemaReady = false;
  async function ensureSchema() {
    if (schemaReady) return true;
    if (!deps.dbUp()) return false;
    if (!(await deps.query(SCHEMA))) return false;
    schemaReady = true;
    return true;
  }

  // ── Profiles, cached for the access check on every request ──────────────
  const cache = new Map<string, { at: number; p: Profile | null }>();
  async function profileById(id: string): Promise<Profile | null | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < 20_000) return hit.p;
    if (!(await ensureSchema())) return hit ? hit.p : undefined;
    const rows = await deps.query<Row>("SELECT * FROM household_profiles WHERE id=$1", [id]);
    if (!rows) return hit ? hit.p : undefined;
    const p = rows[0] ? toProfile(rows[0]) : null;
    cache.set(id, { at: Date.now(), p });
    return p;
  }
  const forget = (id: string) => cache.delete(id);

  // ── Certifications ──────────────────────────────────────────────────────
  const certFile = path.join(deps.persistDir, "certifications.json");
  /** key -> level, or -1 when TMDB has no certification for it. */
  let certs: Record<string, number> = {};
  let certsDirty = 0;
  const certsLoaded = readFile(certFile, "utf8").then((t) => { certs = JSON.parse(t) ?? {}; }).catch(() => {});
  async function saveCerts() {
    if (!certsDirty) return;
    certsDirty = 0;
    const tmp = `${certFile}.tmp`;
    await writeFile(tmp, JSON.stringify(certs)).then(() => rename(tmp, certFile)).catch(() => {});
  }
  const keyOf = (item: MediaItem): string | null => {
    const t = deps.titleOf(item);
    if (!t?.title) return null;
    return `${t.type}:${normTitle(t.title)}${t.year ? `|${t.year}` : ""}`;
  };
  async function lookupCert(item: MediaItem): Promise<number> {
    const t = deps.titleOf(item);
    if (!t?.title) return -1;
    const kind = t.type === "tv" ? "tv" : "movie";
    const yearParam = t.year ? `&${kind === "tv" ? "first_air_date_year" : "primary_release_year"}=${t.year}` : "";
    const get = (u: string) => fetch(`https://api.themoviedb.org/3/${u}${u.includes("?") ? "&" : "?"}api_key=${deps.tmdbKey}`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`TMDB ${r.status}`))));
    let found = (await get(`search/${kind}?query=${encodeURIComponent(t.title)}${yearParam}`))?.results?.[0];
    if (!found && t.year) found = (await get(`search/${kind}?query=${encodeURIComponent(t.title)}`))?.results?.[0];
    if (!found) return -1;
    if (found.adult) return 4;
    if (kind === "movie") {
      const rd = await get(`movie/${found.id}/release_dates`);
      for (const c of CERT_COUNTRIES) {
        const entry = (rd?.results ?? []).find((x: any) => x.iso_3166_1 === c);
        for (const d of entry?.release_dates ?? []) { const l = levelOfCert(String(d.certification ?? "")); if (l != null) return l; }
      }
    } else {
      const cr = await get(`tv/${found.id}/content_ratings`);
      for (const c of CERT_COUNTRIES) {
        const entry = (cr?.results ?? []).find((x: any) => x.iso_3166_1 === c);
        const l = entry ? levelOfCert(String(entry.rating ?? "")) : null;
        if (l != null) return l;
      }
    }
    return -1;
  }

  // The library is rated in the background while any profile has a cap.
  let rating = false;
  async function rateLibrary() {
    if (rating) return;
    rating = true;
    try {
      await certsLoaded;
      const todo = new Map<string, MediaItem>();
      for (const it of deps.media()) {
        if (it.kind !== "video") continue;
        const k = keyOf(it);
        if (k && !(k in certs) && !todo.has(k)) todo.set(k, it);
      }
      if (!todo.size) return;
      deps.log("INFO", `Rating ${todo.size} title(s) for household profiles`);
      let done = 0, failed = 0;
      for (const [k, it] of todo) {
        try { certs[k] = await lookupCert(it); certsDirty++; done++; }
        catch { failed++; if (failed > 20) break; }
        if (certsDirty >= 25) await saveCerts();
        await new Promise((r) => setTimeout(r, 120));
      }
      await saveCerts();
      deps.log("INFO", `Household ratings: ${done} rated${failed ? `, ${failed} failed (retried later)` : ""}`);
    } finally { rating = false; }
  }
  async function anyCapped() {
    if (!(await ensureSchema())) return false;
    const r = await deps.query("SELECT 1 FROM household_profiles WHERE rating <> 'all' LIMIT 1");
    return !!r?.length;
  }
  const rateTimer = setInterval(() => { void anyCapped().then((yes) => yes && rateLibrary()).catch(() => {}); }, 30 * 60_000);
  rateTimer.unref?.();
  setTimeout(() => { void anyCapped().then((yes) => yes && rateLibrary()).catch(() => {}); }, 60_000).unref?.();

  let relIndex: { src: MediaItem[]; map: Map<string, MediaItem> } | null = null;
  function itemByRel(rel: string): MediaItem | undefined {
    const src = deps.media();
    if (relIndex?.src !== src) relIndex = { src, map: new Map(src.map((m) => [String(m.relPath).toLowerCase(), m])) };
    return relIndex.map.get(rel.toLowerCase());
  }
  function allowedItem(p: Profile, item: MediaItem | undefined): boolean {
    if (p.maxLevel == null || !item || item.kind !== "video") return true;
    const k = keyOf(item);
    const level = k ? certs[k] : undefined;
    if (level == null || level < 0) return p.allowUnrated;
    return level <= p.maxLevel;
  }

  // ── Screen time ─────────────────────────────────────────────────────────
  const usage = new Map<string, { day: string; minutes: number; lastMinute: number; loaded: boolean }>();
  async function usageOf(id: string) {
    const d = today();
    let u = usage.get(id);
    if (!u || u.day !== d) { u = { day: d, minutes: 0, lastMinute: 0, loaded: false }; usage.set(id, u); }
    if (!u.loaded && deps.dbUp()) {
      const r = await deps.query<{ minutes: number }>("SELECT minutes FROM household_usage WHERE profile_id=$1 AND day=$2", [id, d]);
      if (r) { u.minutes = Math.max(u.minutes, Number(r[0]?.minutes ?? 0)); u.loaded = true; }
    }
    return u;
  }
  async function countMinute(id: string) {
    const u = await usageOf(id);
    const minute = Math.floor(Date.now() / 60_000);
    if (u.lastMinute === minute) return u;
    u.lastMinute = minute;
    u.minutes++;
    void deps.query(
      `INSERT INTO household_usage (profile_id, day, minutes) VALUES ($1,$2,1)
       ON CONFLICT (profile_id, day) DO UPDATE SET minutes = household_usage.minutes + 1`, [id, u.day]);
    return u;
  }
  function timeState(p: Profile, minutes: number) {
    const h = new Date().getHours();
    if (p.allowedFrom != null && p.allowedTo != null && p.allowedFrom !== p.allowedTo) {
      const inside = p.allowedFrom < p.allowedTo ? h >= p.allowedFrom && h < p.allowedTo : h >= p.allowedFrom || h < p.allowedTo;
      if (!inside) return { timeUp: true, reason: "hours", message: `${p.name} can use SaveState from ${p.allowedFrom}:00 to ${p.allowedTo}:00.` };
    }
    if (p.dailyMinutes != null && minutes >= p.dailyMinutes) {
      return { timeUp: true, reason: "daily", message: `That's ${p.name}'s ${p.dailyMinutes} minutes for today. See you tomorrow!` };
    }
    return { timeUp: false, reason: null as string | null, message: "" };
  }

  // ── The gate (called by access.ts for every profile request) ────────────
  async function gate(caller: Caller, req: express.Request) {
    const s = caller.profile!;
    const p = (await profileById(s.id)) ?? null;
    if (!p) return { status: 401, body: { error: "This profile was signed out by the account owner.", code: "session_expired" } };
    const at = req.path;
    if (ALWAYS.some((x) => matches(x, at))) return null;
    const section = p.sections.find((k) => SECTIONS[k].api.some((x) => matches(x, at)));
    if (!section) {
      return { status: 403, body: { error: "profile_restricted", message: `That isn't available on ${p.name}'s profile.` } };
    }
    if (p.maxLevel != null && p.maxLevel <= 2 && /^\/api\/discover\//.test(at)) {
      return { status: 403, body: { error: "profile_restricted", message: `Discover isn't available on ${p.name}'s profile.` } };
    }
    const u = await usageOf(p.id);
    const t = timeState(p, u.minutes);
    if (t.timeUp) return { status: 403, body: { error: "time_up", reason: t.reason, message: t.message } };
    if (ACTIVITY.test(at)) void countMinute(p.id);

    if (p.maxLevel != null) {
      const rel = String(req.query.rel ?? "");
      if (rel && /^\/api\/media\/(file|stream|hls\/|info|thumbnail|intro-markers|subtitles\/extract|prewarm)/.test(at)) {
        if (!allowedItem(p, itemByRel(rel))) {
          return { status: 403, body: { error: "rating_blocked", message: `That title is above ${p.name}'s age rating.` } };
        }
      }
      // A Drive file id says nothing about what it is.
      if (/^\/api\/stream\/(gdrive|media)\//.test(at)) {
        return { status: 403, body: { error: "rating_blocked", message: `That isn't available on ${p.name}'s profile.` } };
      }
    }
    return null;
  }

  function profileToken(p: Profile, ownerUsername: string, via: "picker" | "link") {
    return jwt.sign({ userId: p.ownerId, username: ownerUsername, profileId: p.id, pv: p.version, via }, deps.jwtSecret, { expiresIn: "30d" });
  }

  // Five wrong PINs in ten minutes and that PIN (or link) rests for a while.
  const attempts = new Map<string, { n: number; first: number }>();
  function tooMany(key: string) {
    const a = attempts.get(key);
    if (!a || Date.now() - a.first > 10 * 60_000) return false;
    return a.n >= 5;
  }
  function failed(key: string) {
    const a = attempts.get(key);
    if (!a || Date.now() - a.first > 10 * 60_000) attempts.set(key, { n: 1, first: Date.now() });
    else a.n++;
    if (attempts.size > 5000) attempts.clear();
  }

  function register(app: express.Express) {
    const owner = async (req: express.Request, res: express.Response): Promise<Caller | null> => {
      const c = await deps.callerOf(req);
      if (!c.authed || !c.userId || c.host) { res.status(401).json({ error: "Sign in with your account to manage profiles." }); return null; }
      if (c.profile) { res.status(403).json({ error: "profile_restricted", message: "Only the account holder can manage profiles." }); return null; }
      if (!(await ensureSchema())) { res.status(503).json({ error: "Profiles are unavailable right now. Try again in a minute." }); return null; }
      return c;
    };
    const ownProfile = async (c: Caller, id: string) => {
      const p = await profileById(id);
      return p && p.ownerId === c.userId ? p : null;
    };
    const readFields = (b: any, isNew: boolean) => {
      const out: Record<string, unknown> = {};
      if (typeof b.name === "string") {
        const name = b.name.trim().slice(0, 24);
        if (!name) throw new Error("Give the profile a name.");
        out.name = name;
      } else if (isNew) throw new Error("Give the profile a name.");
      if (typeof b.avatar === "string") out.avatar = [...b.avatar.trim()].slice(0, 2).join("");
      if (typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color)) out.color = b.color;
      if (typeof b.rating === "string") {
        if (!RATINGS.some((r) => r.id === b.rating)) throw new Error("Pick an age rating from the list.");
        out.rating = b.rating;
      }
      if (typeof b.allowUnrated === "boolean") out.allow_unrated = b.allowUnrated;
      if (Array.isArray(b.sections)) {
        const sections = b.sections.map(String).filter((s: string) => SECTION_KEYS.includes(s));
        if (!sections.length) throw new Error("Leave at least one section open.");
        out.sections = sections;
      }
      const hour = (v: unknown) => (v === null || v === "" ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? Number(v) : undefined);
      if (b.dailyMinutes !== undefined) {
        const m = b.dailyMinutes === null || b.dailyMinutes === "" ? null : Math.round(Number(b.dailyMinutes));
        if (m !== null && !(m >= 5 && m <= 24 * 60)) throw new Error("A daily allowance is between 5 minutes and 24 hours.");
        out.daily_minutes = m;
      }
      if (b.allowedFrom !== undefined || b.allowedTo !== undefined) {
        const from = hour(b.allowedFrom), to = hour(b.allowedTo);
        if (from === undefined || to === undefined || (from === null) !== (to === null)) throw new Error("Set both hours (0-23), or neither.");
        out.allowed_from = from; out.allowed_to = to;
      }
      if (b.pin !== undefined) {
        if (b.pin === null || b.pin === "") out.pin_hash = null;
        else if (!validPin(b.pin)) throw new Error("A PIN is 4 to 8 digits.");
        else out.pin_hash = hashPin(b.pin);
      }
      return out;
    };

    // The account holder's view: their profiles, and limits.
    app.get("/api/household", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const [rows, pin] = await Promise.all([
        deps.query<Row>("SELECT * FROM household_profiles WHERE owner_id=$1 ORDER BY created_at ASC", [c.userId]),
        deps.query("SELECT 1 FROM household_parent_pin WHERE owner_id=$1", [c.userId]),
      ]);
      const profiles = (rows ?? []).map(toProfile);
      const used = await Promise.all(profiles.map((p) => usageOf(p.id).then((u) => u.minutes).catch(() => 0)));
      await certsLoaded;
      const videos = deps.media().filter((m) => m.kind === "video");
      const unrated = videos.filter((m) => { const k = keyOf(m); return !k || certs[k] == null || certs[k] < 0; }).length;
      res.setHeader("Cache-Control", "no-store");
      res.json({
        profiles: profiles.map((p, i) => ({ ...publicProfile(p), minutesToday: used[i] })),
        parentPin: !!pin?.length, maxProfiles: deps.maxProfiles(c),
        sections: SECTION_KEYS.map((k) => ({ id: k, label: SECTIONS[k].label })),
        ratings: RATINGS.map(({ id, label }) => ({ id, label })),
        avatars: AVATARS, colours: COLOURS,
        library: { titles: videos.length, unrated, rating },
      });
    });

    app.post("/api/household", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      let f: Record<string, unknown>;
      try { f = readFields(req.body ?? {}, true); } catch (e: any) { return res.status(400).json({ error: e.message }); }
      const count = await deps.query<{ n: string }>("SELECT count(*)::text AS n FROM household_profiles WHERE owner_id=$1", [c.userId]);
      const max = deps.maxProfiles(c);
      if (max != null && Number(count?.[0]?.n ?? 0) >= max) {
        return res.status(402).json({ error: "upgrade_required", feature: "household", message: max === 0 ? "Household profiles aren't part of your plan." : `Your plan includes ${max} profile${max === 1 ? "" : "s"}.` });
      }
      const n = Number(count?.[0]?.n ?? 0);
      f.avatar ??= AVATARS[n % AVATARS.length];
      f.color ??= COLOURS[n % COLOURS.length];
      const id = crypto.randomUUID();
      const cols = ["id", "owner_id", ...Object.keys(f)];
      const r = await deps.query(`INSERT INTO household_profiles (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
        [id, c.userId, ...Object.values(f)]);
      if (!r) return res.status(500).json({ error: "Could not add the profile. Please try again." });
      deps.log("INFO", `Household profile added for ${c.username}: ${f.name}`);
      receipt({ kind: "profile", userId: c.userId, title: `Profile added: ${f.name}`, detail: `Rating ${f.rating ?? "all"}${f.daily_minutes ? `, ${f.daily_minutes} min a day` : ""}` });
      if (f.rating && f.rating !== "all") void rateLibrary();
      res.json({ ok: true, profile: publicProfile((await profileById(id))!) });
    });

    app.patch("/api/household/:id", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const p = await ownProfile(c, req.params.id);
      if (!p) return res.status(404).json({ error: "No such profile." });
      let f: Record<string, unknown>;
      try { f = readFields(req.body ?? {}, false); } catch (e: any) { return res.status(400).json({ error: e.message }); }
      if (!Object.keys(f).length) return res.json({ ok: true, profile: publicProfile(p) });
      const sets = Object.keys(f).map((k, i) => `${k}=$${i + 2}`).join(",");
      await deps.query(`UPDATE household_profiles SET ${sets}, updated_at=NOW() WHERE id=$1`, [p.id, ...Object.values(f)]);
      forget(p.id);
      if (f.rating && f.rating !== "all") void rateLibrary();
      res.json({ ok: true, profile: publicProfile((await profileById(p.id))!) });
    });

    app.delete("/api/household/:id", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const p = await ownProfile(c, req.params.id);
      if (!p) return res.status(404).json({ error: "No such profile." });
      await deps.query("DELETE FROM household_profiles WHERE id=$1", [p.id]);
      await deps.query("DELETE FROM household_usage WHERE profile_id=$1", [p.id]);
      await deps.query("DELETE FROM household_progress WHERE profile_id=$1", [p.id]);
      forget(p.id);
      deps.log("INFO", `Household profile removed for ${c.username}: ${p.name}`);
      receipt({ kind: "profile", userId: c.userId, title: `Profile removed: ${p.name}`, detail: "Its watch history was deleted" });
      res.json({ ok: true });
    });

    // Share link: a new one replaces (and signs out) the old one.
    app.post("/api/household/:id/link", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const p = await ownProfile(c, req.params.id);
      if (!p) return res.status(404).json({ error: "No such profile." });
      const token = crypto.randomBytes(24).toString("base64url");
      await deps.query("UPDATE household_profiles SET share_hash=$2, version=version+1, updated_at=NOW() WHERE id=$1", [p.id, sha(token)]);
      forget(p.id);
      res.json({ ok: true, url: `${deps.publicUrl()}/?profile=${token}` });
    });
    app.delete("/api/household/:id/link", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const p = await ownProfile(c, req.params.id);
      if (!p) return res.status(404).json({ error: "No such profile." });
      await deps.query("UPDATE household_profiles SET share_hash=NULL, version=version+1, updated_at=NOW() WHERE id=$1", [p.id]);
      forget(p.id);
      res.json({ ok: true });
    });
    app.post("/api/household/:id/signout", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const p = await ownProfile(c, req.params.id);
      if (!p) return res.status(404).json({ error: "No such profile." });
      await deps.query("UPDATE household_profiles SET version=version+1, updated_at=NOW() WHERE id=$1", [p.id]);
      forget(p.id);
      res.json({ ok: true });
    });
    app.post("/api/household/:id/reset-time", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const p = await ownProfile(c, req.params.id);
      if (!p) return res.status(404).json({ error: "No such profile." });
      await deps.query("DELETE FROM household_usage WHERE profile_id=$1 AND day=$2", [p.id, today()]);
      usage.delete(p.id);
      res.json({ ok: true });
    });

    app.put("/api/household/parent-pin", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const pin = req.body?.pin;
      if (pin === null || pin === "") {
        await deps.query("DELETE FROM household_parent_pin WHERE owner_id=$1", [c.userId]);
        return res.json({ ok: true, parentPin: false });
      }
      if (!validPin(pin)) return res.status(400).json({ error: "A PIN is 4 to 8 digits." });
      await deps.query(`INSERT INTO household_parent_pin (owner_id, pin_hash) VALUES ($1,$2)
                        ON CONFLICT (owner_id) DO UPDATE SET pin_hash=$2, updated_at=NOW()`, [c.userId, hashPin(pin)]);
      res.json({ ok: true, parentPin: true });
    });

    // Picker: choosing the account itself on a shared device asks for the parent PIN.
    app.post("/api/household/parent-pin/check", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const key = `parent:${c.userId}`;
      if (tooMany(key)) return res.status(429).json({ error: "Too many wrong PINs. Try again in a few minutes." });
      const pin = await deps.query<{ pin_hash: string }>("SELECT pin_hash FROM household_parent_pin WHERE owner_id=$1", [c.userId]);
      if (!pin?.[0]) return res.json({ ok: true });
      if (!pinMatches(String(req.body?.pin ?? ""), pin[0].pin_hash)) { failed(key); return res.status(401).json({ error: "That parent PIN isn't right.", field: "pin" }); }
      res.json({ ok: true });
    });

    // Picker: the account holder's device switches to a profile.
    app.post("/api/household/:id/enter", async (req, res) => {
      const c = await owner(req, res);
      if (!c) return;
      const p = await ownProfile(c, req.params.id);
      if (!p) return res.status(404).json({ error: "No such profile." });
      const key = `pin:${p.id}`;
      if (p.hasPin) {
        if (tooMany(key)) return res.status(429).json({ error: "Too many wrong PINs. Try again in a few minutes." });
        const row = await deps.query<{ pin_hash: string }>("SELECT pin_hash FROM household_profiles WHERE id=$1", [p.id]);
        if (!pinMatches(String(req.body?.pin ?? ""), row?.[0]?.pin_hash ?? null)) { failed(key); return res.status(401).json({ error: "That PIN isn't right.", field: "pin" }); }
      }
      const token = profileToken(p, c.username ?? "", "picker");
      deps.setSessionCookie(req, res, token);
      res.json({ ok: true, token, profile: publicProfile(p) });
    });

    // Picker: back to the account. Needs the parent PIN when one is set; a
    // session from a shared link can only sign out.
    app.post("/api/household/exit", async (req, res) => {
      const c = await deps.callerOf(req);
      if (!c.profile || !c.userId) return res.status(400).json({ error: "You're not in a profile." });
      if (c.profile.via === "link") {
        deps.setSessionCookie(req, res, null);
        return res.json({ ok: true, signOut: true });
      }
      const pin = await deps.query<{ pin_hash: string }>("SELECT pin_hash FROM household_parent_pin WHERE owner_id=$1", [c.userId]);
      if (!pin) return res.status(503).json({ error: "Try again in a minute." });
      if (pin[0]) {
        const key = `parent:${c.userId}`;
        if (tooMany(key)) return res.status(429).json({ error: "Too many wrong PINs. Try again in a few minutes." });
        if (!pinMatches(String(req.body?.pin ?? ""), pin[0].pin_hash)) { failed(key); return res.status(401).json({ error: "That parent PIN isn't right.", field: "pin", needPin: true }); }
      }
      res.json({ ok: true, token: deps.sessionFor(req, res, { id: c.userId, username: c.username ?? "" }) });
    });

    // A shared link signs this device in as that profile only.
    app.post("/api/household/link", async (req, res) => {
      const token = String(req.body?.token ?? "").trim();
      const ip = String(req.headers["cf-connecting-ip"] ?? req.ip ?? "");
      if (tooMany(`link:${ip}`)) return res.status(429).json({ error: "Too many tries. Wait a few minutes." });
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(token) || !(await ensureSchema())) { failed(`link:${ip}`); return res.status(404).json({ error: "This profile link isn't valid any more. Ask for a new one." }); }
      const rows = await deps.query<Row & { username: string }>(
        "SELECT h.*, u.username FROM household_profiles h JOIN users u ON u.id = h.owner_id WHERE h.share_hash=$1", [sha(token)]);
      if (!rows?.[0]) { failed(`link:${ip}`); return res.status(404).json({ error: "This profile link isn't valid any more. Ask for a new one." }); }
      const p = toProfile(rows[0]);
      const t = profileToken(p, rows[0].username, "link");
      deps.setSessionCookie(req, res, t);
      deps.log("INFO", `Profile link used: ${p.name} (${rows[0].username})`);
      receipt({ kind: "profile", userId: p.ownerId, title: `A device signed in with ${p.name}'s link`, detail: `From ${ip || "unknown address"}` });
      res.json({ ok: true, token: t, profile: { name: p.name, avatar: p.avatar, color: p.color } });
    });

    // Either kind of session: who am I, and how much time is left.
    app.get("/api/household/me", async (req, res) => {
      const c = await deps.callerOf(req);
      if (!c.authed) return res.status(401).json({ error: "Sign in first." });
      res.setHeader("Cache-Control", "no-store");
      if (!c.profile) {
        if (!c.userId || c.host || !(await ensureSchema())) return res.json({ profile: null, profiles: [] });
        const [rows, pin] = await Promise.all([
          deps.query<Row>("SELECT * FROM household_profiles WHERE owner_id=$1 ORDER BY created_at ASC", [c.userId]),
          deps.query("SELECT 1 FROM household_parent_pin WHERE owner_id=$1", [c.userId]),
        ]);
        return res.json({ profile: null, parentPin: !!pin?.length, profiles: (rows ?? []).map((r) => {
          const p = toProfile(r);
          return { id: p.id, name: p.name, avatar: p.avatar, color: p.color, hasPin: p.hasPin };
        }) });
      }
      const p = await profileById(c.profile.id);
      if (!p) return res.status(401).json({ error: "This profile was signed out.", code: "session_expired" });
      const u = await usageOf(p.id);
      const t = timeState(p, u.minutes);
      const pin = c.profile.via === "link" ? null : await deps.query("SELECT 1 FROM household_parent_pin WHERE owner_id=$1", [c.userId]);
      res.json({
        profile: { ...publicProfile(p), via: c.profile.via },
        minutesToday: u.minutes, minutesLeft: p.dailyMinutes == null ? null : Math.max(0, p.dailyMinutes - u.minutes),
        ...t, exitNeedsPin: !!pin?.length,
      });
    });

    // Sent by the app once a minute while someone is actually using it.
    app.post("/api/household/heartbeat", async (req, res) => {
      const c = await deps.callerOf(req);
      if (!c.profile) return res.json({ ok: true });
      const p = await profileById(c.profile.id);
      if (!p) return res.status(401).json({ error: "This profile was signed out.", code: "session_expired" });
      const u = req.body?.active ? await countMinute(p.id) : await usageOf(p.id);
      res.json({ ok: true, minutesToday: u.minutes, minutesLeft: p.dailyMinutes == null ? null : Math.max(0, p.dailyMinutes - u.minutes), ...timeState(p, u.minutes) });
    });

    // ── Stand-ins for account-wide routes, for profile sessions ───────────
    app.get("/api/auth/me", async (req, res, next) => {
      const c = await deps.callerOf(req);
      if (!c.profile || !c.userId) return next();
      res.json({ user: {
        id: c.userId, uid: c.userId, username: c.username, displayName: c.profile.name, display_name: c.profile.name,
        role: "user", permissions: [], avatar: c.profile.avatar, avatar_color: c.profile.color,
        media_access: c.media, games_access: c.games, can_upload_media: false, user_tier: c.tier,
        profile: { id: c.profile.id, name: c.profile.name, via: c.profile.via },
      } });
    });
    app.post("/api/auth/refresh", async (req, res, next) => {
      const c = await deps.callerOf(req);
      if (!c.profile) return next();
      const p = await profileById(c.profile.id);
      if (!p) return res.status(401).json({ error: "This profile was signed out.", code: "session_expired" });
      const t = profileToken(p, c.username ?? "", c.profile.via);
      deps.setSessionCookie(req, res, t);
      res.json({ token: t });
    });
    // Each profile keeps its own "continue watching".
    app.get("/api/media/progress", async (req, res, next) => {
      const c = await deps.callerOf(req);
      if (!c.profile) return next();
      const r = await deps.query("SELECT rel_path, title, watch_time, duration, ended, updated_at FROM household_progress WHERE profile_id=$1 ORDER BY updated_at DESC LIMIT 200", [c.profile.id]);
      if (!r) return res.status(503).json({ error: "DB unavailable" });
      res.json({ items: r.map((row: any) => ({ relPath: row.rel_path, title: row.title, currentTime: row.watch_time, duration: row.duration, ended: row.ended, updatedAt: Number(row.updated_at) })) });
    });
    app.put("/api/media/progress", async (req, res, next) => {
      const c = await deps.callerOf(req);
      if (!c.profile) return next();
      const b = req.body ?? {};
      if (!b.relPath) return res.status(400).json({ error: "relPath required" });
      await deps.query(
        `INSERT INTO household_progress (profile_id, rel_path, title, watch_time, duration, ended, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (profile_id, rel_path) DO UPDATE SET title=$3, watch_time=$4, duration=$5, ended=$6, updated_at=$7`,
        [c.profile.id, String(b.relPath), String(b.title ?? ""), Math.floor(Number(b.currentTime) || 0), Math.floor(Number(b.duration) || 0), !!b.ended, Date.now()]);
      res.json({ ok: true });
    });

    // The library, without what is above a capped profile's rating.
    app.use(async (req, res, next) => {
      if (req.method !== "GET" || !/^\/api\/media\/(library|recommendations|continue-watching)$/.test(req.path)) return next();
      const c = await deps.callerOf(req).catch(() => null);
      const p = c?.profile ? await profileById(c.profile.id) : null;
      if (!p || p.maxLevel == null) return next();
      await certsLoaded;
      const keep = (x: any) => !(x && typeof x === "object" && (x.relPath || x.rel_path) && !allowedItem(p, itemByRel(String(x.relPath ?? x.rel_path))));
      const send = res.json.bind(res);
      res.json = ((body: any) => {
        if (Array.isArray(body)) return send(body.filter(keep));
        if (body && typeof body === "object") {
          const out = { ...body };
          for (const k of ["items", "results", "recommendations", "movies", "series"]) if (Array.isArray(out[k])) out[k] = out[k].filter(keep);
          if (Array.isArray(out.items)) {
            const v = out.items.filter((m: any) => m.kind === "video");
            out.videos = v.length;
            out.movies = v.filter((m: any) => m.category === "movie").length;
            out.seriesEpisodes = v.filter((m: any) => m.category === "series").length;
            out.total = out.items.length;
          }
          return send(out);
        }
        return send(body);
      }) as typeof res.json;
      next();
    });
  }

  return { register, gate, profileOf: profileById, rateLibrary };
}
