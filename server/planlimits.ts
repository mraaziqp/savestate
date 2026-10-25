/**
 * What a plan allows at once: how many screens may watch, and which games
 * download to a member's own device.
 *
 * Streams. A tier's maxStreams is how many devices of one account (with its
 * household profiles) may play films and shows at the same time; for the
 * first introDays after sign-up the account gets introStreams instead (for
 * example two screens for three months, then one). A device is its address
 * and browser together; a device that keeps watching, or switches title,
 * keeps its place, and a place frees itself two minutes after the device
 * stops asking for video. A device that would go over the limit is told
 * which other device is watching and can stop it from there.
 *
 * Games. When "games.full" is gated, members on other plans still play the
 * retro systems in the browser; the systems that need the desktop app (PS2,
 * GameCube/Wii, PS3, Switch, PSP and friends) don't download for them.
 *
 * Admins and their household profiles are never limited. None of this ever
 * grants the host's library: that stays a per-person grant (access.ts).
 */
import type express from "express";
import { createHash } from "node:crypto";
import type { Caller } from "./access.ts";
import type { Tier } from "./tiers.ts";

export type PlanLimitsDeps = {
  callerOf: (req: express.Request) => Promise<Caller>;
  tierOf: (c: Caller) => Tier;
  allowed: (c: Caller, feature: string) => boolean;
  /** Names of the plans on offer that allow more than this many screens. */
  moreScreens: (limit: number) => string[];
  /** Tier names that include a feature, for the upgrade message. */
  tiersWith: (feature: string) => string[];
  /** The game's platform key (ps2, gba, ...) or null when it isn't known. */
  gamePlatform: (id: string) => Promise<string | null>;
  log: (level: string, msg: string) => void;
};

const DAY = 86_400_000;
/** A place stays taken this long after the device's last video request. */
const IDLE_MS = 2 * 60_000;

// Films and shows only: music, pictures and subtitles never take a place.
const VIDEO_PATH = /^\/api\/(media\/(stream|file|hls\/)|stream\/(gdrive|media)\/)/;
const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|ts|m2ts|mpg|mpeg|flv|3gp|ogv)$/i;

/** Systems that need the desktop app (or the host PC) to play. */
export const HEAVY_SYSTEMS = new Set(["ps2", "ps3", "gamecube", "gc", "wii", "wiiu", "switch", "psp", "psvita", "vita", "3ds", "xbox", "xbox360"]);
const GAME_FILE = /^\/api\/games\/([^/]+)\/(download|download-rom)(\/|$)/;

type Stream = {
  account: string; device: string; label: string; who: string; title: string;
  since: number; lastAt: number; open: Set<express.Response>;
};

/** "an iPhone", "a Windows PC": enough to recognise one's own devices. */
export function deviceLabel(ua: string): string {
  if (/Android TV|AFT[A-Z]|BRAVIA|SMART-TV|SmartTV|Tizen|Web0S|WebOS|CrKey|GoogleTV/i.test(ua)) return "a TV";
  if (/iPhone/i.test(ua)) return "an iPhone";
  if (/iPad/i.test(ua)) return "an iPad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "an Android phone" : "an Android tablet";
  if (/Windows/i.test(ua)) return "a Windows PC";
  if (/Macintosh|Mac OS X/i.test(ua)) return "a Mac";
  if (/CrOS/i.test(ua)) return "a Chromebook";
  if (/Linux/i.test(ua)) return "a Linux computer";
  return "another device";
}

const titleOf = (req: express.Request) => {
  const rel = String(req.query.rel ?? "");
  if (rel) {
    const base = rel.replace(/\\/g, "/").split("/").pop() ?? rel;
    return base.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  }
  return String(req.params?.fileId ?? req.path.split("/").pop() ?? "").slice(0, 40);
};

