/**
 * Plans: tiers the admin creates, and which features sit behind them.
 *
 * Out of the box nothing is gated and there is one free tier, so every
 * feature is available to everyone. In the admin dashboard (Plans tab) the
 * admin can create tiers (name, price, limits, perks, a checkout link) and
 * tick which features need which tiers. A feature that is not gated is free.
 *
 * What a tier can gate is a feature of the software, listed in FEATURES with
 * the app tabs and API paths that belong to it. A tier never grants the
 * host's own films, ROMs or BIOS files: those are per-person grants (see
 * access.ts), because that library cannot be sold.
 *
 * There is no payment processor here. A tier can carry a checkout link
 * (PayFast, Yoco, PayPal.me, ...) and members can ask for an upgrade; an admin
 * confirms the payment and assigns the tier, optionally with an end date.
 */
import type express from "express";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Caller } from "./access.ts";
import { receipt } from "./receipts.ts";

export type FeatureDef = {
  key: string; label: string; category: "Media" | "Games" | "Cloud" | "Extras";
  description: string;
  /** App tabs that show an upgrade screen when the feature is locked. */
  tabs: string[];
  /** API paths refused with 402 when the feature is locked. */
  api: Array<string | RegExp>;
};

export const FEATURES: FeatureDef[] = [
  { key: "media.watch", label: "Movies & TV", category: "Media",
    description: "Stream films and shows, with resume, subtitles and adaptive quality.",
    tabs: ["media"], api: ["/api/media/library", "/api/media/hls/", "/api/media/stream", "/api/watch/"] },
  { key: "media.discover", label: "Discover & What to Watch", category: "Media",
    description: "Mood-based picks, trending titles and recommendations.",
    tabs: ["discover", "matchmaker"], api: ["/api/discover/", "/api/taste"] },
  { key: "media.requests", label: "Request movies & shows", category: "Media",
    description: "Search for a title and ask the host to add it.",
    tabs: ["torrent"], api: [/^\/api\/arr\/(search|add|add-seasons|series\/lookup)/, "/api/torrent/add", "/api/torrent/preview"] },
  { key: "media.party", label: "Watch Party", category: "Media",
    description: "Watch in sync with friends, with chat.",
    tabs: ["party"], api: ["/api/watch-party/"] },
  { key: "music", label: "Music", category: "Media",
    description: "Play the music library, build playlists, upload tracks.",
    tabs: ["playlists"], api: ["/api/music/collection", "/api/music/stream", "/api/music/playlists", "/api/music/upload-track", "/api/music/discover"] },
  { key: "books", label: "Books & comics", category: "Media",
    description: "Read ebooks, comics and PDFs in the browser.",
    tabs: ["codex"], api: ["/api/codex/"] },
  { key: "photos", label: "Photos", category: "Media",
    description: "Private photo albums and galleries.",
    tabs: ["photos", "gallery"], api: ["/api/photos/albums"] },

  { key: "games.library", label: "Game library", category: "Games",
    description: "Browse and launch console games with art, playtime and saves.",
    tabs: ["library", "consoles"], api: [/^\/api\/games\/[^/]+\/(download|download-rom)/, "/api/games/launch"] },
  { key: "games.full", label: "Every console, on any screen", category: "Games",
    description: "PS2, GameCube, PS3, Switch and PSP games through the desktop app, and playing on the host PC from a phone or TV. Without it, the retro systems play in the browser.",
    // Downloads of those games are checked per game (planlimits.ts); these are whole routes.
    tabs: [], api: [/^\/api\/games\/launch$/, /^\/api\/stream\/(start|hls\/start)$/] },
  { key: "games.pc", label: "PC games", category: "Games",
    description: "Steam, Epic and GOG libraries in one place.",
    tabs: ["pcgames"], api: ["/api/pc-games/", "/api/steam/"] },
  { key: "games.multiplayer", label: "Multiplayer", category: "Games",
    description: "Netplay lobbies and co-op sessions with friends.",
    tabs: ["handheld"], api: ["/api/multiplayer/", "/api/coop/", "/api/remote-play/", /^\/api\/stream\/(start|hls\/start)$/] },
  { key: "games.saves", label: "Cloud saves", category: "Games",
    description: "Save states and progress that follow you between devices.",
    tabs: [], api: ["/api/emulator/savestates/", /^\/api\/profiles\/[^/]+\/saves/] },
  { key: "games.manuals", label: "Game manuals", category: "Games",
    description: "Scanned manuals and guides next to each game.",
    tabs: ["manual"], api: ["/api/manual-library"] },

  { key: "cloud.files", label: "Files & uploads", category: "Cloud",
    description: "Upload, organise, stream and download your own files.",
    tabs: ["files", "myfiles"], api: ["/api/files/", "/api/storage/upload", "/api/storage/files"] },
  { key: "cloud.drives", label: "Connect your own cloud drive", category: "Cloud",
    description: "Link a Google Drive or WebDAV drive and manage its files in the app.",
    tabs: [], api: ["/api/drives/my/", "/api/drives/connect/"] },
  { key: "cloud.backup", label: "Phone backup", category: "Cloud",
    description: "Back up photos and videos from a phone.",
    tabs: ["phonebackup"], api: ["/api/phone/"] },

  { key: "ai", label: "AI assistant", category: "Extras",
    description: "Ask for recommendations, game guides and help in plain language.",
    tabs: [], api: [/^\/api\/ai\/(chat|navigate|guide|scrape)$/, "/api/games/recommendations", /^\/api\/codex\/books\/[^/]+\/ask$/] },
  { key: "spatial", label: "Spatial view", category: "Extras",
    description: "The 3D shelf view of the library.",
    tabs: ["spatial"], api: [] },
  { key: "hosting", label: "Become a host", category: "Extras",
    description: "List your own host and invite people to it.",
    tabs: ["become-host"], api: [/^\/api\/hosts\/(profile|invites)$/] },
];
const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

