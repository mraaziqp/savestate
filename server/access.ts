/**
 * Who may call what.
 *
 * The app grew up as a private host for a handful of trusted people, so most
 * routes only asked "is there a valid token?". With open sign-up that is not
 * enough: on 2026-10-13 a plain `user` account could read the Brain master
 * key (/api/brain/key/reveal), browse C:\ (/api/fs/list), read the Arr and
 * qBittorrent settings and list the ROM library.
 *
 * Rather than patch 480 handlers one by one, every /api request passes through
 * one table here, after the global token check in server.ts:
 *
 *   admin   host administration (config, scans, installers, logs, keys)
 *   media   the host's own films, shows, music, books and photos
 *   games   the host's own ROMs, BIOS files and PC games
 *   upload  adding files to the host
 *   self    a user's own profile data (/api/profiles/:userId/...)
 *   member  any signed-in account
 *
 * "media" and "games" are per-person grants the host hands out (the existing
 * media_access flag, plus games_access which follows it unless set). They are
 * deliberately NOT something a paid tier can buy: tiers gate features of the
 * software (see tiers.ts), never the owner's library.
 *
 * Routes not named in the table keep their old behaviour (any valid token, or
 * public when listed in PUBLIC_API_PREFIXES), and handlers that already check
 * for an admin keep doing so; this layer only ever adds a refusal.
 */
import type express from "express";
import jwt from "jsonwebtoken";

export type Caller = {
  authed: boolean;
  /** PIN or Brain-key session: the host itself. */
  host: boolean;
  admin: boolean;
  userId: string | null;
  username: string | null;
  role: string;
  media: boolean;
  games: boolean;
  upload: boolean;
  /** Raw users.user_tier; tiers.ts decides what it is worth. */
  tier: string | null;
  tierExpiresAt: number | null;
  /** Set when the token is valid but the account is gone or the token predates a password change. */
  stale?: "deleted" | "password-changed" | "profile-ended";
  /** A household profile of the account (household.ts): never an admin, limited to its sections. */
  profile?: ProfileSession;
};

export type ProfileSession = {
  id: string; ownerId: string; name: string; avatar: string; color: string;
  /** Tabs of the app this profile may open. */
  tabs: string[];
  sections: string[];
  /** "link": signed in from a shared link, so it can never become the account. */
  via: "picker" | "link";
  version: number;
};

export type Need = "member" | "media" | "games" | "upload" | "admin" | "self";

export type AccessDeps = {
  jwtSecret: string;
  /** The Brain API key (full access), "" when none is set. */
  brainKey: () => string;
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[] | null>;
  dbUp: () => boolean;
  /** True for paths that need no token at all (sign-in, sign-up, public pages). */
  isPublic?: (path: string) => boolean;
  /** 402 when a signed-in member's tier does not include the feature behind this path. */
  featureGate?: (caller: Caller, method: string, path: string) => { feature: string; label: string; tiers: string[] } | null;
  log: (level: string, msg: string) => void;
  /** A household profile by id; null when it is gone, undefined when that cannot be told (DB down). */
  profileOf?: (id: string) => Promise<ProfileSession | null | undefined>;
  /** For a profile session: a refusal for this request, or null to carry on. */
  profileGate?: (caller: Caller, req: express.Request) => Promise<{ status: number; body: Record<string, unknown> } | null>;
};

const ADMIN_ROLES = new Set(["admin", "superadmin", "ultra_admin"]);
export const SESSION_COOKIE = "nx_session";

const ANON: Caller = {
  authed: false, host: false, admin: false, userId: null, username: null, role: "",
  media: false, games: false, upload: false, tier: null, tierExpiresAt: null,
};
const HOST: Caller = {
  authed: true, host: true, admin: true, userId: null, username: "host", role: "admin",
  media: true, games: true, upload: true, tier: null, tierExpiresAt: null,
};

type M = "*" | "GET" | "MUT" | "DELETE";
type Rule = [M, string | RegExp, Need];