export function createPlanLimits(deps: PlanLimitsDeps) {
  const streams = new Map<string, Stream>();
  /** Devices stopped from another device, so they're told why. */
  const stopped = new Map<string, number>();

  const ip = (req: express.Request) =>
    String(req.headers["cf-connecting-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0] ?? "").trim() || req.ip || "";
  const deviceOf = (req: express.Request) =>
    createHash("sha1").update(`${ip(req)}|${String(req.headers["user-agent"] ?? "")}`).digest("hex").slice(0, 16);

  const unlimited = (c: Caller) => !c.authed || c.host || c.admin || !!c.ownerAdmin || !c.userId;

  /** Screens this account may use now, null for no limit, and until when a welcome allowance lasts. */
  function streamLimit(c: Caller): { limit: number | null; base: number | null; introUntil: number | null } {
    if (unlimited(c)) return { limit: null, base: null, introUntil: null };
    const t = deps.tierOf(c);
    const base = t.maxStreams;
    if (base == null) return { limit: null, base: null, introUntil: null };
    const until = t.introStreams != null && t.introDays && c.createdAt ? c.createdAt + t.introDays * DAY : null;
    if (until && Date.now() < until) return { limit: Math.max(base, t.introStreams!), base, introUntil: until };
    return { limit: base, base, introUntil: null };
  }

  const live = (s: Stream, now = Date.now()) => s.open.size > 0 || now - s.lastAt < IDLE_MS;
  const activeFor = (account: string) => {
    const now = Date.now();
    const out: Stream[] = [];
    for (const [k, s] of streams) {
      if (!live(s, now)) { streams.delete(k); continue; }
      if (s.account === account) out.push(s);
    }
    return out;
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, s] of streams) if (!live(s, now)) streams.delete(k);
    for (const [k, at] of stopped) if (now - at > 30 * 60_000) stopped.delete(k);
  }, 60_000);
  sweep.unref?.();

  const plans = (feature: string) => {
    const names = deps.tiersWith(feature);
    return names.length ? names.join(" or ") : "a paid plan";
  };

  const streamGuard: express.RequestHandler = async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!VIDEO_PATH.test(req.path)) return next();
    const rel = String(req.query.rel ?? "");
    if (/^\/api\/media\/(stream|file)/.test(req.path) && rel && !VIDEO_EXT.test(rel)) return next();
    let caller: Caller;
    try { caller = await deps.callerOf(req); } catch { return next(); }
    const { limit, base, introUntil } = streamLimit(caller);
    if (limit == null) return next();

    const account = caller.userId!;
    const device = deviceOf(req);
    const key = `${account}|${device}`;
    const now = Date.now();
    let mine = streams.get(key);
    if (!mine || !live(mine, now)) {
      const others = activeFor(account).filter((s) => s.device !== device);
      if (others.length >= limit) {
        const wasStopped = stopped.has(key);
        const names = others.map((s) => `${s.label}${s.who ? ` (${s.who})` : ""}`);
        const watching = names.length === 1
          ? `${names[0]} is watching${others[0].title ? ` ${others[0].title}` : ""}`
          : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are watching`;
        const more = deps.moreScreens(limit);
        res.status(409).json({
          error: "stream_limit", code: "stream_limit", limit,
          message: (wasStopped ? "Playback was moved to another device. " : "")
            + `Your plan plays on ${limit === 1 ? "one screen" : `${limit} screens`} at a time, and ${watching} now.`
            + (introUntil && base != null && base < limit ? ` (Your welcome allowance of ${limit} screens lasts until ${new Date(introUntil).toLocaleDateString("en-ZA", { day: "numeric", month: "long" })}.)` : "")
            + ` Stop ${others.length === 1 ? "it" : "one of them"} to watch here` + (more.length ? `, or move to ${more.join(" or ")} for more screens.` : "."),
          others: others.map((s) => ({ device: s.device, label: s.label, who: s.who, title: s.title, since: s.since })),
          upgrade: deps.moreScreens(limit),
        });
        return;
      }
      mine = { account, device, label: deviceLabel(String(req.headers["user-agent"] ?? "")), who: caller.profile?.name ?? "",
        title: "", since: now, lastAt: now, open: new Set() };
      streams.set(key, mine);
      stopped.delete(key);
    }
    mine.lastAt = now;
    const t = titleOf(req);
    if (t && !/^segment/i.test(t) && !/^playlist/i.test(t)) mine.title = t;
    const s = mine;
    s.open.add(res);
    res.once("close", () => { s.open.delete(res); s.lastAt = Date.now(); });
    next();
  };

  const gameGuard: express.RequestHandler = async (req, res, next) => {
    const m = GAME_FILE.exec(req.path);
    if (!m || (req.method !== "GET" && req.method !== "HEAD")) return next();
    let caller: Caller;
    try { caller = await deps.callerOf(req); } catch { return next(); }
    if (unlimited(caller) || deps.allowed(caller, "games.full")) return next();
    const platform = await deps.gamePlatform(decodeURIComponent(m[1])).catch(() => null);
    if (!platform || !HEAVY_SYSTEMS.has(platform)) return next();
    res.status(402).json({
      error: "upgrade_required", feature: "games.full", featureLabel: "Every console, on any screen", tiers: deps.tiersWith("games.full"),
      message: `${platform.toUpperCase()} games play through the SaveState desktop app, which is part of ${plans("games.full")}. Your plan plays the retro systems (NES, SNES, Game Boy, Mega Drive, PlayStation 1 and more) right in the browser.`,
    });
  };

  function register(app: express.Express) {
    // Which screens are watching on this account, and how many it may use.
    app.get("/api/plans/streams", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed || !caller.userId) return res.status(401).json({ error: "Sign in first." });
      const { limit, base, introUntil } = streamLimit(caller);
      const device = deviceOf(req);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        limit, after: introUntil ? base : null, introUntil,
        active: activeFor(caller.userId).map((s) => ({ device: s.device, label: s.label, who: s.who, title: s.title, since: s.since, thisDevice: s.device === device })),
      });
    });

    // Stop watching on another of this account's devices, to watch here.
    app.post("/api/plans/streams/stop", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed || !caller.userId) return res.status(401).json({ error: "Sign in first." });
      const device = String(req.body?.device ?? "");
      const key = `${caller.userId}|${device}`;
      const s = streams.get(key);
      if (!s) return res.json({ ok: true, stopped: false });
      for (const r of s.open) { try { r.destroy(); } catch { /* gone */ } }
      streams.delete(key);
      stopped.set(key, Date.now());
      deps.log("INFO", `${caller.username ?? "member"} stopped playback on ${s.label}`);
      res.json({ ok: true, stopped: true });
    });

    // Admin: list all active streams across all users on the host
    app.get("/api/admin/streams", async (req, res) => {
      let caller: Caller;
      try { caller = await deps.callerOf(req); } catch { return res.status(401).json({ error: "Unauthorized" }); }
      if (!caller.admin && !caller.host && caller.role !== "ultra_admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const now = Date.now();
      const list: Array<any> = [];
      for (const [key, s] of streams) {
        if (!live(s, now)) { streams.delete(key); continue; }
        list.push({
          key,
          account: s.account,
          device: s.device,
          label: s.label,
          who: s.who,
          title: s.title,
          since: s.since,
          lastAt: s.lastAt,
          openCount: s.open.size,
        });
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ streams: list, total: list.length });
    });

    // Admin: terminate any active stream on the host
    app.post("/api/admin/streams/stop", async (req, res) => {
      let caller: Caller;
      try { caller = await deps.callerOf(req); } catch { return res.status(401).json({ error: "Unauthorized" }); }
      if (!caller.admin && !caller.host && caller.role !== "ultra_admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const account = String(req.body?.account ?? "");
      const device = String(req.body?.device ?? "");
      const key = req.body?.key ? String(req.body.key) : `${account}|${device}`;
      const s = streams.get(key);
      if (!s) return res.json({ ok: true, stopped: false });
      for (const r of s.open) { try { r.destroy(); } catch { /* gone */ } }
      streams.delete(key);
      stopped.set(key, Date.now());
      deps.log("INFO", `Admin ${caller.username ?? "admin"} stopped playback on ${s.label} (${s.account})`);
      res.json({ ok: true, stopped: true });
    });
  }

  return { streamGuard, gameGuard, register, streamLimit, screensOf: (userId: string) => activeFor(userId).length, activeCount: () => [...streams.values()].filter((s) => live(s)).length };
}