export type Tier = {
  id: string; name: string; tagline: string; priceCents: number; currency: string;
  period: "free" | "month" | "year" | "once";
  color: string; badge: string; sortOrder: number; isDefault: boolean; isPublic: boolean;
  storageLimitGb: number | null; maxStreams: number | null; maxQuality: string | null;
  /** Household profiles an account may add (null: no limit). */
  maxProfiles: number | null;
  /** A welcome allowance: introStreams at once for the first introDays after sign-up. */
  introStreams: number | null; introDays: number | null;
  checkoutUrl: string; perks: string[];
};
type Gate = { gated: boolean; tiers: string[] };
type State = { tiers: Tier[]; gates: Record<string, Gate> };

export type TiersDeps = {
  persistDir: string;
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[] | null>;
  dbUp: () => boolean;
  callerOf: (req: express.Request) => Promise<Caller>;
  invalidateUser: (userId?: string) => void;
  log: (level: string, msg: string) => void;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS plan_tiers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'ZAR',
    period TEXT NOT NULL DEFAULT 'month', color TEXT NOT NULL DEFAULT '#22d3ee', badge TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0, is_default BOOLEAN NOT NULL DEFAULT FALSE, is_public BOOLEAN NOT NULL DEFAULT TRUE,
    storage_limit_gb INTEGER, max_streams INTEGER, max_quality TEXT, checkout_url TEXT NOT NULL DEFAULT '',
    perks JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS plan_feature_gates (
    feature_key TEXT PRIMARY KEY, gated BOOLEAN NOT NULL DEFAULT FALSE, tier_ids TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS plan_upgrade_requests (
    id BIGSERIAL PRIMARY KEY, user_id UUID NOT NULL, tier_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ, resolved_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_plan_upgrade_requests_status ON plan_upgrade_requests(status, created_at DESC);
  ALTER TABLE plan_tiers ADD COLUMN IF NOT EXISTS max_profiles INTEGER;
  ALTER TABLE plan_tiers ADD COLUMN IF NOT EXISTS intro_streams INTEGER;
  ALTER TABLE plan_tiers ADD COLUMN IF NOT EXISTS intro_days INTEGER;
`;

// users.user_tier already holds free / pro / unlimited for the existing
// accounts, so those ids are seeded. Only "free" is on show; the other two
// are drafts for the admin to price, rename or delete.
const SEED: Tier[] = [
  { id: "free", name: "Free", tagline: "Everything you need to get started", priceCents: 0, currency: "ZAR", period: "free",
    color: "#94a3b8", badge: "", sortOrder: 0, isDefault: true, isPublic: true, storageLimitGb: null, maxStreams: null,
    maxQuality: null, maxProfiles: null, introStreams: null, introDays: null, checkoutUrl: "", perks: [] },
  { id: "pro", name: "Pro", tagline: "", priceCents: 0, currency: "ZAR", period: "month",
    color: "#22d3ee", badge: "", sortOrder: 1, isDefault: false, isPublic: false, storageLimitGb: null, maxStreams: null,
    maxQuality: null, maxProfiles: null, introStreams: null, introDays: null, checkoutUrl: "", perks: [] },
  { id: "unlimited", name: "Unlimited", tagline: "", priceCents: 0, currency: "ZAR", period: "month",
    color: "#a855f7", badge: "", sortOrder: 2, isDefault: false, isPublic: false, storageLimitGb: null, maxStreams: null,
    maxQuality: null, maxProfiles: null, introStreams: null, introDays: null, checkoutUrl: "", perks: [] },
];

const rowToTier = (r: any): Tier => ({
  id: r.id, name: r.name, tagline: r.tagline ?? "", priceCents: Number(r.price_cents) || 0, currency: r.currency || "ZAR",
  period: (["free", "month", "year", "once"].includes(r.period) ? r.period : "month") as Tier["period"],
  color: r.color || "#22d3ee", badge: r.badge ?? "", sortOrder: Number(r.sort_order) || 0,
  isDefault: !!r.is_default, isPublic: !!r.is_public,
  storageLimitGb: r.storage_limit_gb == null ? null : Number(r.storage_limit_gb),
  maxStreams: r.max_streams == null ? null : Number(r.max_streams),
  maxQuality: r.max_quality || null, checkoutUrl: r.checkout_url ?? "",
  maxProfiles: r.max_profiles == null ? null : Number(r.max_profiles),
  introStreams: r.intro_streams == null ? null : Number(r.intro_streams),
  introDays: r.intro_days == null ? null : Number(r.intro_days),
  perks: Array.isArray(r.perks) ? r.perks.map(String) : [],
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

export function createTiers(deps: TiersDeps) {
  const cacheFile = path.join(deps.persistDir, "plans.json");
  let state: State = { tiers: SEED, gates: {} };
  let loaded = false;
  let schemaReady = false;

  async function ensureSchema(): Promise<boolean> {
    if (schemaReady) return true;
    if (!deps.dbUp()) return false;
    if (!(await deps.query(SCHEMA))) return false;
    const count = await deps.query<{ n: string }>("SELECT count(*)::text AS n FROM plan_tiers");
    if (count && Number(count[0]?.n) === 0) {
      for (const t of SEED) {
        await deps.query(
          `INSERT INTO plan_tiers (id, name, tagline, price_cents, currency, period, color, sort_order, is_default, is_public)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [t.id, t.name, t.tagline, t.priceCents, t.currency, t.period, t.color, t.sortOrder, t.isDefault, t.isPublic]);
      }
    }
    schemaReady = true;
    return true;
  }

  // One load at a time: every request that arrived before the first load
  // finished used to start its own, and they queued behind each other's
  // schema statements (17 s for the first /api/plans/me after a restart).
  let loadingNow: Promise<void> | null = null;
  function load(): Promise<void> {
    loadingNow ??= loadOnce().finally(() => { loadingNow = null; });
    return loadingNow;
  }
  /** For request handlers: wait briefly for the first load, then answer with what there is. */
  const ready = () => (loaded ? Promise.resolve() : Promise.race([load().catch(() => {}), new Promise<void>((r) => setTimeout(r, 2000))]));
  async function loadOnce(): Promise<void> {
    if (await ensureSchema()) {
      const [tiers, gates] = await Promise.all([
        deps.query("SELECT * FROM plan_tiers ORDER BY sort_order ASC, price_cents ASC, name ASC"),
        deps.query("SELECT feature_key, gated, tier_ids FROM plan_feature_gates"),
      ]);
      if (tiers && gates && tiers.length) {
        const next: State = { tiers: tiers.map(rowToTier), gates: {} };
        if (!next.tiers.some((t) => t.isDefault)) next.tiers[0].isDefault = true;
        for (const g of gates) next.gates[g.feature_key] = { gated: !!g.gated, tiers: g.tier_ids ?? [] };
        state = next;
        loaded = true;
        writeFile(cacheFile, JSON.stringify(state)).catch(() => {});
        return;
      }
    }
    // Database not reachable yet: use the last saved copy so gates survive a
    // cold start instead of silently opening up.
    if (!loaded) {
      try {
        const saved = JSON.parse(await readFile(cacheFile, "utf8")) as State;
        if (Array.isArray(saved?.tiers) && saved.tiers.length) state = saved;
      } catch { /* first run */ }
    }
  }
  // Retried until the database has answered once, then refreshed occasionally
  // so a second host process or a manual DB edit is picked up.
  const timer = setInterval(() => { if (!loaded || Math.random() < 0.1) void load().catch(() => {}); }, 30_000);
  timer.unref?.();
  void load().catch(() => {});

  const defaultTier = () => state.tiers.find((t) => t.isDefault) ?? state.tiers[0];
  function tierOf(caller: Caller): Tier {
    const expired = caller.tierExpiresAt != null && caller.tierExpiresAt < Date.now();
    return (!expired && state.tiers.find((t) => t.id === caller.tier)) || defaultTier();
  }
  function allowed(caller: Caller, featureKey: string): boolean {
    if (caller.admin) return true;
    const g = state.gates[featureKey];
    if (!g?.gated) return true;
    return g.tiers.includes(tierOf(caller).id);
  }
  const anyGate = () => Object.values(state.gates).some((g) => g.gated);
  const matches = (pattern: string | RegExp, p: string) =>
    typeof pattern === "string" ? p === pattern || p.startsWith(pattern) : pattern.test(p);

  /** For access.ts: the locked feature behind a path, or null. */
  function featureGate(caller: Caller, _method: string, p: string) {
    if (!anyGate()) return null;
    for (const f of FEATURES) {
      if (!state.gates[f.key]?.gated) continue;
      if (!f.api.some((a) => matches(a, p))) continue;
      if (allowed(caller, f.key)) return null;
      const names = state.gates[f.key].tiers.map((id) => state.tiers.find((t) => t.id === id)?.name).filter(Boolean) as string[];
      return { feature: f.key, label: f.label, tiers: names };
    }
    return null;
  }

  const publicFeatures = () => FEATURES.map((f) => ({
    key: f.key, label: f.label, category: f.category, description: f.description, tabs: f.tabs,
    gated: !!state.gates[f.key]?.gated, tiers: state.gates[f.key]?.gated ? state.gates[f.key].tiers : [],
  }));

  function register(app: express.Express) {
    const adminOnly = async (req: express.Request, res: express.Response): Promise<Caller | null> => {
      const caller = await deps.callerOf(req);
      if (!caller.admin) { res.status(403).json({ error: "admin_only", message: "Only the host's admins can do this." }); return null; }
      if (!(await ensureSchema())) { res.status(503).json({ error: "The database is not reachable right now. Try again in a minute." }); return null; }
      return caller;
    };

    // Pricing page. Public so a visitor can see the plans before signing up.
    app.get("/api/plans", async (_req, res) => {
      await ready();
      res.setHeader("Cache-Control", "no-store");
      res.json({ tiers: state.tiers.filter((t) => t.isPublic || t.isDefault), features: publicFeatures() });
    });

    app.get("/api/plans/me", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed) return res.status(401).json({ error: "Authentication required" });
      await ready();
      const tier = tierOf(caller);
      const features: Record<string, boolean> = {};
      const lockedTabs: Record<string, { feature: string; label: string; tiers: string[] }> = {};
      for (const f of FEATURES) {
        features[f.key] = allowed(caller, f.key);
        if (features[f.key]) continue;
        const names = (state.gates[f.key]?.tiers ?? []).map((id) => state.tiers.find((t) => t.id === id)?.name).filter(Boolean) as string[];
        for (const t of f.tabs) lockedTabs[t] = { feature: f.key, label: f.label, tiers: names };
      }
      // Only the Plans page needs this; the tab gate asks on every page load.
      let pending: any = null;
      if (req.query.pending === "1" && caller.userId && deps.dbUp()) {
        const r = await deps.query("SELECT id, tier_id, created_at FROM plan_upgrade_requests WHERE user_id::text=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1", [caller.userId]);
        pending = r?.[0] ?? null;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        tier, expiresAt: caller.tierExpiresAt && tier.id === caller.tier ? caller.tierExpiresAt : null,
        isAdmin: caller.admin, features, lockedTabs,
        // A household profile (household.ts): which tabs it may open.
        profile: caller.profile ? { id: caller.profile.id, name: caller.profile.name, avatar: caller.profile.avatar, color: caller.profile.color,
          tabs: caller.profile.tabs, via: caller.profile.via } : null,
        access: { media: caller.media, games: caller.games, upload: caller.upload },
        pendingRequest: pending,
      });
    });

    app.post("/api/plans/request", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed || !caller.userId) return res.status(401).json({ error: "Sign in with an account to ask for an upgrade." });
      if (!(await ensureSchema())) return res.status(503).json({ error: "Upgrades are unavailable right now. Try again in a minute." });
      const tierId = String(req.body?.tierId ?? "");
      const tier = state.tiers.find((t) => t.id === tierId);
      if (!tier) return res.status(404).json({ error: "That plan no longer exists." });
      if (tierOf(caller).id === tier.id) return res.status(400).json({ error: `You are already on ${tier.name}.` });
      const note = String(req.body?.note ?? "").trim().slice(0, 500);
      await deps.query("UPDATE plan_upgrade_requests SET status='superseded', resolved_at=NOW() WHERE user_id::text=$1 AND status='pending'", [caller.userId]);
      const r = await deps.query("INSERT INTO plan_upgrade_requests (user_id, tier_id, note) VALUES ($1::uuid,$2,$3) RETURNING id", [caller.userId, tier.id, note]);
      if (!r) return res.status(500).json({ error: "Could not save your request. Please try again." });
      deps.log("INFO", `Upgrade request: ${caller.username} -> ${tier.name}`);
      res.json({ ok: true, id: r[0].id, checkoutUrl: tier.checkoutUrl || null });
    });

    // ── Admin ────────────────────────────────────────────────────────────
    app.get("/api/admin/plans", async (req, res) => {
      if (!(await adminOnly(req, res))) return;
      await load().catch(() => {});
      const [users, requests] = await Promise.all([
        deps.query(`SELECT id, username, display_name, email, role, user_tier, tier_expires_at, media_access, games_access,
                           can_upload_media, created_at, last_seen FROM users ORDER BY created_at DESC LIMIT 2000`),
        deps.query(`SELECT r.id, r.user_id, r.tier_id, r.note, r.status, r.created_at, u.username, u.display_name, u.user_tier
                      FROM plan_upgrade_requests r JOIN users u ON u.id = r.user_id
                     WHERE r.status = 'pending' ORDER BY r.created_at ASC LIMIT 200`),
      ]);
      const counts: Record<string, number> = {};
      const def = defaultTier().id;
      for (const u of users ?? []) {
        const expired = u.tier_expires_at && new Date(u.tier_expires_at).getTime() < Date.now();
        const id = !expired && state.tiers.some((t) => t.id === u.user_tier) ? u.user_tier : def;
        counts[id] = (counts[id] ?? 0) + 1;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ tiers: state.tiers, features: publicFeatures(), users: users ?? [], requests: requests ?? [], counts });
    });

    const tierFields = (b: any) => {
      const out: Record<string, unknown> = {};
      const text = (k: string, col: string, max: number) => { if (typeof b[k] === "string") out[col] = b[k].trim().slice(0, max); };
      const intOrNull = (k: string, col: string, max: number) => {
        if (b[k] === null || b[k] === "") out[col] = null;
        else if (b[k] !== undefined && Number.isFinite(Number(b[k]))) out[col] = Math.max(0, Math.min(max, Math.round(Number(b[k]))));
      };
      text("name", "name", 40); text("tagline", "tagline", 120); text("badge", "badge", 24);
      if (typeof b.currency === "string" && /^[A-Za-z]{3}$/.test(b.currency.trim())) out.currency = b.currency.trim().toUpperCase();
      if (["free", "month", "year", "once"].includes(b.period)) out.period = b.period;
      if (typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color)) out.color = b.color;
      if (b.priceCents !== undefined && Number.isFinite(Number(b.priceCents))) out.price_cents = Math.max(0, Math.min(100_000_000, Math.round(Number(b.priceCents))));
      intOrNull("sortOrder", "sort_order", 1000);
      if (out.sort_order === null) delete out.sort_order;
      if (typeof b.isPublic === "boolean") out.is_public = b.isPublic;
      intOrNull("storageLimitGb", "storage_limit_gb", 1_000_000);
      intOrNull("maxStreams", "max_streams", 100);
      intOrNull("maxProfiles", "max_profiles", 50);
      intOrNull("introStreams", "intro_streams", 100);
      intOrNull("introDays", "intro_days", 3650);
      if (b.maxQuality === null || b.maxQuality === "") out.max_quality = null;
      else if (["480p", "720p", "1080p", "4k"].includes(b.maxQuality)) out.max_quality = b.maxQuality;
      if (typeof b.checkoutUrl === "string") {
        const u = b.checkoutUrl.trim().slice(0, 500);
        if (u && !/^https:\/\//i.test(u)) throw new Error("The checkout link must start with https://");
        out.checkout_url = u;
      }
      if (Array.isArray(b.perks)) out.perks = JSON.stringify(b.perks.map((p: unknown) => String(p).trim().slice(0, 120)).filter(Boolean).slice(0, 12));
      return out;
    };

    app.post("/api/admin/plans/tiers", async (req, res) => {
      if (!(await adminOnly(req, res))) return;
      let fields: Record<string, unknown>;
      try { fields = tierFields(req.body ?? {}); } catch (e: any) { return res.status(400).json({ error: e.message }); }
      const name = String(fields.name ?? "");
      if (!name) return res.status(400).json({ error: "Give the tier a name." });
      let id = slug(name) || "tier";
      for (let n = 2; state.tiers.some((t) => t.id === id); n++) id = `${slug(name) || "tier"}-${n}`;
      if (fields.sort_order === undefined) fields.sort_order = Math.max(0, ...state.tiers.map((t) => t.sortOrder)) + 1;
      const cols = ["id", ...Object.keys(fields)];
      const r = await deps.query(
        `INSERT INTO plan_tiers (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
        [id, ...Object.values(fields)]);
      if (!r) return res.status(500).json({ error: "Could not create the tier." });
      await load();
      deps.log("INFO", `Tier created: ${name}`);
      res.json({ ok: true, tier: state.tiers.find((t) => t.id === id) });
    });

    app.patch("/api/admin/plans/tiers/:id", async (req, res) => {
      if (!(await adminOnly(req, res))) return;
      const id = req.params.id;
      if (!state.tiers.some((t) => t.id === id)) return res.status(404).json({ error: "No such tier." });
      let fields: Record<string, unknown>;
      try { fields = tierFields(req.body ?? {}); } catch (e: any) { return res.status(400).json({ error: e.message }); }
      if (fields.name === "") return res.status(400).json({ error: "A tier needs a name." });
      if (req.body?.isDefault === true) {
        await deps.query("UPDATE plan_tiers SET is_default = (id = $1)", [id]);
      }
      const keys = Object.keys(fields);
      if (keys.length) {
        const r = await deps.query(
          `UPDATE plan_tiers SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(", ")}, updated_at=NOW() WHERE id=$1 RETURNING id`,
          [id, ...Object.values(fields)]);
        if (!r) return res.status(500).json({ error: "Could not save the tier." });
      }
      await load();
      res.json({ ok: true, tier: state.tiers.find((t) => t.id === id) });
    });

    app.delete("/api/admin/plans/tiers/:id", async (req, res) => {
      if (!(await adminOnly(req, res))) return;
      const tier = state.tiers.find((t) => t.id === req.params.id);
      if (!tier) return res.status(404).json({ error: "No such tier." });
      if (tier.isDefault) return res.status(400).json({ error: "Make another tier the default before deleting this one." });
      const def = defaultTier().id;
      // Members on the deleted tier fall back to the default one.
      const moved = await deps.query("UPDATE users SET user_tier=$1, tier_expires_at=NULL WHERE user_tier=$2 RETURNING id", [def, tier.id]);
      await deps.query("UPDATE plan_feature_gates SET tier_ids = array_remove(tier_ids, $1)", [tier.id]);
      await deps.query("UPDATE plan_upgrade_requests SET status='superseded', resolved_at=NOW() WHERE tier_id=$1 AND status='pending'", [tier.id]);
      await deps.query("DELETE FROM plan_tiers WHERE id=$1", [tier.id]);
      deps.invalidateUser();
      await load();
      deps.log("INFO", `Tier deleted: ${tier.name} (${moved?.length ?? 0} member(s) moved to ${def})`);
      res.json({ ok: true, moved: moved?.length ?? 0 });
    });

    app.put("/api/admin/plans/features/:key", async (req, res) => {
      if (!(await adminOnly(req, res))) return;
      const f = FEATURE_BY_KEY.get(req.params.key);
      if (!f) return res.status(404).json({ error: "No such feature." });
      const tiers = (Array.isArray(req.body?.tiers) ? req.body.tiers : []).map(String).filter((id: string) => state.tiers.some((t) => t.id === id));
      const gated = !!req.body?.gated;
      const r = await deps.query(
        `INSERT INTO plan_feature_gates (feature_key, gated, tier_ids) VALUES ($1,$2,$3)
         ON CONFLICT (feature_key) DO UPDATE SET gated=EXCLUDED.gated, tier_ids=EXCLUDED.tier_ids, updated_at=NOW() RETURNING feature_key`,
        [f.key, gated, tiers]);
      if (!r) return res.status(500).json({ error: "Could not save." });
      await load();
      deps.log("INFO", `Feature ${f.key}: ${gated ? `needs ${tiers.join(", ") || "(no tier)"}` : "free for everyone"}`);
      res.json({ ok: true, features: publicFeatures() });
    });

    app.put("/api/admin/plans/users/:id", async (req, res) => {
      const admin = await adminOnly(req, res);
      if (!admin) return;
      const b = req.body ?? {};
      const sets: string[] = [];
      const vals: unknown[] = [req.params.id];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
      if (b.tier !== undefined) {
        if (!state.tiers.some((t) => t.id === b.tier)) return res.status(400).json({ error: "No such tier." });
        set("user_tier", b.tier);
        if (b.expiresAt === undefined) set("tier_expires_at", null);
      }
      if (b.expiresAt !== undefined) {
        const d = b.expiresAt ? new Date(b.expiresAt) : null;
        if (d && Number.isNaN(d.getTime())) return res.status(400).json({ error: "That end date is not valid." });
        set("tier_expires_at", d);
      }
      if (typeof b.media_access === "boolean") set("media_access", b.media_access);
      if (b.games_access === null || typeof b.games_access === "boolean") set("games_access", b.games_access);
      if (typeof b.can_upload_media === "boolean") set("can_upload_media", b.can_upload_media);
      if (!sets.length) return res.status(400).json({ error: "Nothing to change." });
      const r = await deps.query(
        `UPDATE users SET ${sets.join(", ")} WHERE id::text=$1
         RETURNING id, username, display_name, email, role, user_tier, tier_expires_at, media_access, games_access, can_upload_media, created_at, last_seen`, vals);
      if (!r) return res.status(500).json({ error: "Could not save." });
      if (!r.length) return res.status(404).json({ error: "No such user." });
      deps.invalidateUser(req.params.id);
      deps.log("INFO", `${admin.username ?? "admin"} updated ${r[0].username}: ${sets.map((s) => s.split("=")[0]).join(", ")}`);
      receipt({ kind: "plan", userId: String(r[0].id), actor: admin.username, title: `${r[0].username}: ${sets.map((s) => s.split("=")[0].replace(/_/g, " ")).join(", ")} changed`, detail: `Plan ${r[0].user_tier ?? "default"}${r[0].tier_expires_at ? ` until ${new Date(r[0].tier_expires_at).toLocaleDateString()}` : ""} · library ${r[0].media_access ? "on" : "off"} · uploads ${r[0].can_upload_media ? "on" : "off"}` });
      res.json({ ok: true, user: r[0] });
    });

    app.post("/api/admin/plans/requests/:id", async (req, res) => {
      const admin = await adminOnly(req, res);
      if (!admin) return;
      const action = req.body?.action;
      if (action !== "approve" && action !== "decline") return res.status(400).json({ error: "action must be approve or decline" });
      const rows = await deps.query("SELECT id, user_id, tier_id FROM plan_upgrade_requests WHERE id=$1 AND status='pending'", [req.params.id]);
      const request = rows?.[0];
      if (!request) return res.status(404).json({ error: "That request was already handled." });
      if (action === "approve") {
        if (!state.tiers.some((t) => t.id === request.tier_id)) return res.status(400).json({ error: "That tier no longer exists." });
        const d = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
        await deps.query("UPDATE users SET user_tier=$1, tier_expires_at=$2 WHERE id=$3", [request.tier_id, d && !Number.isNaN(d.getTime()) ? d : null, request.user_id]);
        deps.invalidateUser(String(request.user_id));
      }
      await deps.query("UPDATE plan_upgrade_requests SET status=$1, resolved_at=NOW(), resolved_by=$2 WHERE id=$3",
        [action === "approve" ? "approved" : "declined", admin.username ?? "admin", request.id]);
      res.json({ ok: true });
    });
  }

  /** Names of the plans on offer that include a feature. */
  const tiersWith = (key: string) => {
    const g = state.gates[key];
    const ids = g?.gated ? g.tiers : state.tiers.map((t) => t.id);
    return state.tiers.filter((t) => ids.includes(t.id) && t.isPublic && !t.isDefault).map((t) => t.name);
  };
  /** Names of the plans on offer that play on more than this many screens. */
  const moreScreens = (limit: number) =>
    state.tiers.filter((t) => t.isPublic && !t.isDefault && (t.maxStreams == null || t.maxStreams > limit)).map((t) => t.name);

  return { register, featureGate, allowed, tierOf, tiersWith, moreScreens, load, tierIds: () => state.tiers.map((t) => t.id), tierById: (id: string) => state.tiers.find((t) => t.id === id), ensureSchema };
}