// First match wins. A string is a path prefix.
const RULES: Rule[] = [
  // ── Host administration ────────────────────────────────────────────────
  ["*", "/api/admin/", "admin"],
  ["*", "/api/brain/", "admin"],
  ["*", "/api/vault/", "admin"],
  ["*", "/api/fs/", "admin"],
  ["*", "/api/gateways/", "admin"],
  ["*", "/api/installer/", "admin"],
  ["*", "/api/security/", "admin"],
  ["*", "/api/maintenance/", "admin"],
  ["*", "/api/recovery/", "admin"],
  ["*", "/api/cloud/", "admin"],
  ["*", "/api/daemon/logs", "admin"],
  ["*", "/api/user/debug/", "admin"],
  ["*", "/api/watcher/", "admin"],
  ["*", "/api/network/", "admin"],
  ["*", "/api/setup/events", "admin"],
  ["*", "/api/host/game-mode", "admin"],
  ["MUT", "/api/host/", "admin"],
  ["*", /^\/api\/system\/(pick-|find-retroarch|install-ffmpeg)/, "admin"],
  ["*", "/api/integrations/nucleus/", "admin"],
  ["*", "/api/awehchat/", "admin"],
  ["*", /^\/api\/nas\/(drives|pools|allocation|keys)/, "admin"],
  ["*", /^\/api\/emulator\/(install-|auto-fix|bios\/upload)/, "admin"],
  ["MUT", "/api/cores/", "admin"],
  ["*", /^\/api\/arr\/(config|install-webhook|release-policy|sources\/sync|approve|reject|remove|retry-wanted)/, "admin"],
  ["*", /^\/api\/torrent\/(config|test|action|set-location|drives)/, "admin"],
  ["*", /^\/api\/media\/(scan|scan-pc-videos|organize|rename-series|enrich|subtitles\/auto-fetch-all)/, "admin"],
  // art/fetch-batch is not here: every client asks for it on load, so it answers "nothing to do" to non-admins itself.
  ["*", /^\/api\/art\/(sync-folder|sync-retroarch-thumbnails|scan-launchbox-images)/, "admin"],
  ["MUT", /^\/api\/games\/[^/]+\/fetch-art$/, "admin"],
  ["DELETE", /^\/api\/games\/[^/]+$/, "admin"],
  ["*", /^\/api\/music\/(deep-scan|purge-junk)/, "admin"],
  ["MUT", "/api/manual-library", "admin"],
  ["MUT", /^\/api\/codex\/(online-download|covers\/enrich)/, "admin"],
  ["MUT", "/api/steam/", "admin"],
  ["*", "/api/roms/requests", "admin"],
  ["*", "/api/downloads/sequential", "admin"],
  ["*", "/api/downloads/retry-stuck", "admin"],

  // ── A user's own data ──────────────────────────────────────────────────
  ["MUT", /^\/api\/profiles\/[^/]+(\/|$)/, "self"],
  ["GET", /^\/api\/profiles\/[^/]+\/saves/, "self"],

  // ── The host's games, BIOS files and PC ────────────────────────────────
  // Adding files to the host's library is for its admins (any signed-in
  // user could write into it through upload-rom until 2026-10-17).
  ["*", "/api/games/intake/", "admin"],
  ["MUT", "/api/games/upload-rom", "admin"],
  ["MUT", "/api/games/request-setup", "member"],
  ["MUT", "/api/roms/request", "member"],
  ["*", "/api/games/recommendations", "member"],
  ["*", /^\/api\/games\/[^/]+\/leaderboard$/, "member"],
  ["*", "/api/games/", "games"],
  ["MUT", "/api/games", "games"],
  ["*", "/api/roms/", "games"],
  ["*", "/api/emulator/bios/serve/", "games"],
  // libretro cores are freely redistributable, so any member's desktop app may
  // copy them from the host. BIOS files and whole emulator folders are not.
  ["*", /^\/api\/emulator\/export\/(cores|manifest)$/, "member"],
  ["*", "/api/emulator/export/", "games"],
  ["*", "/api/bios/", "games"],
  ["*", "/api/pc-games/", "games"],
  ["*", "/api/steam/", "games"],
  ["*", "/api/coop/", "games"],
  ["*", "/api/remote-play/", "games"],
  ["*", /^\/api\/stream\/(check|start|stop|feed|input|hls\/start|hls\/stop)$/, "games"],

  // ── The host's films, shows, music, books and photos ───────────────────
  ["*", /^\/api\/media\/(library|recommendations|continue-watching|progress|subtitles\/)/, "media"],
  // The films themselves. These were on the public list (a <video> cannot send
  // a header), so until 2026-10-14 anyone with a file's path could stream it
  // without signing in. The session cookie or ?token= signs them in now.
  ["*", /^\/api\/media\/(file|stream|hls\/|info|prewarm|thumbnail|intro-markers)/, "media"],
  ["*", /^\/api\/stream\/(gdrive|media)\//, "media"],
  ["*", "/api/watch/", "media"],
  ["*", "/api/taste", "media"],
  ["*", "/api/arr/", "media"],
  ["*", "/api/torrent/download-status", "member"],
  ["*", "/api/torrent/", "media"],
  ["*", "/api/music/cover", "member"],
  ["*", "/api/music/scan-progress", "member"],
  ["*", "/api/music/", "media"],
  ["*", "/api/playlists", "media"],
  ["*", "/api/watch-party/", "media"],
  ["*", /^\/api\/codex\/books\/[^/]+\/(file|cover)$/, "member"],
  ["MUT", "/api/codex/upload", "upload"],
  ["*", "/api/codex/", "media"],
  ["*", /^\/api\/photos\/(file|auth\/)/, "member"],
  ["GET", /^\/api\/photos\/albums\/[^/]+\/photos\/[^/]+$/, "member"],
  ["MUT", "/api/photos/", "upload"],
  ["*", "/api/photos/", "media"],

  // ── Things that cost the host money or CPU: members only ───────────────
  ["*", /^\/api\/ai\/(chat|navigate|guide|scrape)$/, "member"],
  ["*", "/api/sync/", "member"],
  ["*", "/api/integrations/steam/", "member"],
];

// Byte-serving routes reached by <img>, <audio>, <video> or a third-party
// player, which cannot send a header. They were public and stay reachable
// without a token here; their handlers validate what they serve.
const TOKENLESS_OK: Array<string | RegExp> = [
  "/api/music/cover",
  /^\/api\/codex\/books\/[^/]+\/(file|cover)$/,
  /^\/api\/photos\/(file|auth\/)/,
  /^\/api\/photos\/albums\/[^/]+\/photos\/[^/]+$/,
  "/api/torrent/download-status",
  "/api/music/scan-progress",
];

const matches = (pattern: string | RegExp, p: string) =>
  typeof pattern === "string" ? p === pattern || p.startsWith(pattern) : pattern.test(p);

function needFor(method: string, p: string): Need | null {
  const mut = method !== "GET" && method !== "HEAD";
  for (const [m, pattern, need] of RULES) {
    if (m === "GET" && mut) continue;
    if (m === "MUT" && !mut) continue;
    if (m === "DELETE" && method !== "DELETE") continue;
    if (matches(pattern, p)) return need;
  }
  return null;
}

export function readCookie(req: express.Request, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export function createAccess(deps: AccessDeps) {
  type Row = {
    id: string; username: string; role: string | null; media_access: boolean | null; games_access: boolean | null;
    can_upload_media: boolean | null; user_tier: string | null; tier_expires_at: string | Date | null;
    password_changed_at: string | Date | null;
  };
  const cache = new Map<string, { at: number; row: Row | null }>();
  const TTL_MS = 30_000;

  async function userRow(userId: string): Promise<{ row: Row | null; known: boolean }> {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return { row: hit.row, known: true };
    if (deps.dbUp()) {
      const rows = await deps.query<Row>(
        `SELECT id, username, role, media_access, games_access, can_upload_media, user_tier, tier_expires_at, password_changed_at
           FROM users WHERE id::text = $1`, [userId]);
      if (rows) {
        const row = rows[0] ?? null;
        cache.set(userId, { at: Date.now(), row });
        if (cache.size > 5000) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
        return { row, known: true };
      }
    }
    // Database unreachable: replay the last answer rather than lock everyone out.
    return { row: hit?.row ?? null, known: !!hit };
  }

  /** Forget what is cached for a user (after a role, tier or access change). */
  function invalidate(userId?: string) { if (userId) cache.delete(userId); else cache.clear(); }

  function tokenOf(req: express.Request): string {
    const header = (req.headers.authorization ?? "").replace(/^Bearer /i, "").trim()
      || String(req.headers["x-brain-key"] ?? "").trim()
      || String(req.query.token ?? "").trim();
    if (header) return header;
    // The cookie exists for <img>/<audio>/<video>, so it only ever reads.
    return req.method === "GET" || req.method === "HEAD" ? readCookie(req, SESSION_COOKIE) : "";
  }

  async function callerOf(req: express.Request): Promise<Caller> {
    const cached = (req as any).nxCaller as Caller | undefined;
    if (cached) return cached;
    const done = (c: Caller) => { (req as any).nxCaller = c; return c; };
    const raw = tokenOf(req);
    if (!raw) return done(ANON);
    const brain = deps.brainKey();
    if (brain && raw === brain) return done(HOST);
    let payload: any;
    try { payload = jwt.verify(raw, deps.jwtSecret, { algorithms: ["HS256"] }); } catch { return done(ANON); }
    if (payload?.nexus || payload?.brain) return done(HOST);
    const userId = payload?.userId ? String(payload.userId) : "";
    if (!userId) return done(ANON);

    const { row, known } = await userRow(userId);
    if (!row) {
      // Known-missing means the account was deleted; unknown means the DB is
      // down and we have never seen this user, so they get a plain member.
      return done(known
        ? { ...ANON, stale: "deleted" }
        : { ...ANON, authed: true, userId, username: payload.username ?? null, role: "user" });
    }
    const changed = row.password_changed_at ? new Date(row.password_changed_at).getTime() : 0;
    if (changed && typeof payload.iat === "number" && payload.iat * 1000 < changed - 5000) {
      return done({ ...ANON, stale: "password-changed" });
    }
    const role = row.role ?? "user";
    const admin = ADMIN_ROLES.has(role);
    const media = admin || !!row.media_access;
    const account: Caller = {
      authed: true, host: false, admin, userId, username: row.username, role,
      media,
      games: admin || (row.games_access == null ? media : !!row.games_access),
      upload: admin || !!row.can_upload_media,
      tier: row.user_tier,
      tierExpiresAt: row.tier_expires_at ? new Date(row.tier_expires_at).getTime() : null,
    };
    if (!payload.profileId) return done(account);

    // A household profile: what the account may see, narrowed to the profile's
    // sections, and never anything an admin can do.
    const profile = deps.profileOf ? await deps.profileOf(String(payload.profileId)) : null;
    if (profile === undefined) return done({ ...ANON, stale: "profile-ended" });
    if (!profile || profile.ownerId !== userId || profile.version !== Number(payload.pv ?? 1)) return done({ ...ANON, stale: "profile-ended" });
    const via = payload.via === "link" ? "link" : "picker";
    return done({
      ...account, admin: false, upload: false, role: "profile",
      media: account.media && profile.sections.includes("media"),
      games: account.games && profile.sections.includes("games"),
      profile: { ...profile, via },
    });
  }

  const REFUSAL: Record<Need, { status: number; error: string; message: string }> = {
    member: { status: 401, error: "Authentication required", message: "Sign in to use this." },
    admin: { status: 403, error: "admin_only", message: "Only the host's admins can do this." },
    media: { status: 403, error: "media_access_required", message: "You need an invite from the host to open their media library." },
    games: { status: 403, error: "library_access_required", message: "This host's game library is private. Add your own games, or ask the host for access." },
    upload: { status: 403, error: "upload_not_allowed", message: "Your account can't add files to this host." },
    self: { status: 403, error: "not_yours", message: "You can only change your own profile." },
  };

  const guard: express.RequestHandler = async (req, res, next) => {
    if (!req.path.startsWith("/api/") || req.method === "OPTIONS") return next();
    try {
      const need = needFor(req.method, req.path);
      const gate = deps.featureGate;
      if (!need && !gate) return next();
      const caller = await callerOf(req);

      // A revoked token ends the session, except on the routes that exist to
      // start a new one: a browser still holding the old token after a
      // password reset must be able to sign in with the new password.
      if (caller.stale && !(deps.isPublic?.(req.path) && !need)) {
        return res.status(401).json({
          error: caller.stale === "deleted" ? "This account no longer exists."
            : caller.stale === "profile-ended" ? "This profile was signed out by the account owner."
            : "Your password was changed. Please sign in again.",
          code: "session_expired",
        });
      }
      if (caller.profile && deps.profileGate) {
        const refusal = await deps.profileGate(caller, req);
        if (refusal) return res.status(refusal.status).json(refusal.body);
      }
      if (need) {
        if (!caller.authed) {
          if (!TOKENLESS_OK.some((t) => matches(t, req.path))) {
            return res.status(401).json({ error: REFUSAL.member.error, message: REFUSAL.member.message });
          }
        } else {
          const ok = need === "member" ? true
            : need === "admin" ? caller.admin
            : need === "media" ? caller.media
            : need === "games" ? caller.games
            : need === "upload" ? caller.upload
            : caller.admin || (!!caller.userId && caller.userId === decodeURIComponent(req.path.split("/")[3] ?? ""));
          if (!ok) {
            const r = REFUSAL[need];
            return res.status(r.status).json({ error: r.error, message: r.message, need });
          }
        }
      }
      if (gate && caller.authed && !caller.admin) {
        const locked = gate(caller, req.method, req.path);
        if (locked) {
          return res.status(402).json({
            error: "upgrade_required",
            feature: locked.feature,
            featureLabel: locked.label,
            tiers: locked.tiers,
            message: locked.tiers.length
              ? `${locked.label} is part of ${locked.tiers.join(" or ")}.`
              : `${locked.label} isn't included in your plan.`,
          });
        }
      }
      next();
    } catch (e: any) {
      deps.log("ERROR", `access guard failed on ${req.method} ${req.path}: ${e?.message ?? e}`);
      res.status(500).json({ error: "Could not check your access. Please try again." });
    }
  };

  /** Session cookie so media elements (which cannot send a header) are still signed in. */
  function setSessionCookie(req: express.Request, res: express.Response, token: string | null) {
    const secure = req.secure || String(req.headers["x-forwarded-proto"] ?? "").includes("https")
      || !!req.headers["cf-connecting-ip"];
    const attrs = ["Path=/api", "HttpOnly", "SameSite=Lax", secure ? "Secure" : ""].filter(Boolean).join("; ");
    res.append("Set-Cookie", token
      ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${30 * 24 * 3600}; ${attrs}`
      : `${SESSION_COOKIE}=; Max-Age=0; ${attrs}`);
  }

  return { guard, callerOf, invalidate, tokenOf, setSessionCookie };
}
