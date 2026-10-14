/**
 * What to Watch and Discover.
 *
 * Two halves:
 *  - A title index of the local library. Every show and film is matched to
 *    TMDB once (genres, rating, runtime, artwork, recommendations) and the
 *    match is kept in watch-tmdb.json. Before this, 1 of 85 library titles had
 *    a genre or a runtime, so nothing could be recommended by mood, length or
 *    taste.
 *  - Routes that turn that index plus the viewer's watch progress into a
 *    "what should I watch now" home (/api/watch/home), and a much wider TMDB
 *    discovery surface (/api/discover/rows, /browse, /title, /find) in which
 *    anything already in the library is marked playable.
 *
 * Auth: the global gate in server.ts has already checked the token; this
 * module only reads the user id from it (deps.userIdOf) to find progress.
 */
import type express from "express";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

export type WatchMediaItem = {
  kind: string; category: string; name: string; seriesTitle: string | null;
  season: number | null; episode: number | null; relPath: string;
  relatedCoverRelPath: string | null; updatedAt: string; size: number;
};

export type WatchDeps = {
  persistDir: string;
  getMedia: () => WatchMediaItem[];
  /** Runs (or joins) the library scan; awaited when nothing is scanned yet, e.g. right after start. */
  ensureMedia: () => Promise<unknown>;
  tmdbGet: (p: string) => Promise<any>;
  userIdOf: (req: express.Request) => string | null;
  /** Watch progress rows for a user; [] when the database is unavailable. */
  /** "show|season|episode" for an episode file path, null for anything else. */
  episodeKey: (relPath: string) => string | null;
  /** The same key's show part, for a library item's seriesTitle. */
  seriesKeyOf: (title: string) => string;
  progressOf: (userId: string) => Promise<Array<{ rel_path: string; watch_time: number; duration: number; ended: boolean; updated_at: number | string }>>;
  log: (level: string, msg: string) => void;
};

// ── TMDB vocabulary ──────────────────────────────────────────────────────
const GENRES: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie", 53: "Thriller", 10752: "War",
  37: "Western", 10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality",
  10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics",
};

/** Moods span the movie and TV genre lists, which use different ids for the same idea. */
export const MOODS: Array<{ id: string; label: string; emoji: string; genres: number[] }> = [
  { id: "laugh", label: "Make me laugh", emoji: "😂", genres: [35] },
  { id: "edge", label: "Edge of my seat", emoji: "😬", genres: [53, 80, 9648] },
  { id: "action", label: "Big action", emoji: "💥", genres: [28, 12, 10759, 10752, 10768] },
  { id: "mind", label: "Mind-bending", emoji: "🌀", genres: [878, 14, 10765] },
  { id: "heart", label: "Something with heart", emoji: "💛", genres: [18, 10749] },
  { id: "scary", label: "Scare me", emoji: "👻", genres: [27] },
  { id: "family", label: "Family & animation", emoji: "🧸", genres: [10751, 16, 10762] },
  { id: "real", label: "True stories", emoji: "🎙️", genres: [99, 36, 10764] },
];

const img = (p: string | null | undefined, size = "w342") => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);

// ── Library titles ───────────────────────────────────────────────────────
type TmdbInfo = {
  id: number; type: "movie" | "tv"; title: string; year: number | null; genres: number[];
  rating: number; votes: number; runtime: number | null; overview: string; poster: string | null;
  backdrop: string | null; popularity: number; recs: number[]; seasons?: number; at: number;
};
type Miss = { miss: true; at: number };

type Title = {
  key: string; kind: "movie" | "series"; title: string; year: number | null;
  files: WatchMediaItem[];          // the movie file, or the episodes in watch order
  addedAt: number; cover: string | null; tmdb: TmdbInfo | null;
};

const RELEASE_TAG = /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr\d*|dv|bluray|blu-ray|brrip|bdrip|web-?dl|web-?rip|webrip|web|hdtv|hdrip|dvdrip|dvdscr|dcprip|cam|hdcam|ts|x264|x265|h\.?264|h\.?265|hevc|avc|av1|10bit|8bit|aac\d?(\.\d)?|ac3|eac3|ddp?\d?(\.\d)?|dts(-hd)?|truehd|atmos|remux|repack|proper|extended|unrated|imax|multi|dual|esubs?|msubs?|yts|yify|rarbg|galaxyrg|tgx|amzn|nf|hmax|atvp|dsnp)\b/i;

/** "Sonic.the.Hedgehog.2020.1080p.BluRay.x264-GECKOS" -> { title: "Sonic the Hedgehog", year: 2020 } */
export function cleanFilmName(raw: string): { title: string; year: number | null } {
  let s = raw.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[._]+/g, " ")
    .replace(/\[[^\]]*\]/g, " ").replace(/^\s*www\s+\S+\s+(?:\S+\s+)?-\s*/i, " ");
  let year: number | null = null;
  const ym = s.match(/(?:^|[\s(])((?:19|20)\d{2})(?=[\s)]|$)/);
  if (ym && ym.index !== undefined && ym.index > 0) {
    year = Number(ym[1]);
    s = s.slice(0, ym.index);
  }
  const tag = s.match(RELEASE_TAG);
  if (tag && tag.index !== undefined && tag.index > 0) s = s.slice(0, tag.index);
  s = s.replace(/\([^)]*\)?/g, " ").replace(/[-–—:,(]+\s*$/, "").replace(/\s+/g, " ").trim();
  if (s && s === s.toLowerCase()) s = s.replace(/\b\w/g, (c) => c.toUpperCase());
  return { title: s, year };
}

const isJunkTitle = (t: string) => !t || t.length < 2 || /^[\d\s-]+$/.test(t) || /^whatsapp|^screen ?recording|^vid[ _-]?\d|^img[ _-]?\d/i.test(t);
const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function buildTitles(media: WatchMediaItem[]): Title[] {
  const series = new Map<string, Title>();
  const movies = new Map<string, Title>();
  for (const m of media) {
    if (m.kind !== "video") continue;
    const added = Date.parse(m.updatedAt) || 0;
    if (m.category === "series" && m.seriesTitle && !/^unknown series$/i.test(m.seriesTitle)) {
      const k = `s:${keyOf(m.seriesTitle)}`;
      let t = series.get(k);
      if (!t) series.set(k, t = { key: k, kind: "series", title: m.seriesTitle, year: null, files: [], addedAt: 0, cover: null, tmdb: null });
      t.files.push(m);
      t.addedAt = Math.max(t.addedAt, added);
      t.cover ??= m.relatedCoverRelPath;
    } else if (m.category === "movie") {
      let { title, year } = cleanFilmName(path.basename(m.name));
      if (isJunkTitle(title)) ({ title, year } = cleanFilmName(path.basename(path.dirname(m.relPath))));
      if (isJunkTitle(title)) continue;   // a phone recording, not a film
      const k = `m:${keyOf(title)}:${year ?? ""}`;
      const have = movies.get(k);
      // Several copies of one film: keep the largest, it is usually the real one.
      if (have && have.files[0].size >= m.size) continue;
      movies.set(k, { key: k, kind: "movie", title, year, files: [m], addedAt: added, cover: m.relatedCoverRelPath, tmdb: null });
    }
  }
  for (const t of series.values()) {
    t.files.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  }
  return [...series.values(), ...movies.values()];
}

// ── The module ───────────────────────────────────────────────────────────
export function registerWatch(app: express.Express, deps: WatchDeps) {
  // v2: matching prefers exact titles; v1 matches are not reused.
  const CACHE_FILE = path.join(deps.persistDir, "watch-tmdb.v2.json");
  let cache: Record<string, TmdbInfo | Miss> = {};
  const cacheLoaded = readFile(CACHE_FILE, "utf8").then((s) => { cache = JSON.parse(s).entries ?? {}; }).catch(() => {});
  let dirty = false;
  const save = () => { if (!dirty) return; dirty = false; writeFile(CACHE_FILE, JSON.stringify({ version: 1, entries: cache })).catch(() => {}); };
  setInterval(save, 15_000).unref?.();

  const cached = (key: string): TmdbInfo | null => {
    const c = cache[key];
    return c && !("miss" in c) ? c : null;
  };

  async function matchTitle(t: Title): Promise<TmdbInfo | Miss> {
    const type = t.kind === "series" ? "tv" : "movie";
    const q = new URLSearchParams({ query: t.title, include_adult: "false" });
    if (t.year) q.set(type === "tv" ? "first_air_date_year" : "year", String(t.year));
    // An exact title beats TMDB's first result ("Hilda" is not "Hilda Hurricane").
    const best = (results: any[] | undefined) =>
      (results ?? []).find((r) => keyOf(r.title ?? r.name ?? "") === keyOf(t.title)) ?? (results ?? [])[0];
    let hit = best((await deps.tmdbGet(`/search/${type}?${q}`))?.results);
    if (!hit && t.year) {
      q.delete(type === "tv" ? "first_air_date_year" : "year");
      hit = best((await deps.tmdbGet(`/search/${type}?${q}`))?.results);
    }
    if (!hit) return { miss: true, at: Date.now() };
    const d = await deps.tmdbGet(`/${type}/${hit.id}?append_to_response=recommendations`);
    return {
      id: d.id, type, title: d.title ?? d.name ?? t.title,
      year: Number(String(d.release_date ?? d.first_air_date ?? "").slice(0, 4)) || t.year,
      genres: (d.genres ?? []).map((g: any) => g.id),
      rating: Number((d.vote_average ?? 0).toFixed(1)), votes: d.vote_count ?? 0,
      runtime: d.runtime ?? d.episode_run_time?.[0] ?? d.last_episode_to_air?.runtime ?? null,
      overview: d.overview ?? "", poster: d.poster_path ?? null, backdrop: d.backdrop_path ?? null,
      popularity: d.popularity ?? 0, seasons: d.number_of_seasons,
      recs: (d.recommendations?.results ?? []).slice(0, 20).map((r: any) => r.id),
      at: Date.now(),
    };
  }

  // Enrichment runs in the background, one title at a time; the home works
  // with whatever is known so far and reports progress.
  let enriching = false;
  const enrichState = { done: 0, total: 0 };
  async function enrich() {
    if (enriching) return;
    enriching = true;
    try {
      await cacheLoaded;
      const titles = buildTitles(deps.getMedia());
      const week = 7 * 24 * 3600 * 1000;
      const todo = titles.filter((t) => {
        const c = cache[t.key];
        return !c || ("miss" in c && Date.now() - c.at > week);
      });
      enrichState.total = titles.length;
      enrichState.done = titles.length - todo.length;
      for (const t of todo) {
        try { cache[t.key] = await matchTitle(t); dirty = true; }
        catch { /* TMDB blip: try again next round */ }
        enrichState.done++;
        await new Promise((r) => setTimeout(r, 120));
      }
      if (todo.length) deps.log("INFO", `What to Watch: matched ${todo.length} library title(s) to TMDB`);
      save();
    } finally { enriching = false; }
  }
  setTimeout(() => { enrich().catch(() => {}); }, 60_000).unref?.();
  setInterval(() => { enrich().catch(() => {}); }, 15 * 60_000).unref?.();

  // Every route that reads the library goes through here first.
  app.use(["/api/watch", "/api/discover/rows", "/api/discover/browse", "/api/discover/find", "/api/discover/title"], (_req, _res, next) => {
    if (deps.getMedia().length) return next();
    deps.ensureMedia().catch(() => {}).finally(() => next());
  });

  function libraryTitles(): Title[] {
    const titles = buildTitles(deps.getMedia());
    for (const t of titles) t.tmdb = cached(t.key);
    return titles;
  }
  /** tmdb id -> library title, for marking discovery results as playable. */
  function libraryByTmdb(): Map<string, Title> {
    const m = new Map<string, Title>();
    for (const t of libraryTitles()) if (t.tmdb) m.set(`${t.tmdb.type}:${t.tmdb.id}`, t);
    return m;
  }

  // ── Progress ───────────────────────────────────────────────────────────
  type Prog = { t: number; d: number; ended: boolean; at: number };
  /**
   * Progress by file path and also by "show|season|episode": the library
   * keeps one copy of each episode, and the copy watched last month may not
   * be the one kept now, or may have moved since.
   */
  async function loadProgress(uid: string | null): Promise<Map<string, Prog>> {
    const prog = new Map<string, Prog>();
    if (!uid) return prog;
    for (const r of await deps.progressOf(uid).catch(() => [])) {
      const p: Prog = { t: Number(r.watch_time) || 0, d: Number(r.duration) || 0, ended: !!r.ended, at: Number(r.updated_at) || 0 };
      prog.set(r.rel_path, p);
      const ek = deps.episodeKey(r.rel_path);
      if (ek && (prog.get(`ep:${ek}`)?.at ?? -1) < p.at) prog.set(`ep:${ek}`, p);
    }
    return prog;
  }
  const progFor = (prog: Map<string, Prog>, f: WatchMediaItem) =>
    prog.get(f.relPath) ?? (f.category === "series" && f.seriesTitle && f.season != null && f.episode != null
      ? prog.get(`ep:${deps.seriesKeyOf(f.seriesTitle)}|${f.season}|${f.episode}`) : undefined);

  // ── Cards ──────────────────────────────────────────────────────────────
  const epLabel = (f: WatchMediaItem) => (f.season != null && f.episode != null ? `S${f.season}E${f.episode}` : "");
  const pct = (p: Prog | undefined) => (p && p.d > 0 ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0);
  const done = (p: Prog | undefined) => !!p && (p.ended || (p.d > 0 && p.t / p.d >= 0.92));
  const started = (p: Prog | undefined) => !!p && !done(p) && p.t >= 60;

  function state(t: Title, prog: Map<string, Prog>) {
    const ps = t.files.map((f) => progFor(prog, f));
    const lastAt = Math.max(0, ...ps.map((p) => p?.at ?? 0));
    // The most recently opened episode. Until 2026-10-05 the player saved
    // "0 seconds, not finished" over an episode whenever it moved on to the
    // next one, so most history says nothing was watched. An episode opened
    // before a later one is therefore counted as watched.
    const lastIdx = ps.reduce((b, p, i) => (p && (b < 0 || p.at > ps[b]!.at) ? i : b), -1);
    // Anything opened before it is behind the viewer, even if left half-way.
    const doneAt = (i: number) => done(ps[i]) || (t.kind === "series" && !!ps[i] && i < lastIdx);
    // Only the most recent episode can be "in progress"; an old half-watched
    // one must not pull the viewer back from where they actually are.
    const inProgressIdx = lastIdx >= 0 && started(ps[lastIdx]) ? lastIdx : -1;
    const lastDoneIdx = ps.reduce((best, _p, i) => (doneAt(i) ? i : best), -1);
    const finished = t.files.length > 0 && ps.every((_p, i) => doneAt(i));
    let next = inProgressIdx >= 0 ? inProgressIdx
      : lastIdx >= 0 && !doneAt(lastIdx) && lastIdx > lastDoneIdx ? lastIdx
      : lastDoneIdx + 1;
    if (next >= t.files.length) next = -1;
    return { ps, lastAt, inProgressIdx, lastDoneIdx, finished, next, startedAny: ps.some(Boolean) };
  }

  function card(t: Title, prog: Map<string, Prog>, reason = "") {
    const s = state(t, prog);
    const i = s.next >= 0 ? s.next : 0;
    const f = t.files[i];
    const p = s.ps[i];
    const tm = t.tmdb;
    const runtime = tm?.runtime ?? null;
    let label = t.kind === "series" ? `Play ${epLabel(f)}`.trim() : "Play";
    if (started(p)) {
      const left = Math.max(1, Math.round((p!.d - p!.t) / 60));
      label = `Resume ${t.kind === "series" ? epLabel(f) + " · " : ""}${left}m left`;
    } else if (t.kind === "series" && s.lastDoneIdx >= 0) label = `Next: ${epLabel(f)}`;
    const recent = Date.now() - 14 * 24 * 3600 * 1000;
    return {
      key: t.key, kind: t.kind, title: tm?.title ?? t.title, year: tm?.year ?? t.year,
      poster: img(tm?.poster, "w342") ?? (t.cover ? `/api/media/file?rel=${encodeURIComponent(t.cover)}` : null),
      backdrop: img(tm?.backdrop, "w1280"),
      overview: tm?.overview ?? "", genres: (tm?.genres ?? []).map((g) => GENRES[g]).filter(Boolean).slice(0, 3),
      rating: tm?.rating ?? null, runtime,
      tmdbId: tm?.id ?? null, tmdbType: tm?.type ?? null,
      episodes: t.kind === "series" ? t.files.length : undefined,
      newEpisodes: t.kind === "series" ? t.files.filter((x) => (Date.parse(x.updatedAt) || 0) > recent && !done(progFor(prog, x))).length : undefined,
      progress: pct(p), finished: s.finished, reason,
      play: { relPath: f.relPath, title: f.name, label },
      queue: t.kind === "series" ? t.files.slice(i, i + 25).map((x) => ({ relPath: x.relPath, title: x.name })) : undefined,
    };
  }

  // ── /api/watch/home ────────────────────────────────────────────────────
  let trendingCache: { at: number; items: any[] } | null = null;
  async function trending(): Promise<any[]> {
    if (trendingCache && Date.now() - trendingCache.at < 3 * 3600_000) return trendingCache.items;
    const [m, t] = await Promise.all([
      deps.tmdbGet("/trending/movie/week").catch(() => null),
      deps.tmdbGet("/trending/tv/week").catch(() => null),
    ]);
    const items: any[] = [];
    const a = m?.results ?? [], b = t?.results ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) items.push(mapTmdb(a[i], "movie"));
      if (b[i]) items.push(mapTmdb(b[i], "tv"));
    }
    trendingCache = { at: Date.now(), items };
    return items;
  }

  app.get("/api/watch/home", async (req, res) => {
    try {
      await cacheLoaded;
      if (!enriching) enrich().catch(() => {});
      const minutes = Math.max(0, Number(req.query.minutes) || 0);
      const kind = String(req.query.kind ?? "all");
      const mood = MOODS.find((m) => m.id === String(req.query.mood ?? ""));

      const uid = deps.userIdOf(req);
      const prog = await loadProgress(uid);

      const all = libraryTitles();
      const fits = (t: Title) => {
        if (kind === "movie" && t.kind !== "movie") return false;
        if (kind === "series" && t.kind !== "series") return false;
        if (mood && !t.tmdb?.genres.some((g) => mood.genres.includes(g))) return false;
        if (minutes > 0) {
          const rt = t.tmdb?.runtime;
          if (!rt || rt > minutes + 5) return false;
        }
        return true;
      };
      const pool = all.filter(fits);
      const st = new Map(pool.map((t) => [t.key, state(t, prog)]));
      const S = (t: Title) => st.get(t.key)!;
      const byRating = (a: Title, b: Title) => (b.tmdb?.rating ?? 0) - (a.tmdb?.rating ?? 0);
      const rows: Array<{ id: string; title: string; subtitle?: string; items: any[] }> = [];
      const used = new Set<string>();
      const push = (id: string, title: string, list: Title[], reason: (t: Title) => string, subtitle?: string, max = 20) => {
        const items = list.slice(0, max).map((t) => card(t, prog, reason(t)));
        if (items.length) rows.push({ id, title, subtitle, items });
        for (const t of list.slice(0, 4)) used.add(t.key);
      };

      const cont = pool.filter((t) => S(t).inProgressIdx >= 0).sort((a, b) => S(b).lastAt - S(a).lastAt);
      push("continue", "Continue watching", cont, () => "Pick up where you left off");

      const nextUp = pool.filter((t) => t.kind === "series" && S(t).inProgressIdx < 0 && S(t).lastDoneIdx >= 0 && S(t).next >= 0)
        .sort((a, b) => S(b).lastAt - S(a).lastAt);
      push("next", "Next up", nextUp, (t) => `Next episode of ${t.title}`);

      // Taste: the genres of what was actually watched lately, weighted by recency.
      const watched = all.filter((t) => prog.size && t.files.some((f) => !!progFor(prog, f)))
        .sort((a, b) => state(b, prog).lastAt - state(a, prog).lastAt);
      const taste = new Map<number, number>();
      watched.slice(0, 12).forEach((t, i) => t.tmdb?.genres.forEach((g) => taste.set(g, (taste.get(g) ?? 0) + 1 / (1 + i * 0.3))));
      const anchor = watched.find((t) => t.tmdb);
      if (anchor) {
        const recs = new Set(anchor.tmdb!.recs);
        const like = pool.filter((t) => t.key !== anchor.key && !S(t).finished && t.tmdb)
          .map((t) => ({ t, s: (recs.has(t.tmdb!.id) ? 3 : 0) + t.tmdb!.genres.filter((g) => anchor.tmdb!.genres.includes(g)).length + t.tmdb!.rating / 10 }))
          .filter((x) => x.s >= 1.5).sort((a, b) => b.s - a.s).map((x) => x.t);
        push("because", `Because you watched ${anchor.tmdb!.title}`, like, () => `Like ${anchor.tmdb!.title}`);
      }

      const fresh = pool.filter((t) => !S(t).finished).sort((a, b) => b.addedAt - a.addedAt)
        .filter((t) => Date.now() - t.addedAt < 60 * 24 * 3600_000);
      push("new", "New in your library", fresh, (t) => {
        const n = t.kind === "series" ? card(t, prog).newEpisodes : 0;
        return n ? `${n} new episode${n > 1 ? "s" : ""}` : "Recently added";
      });

      if (taste.size) {
        const forYou = pool.filter((t) => t.tmdb && !S(t).startedAny)
          .map((t) => ({ t, s: t.tmdb!.genres.reduce((a, g) => a + (taste.get(g) ?? 0), 0) + t.tmdb!.rating / 4 }))
          .filter((x) => x.s > 1.5).sort((a, b) => b.s - a.s).map((x) => x.t);
        push("foryou", "Picked for you", forYou, (t) => `Matches your taste · ★ ${t.tmdb!.rating}`, "From the genres you watch most");
      }

      if (!minutes) {
        const quick = pool.filter((t) => !S(t).finished && t.tmdb?.runtime && (t.kind === "series" ? t.tmdb.runtime <= 32 : t.tmdb.runtime <= 95))
          .sort(byRating);
        push("quick", "Got half an hour?", quick, (t) => `${t.tmdb!.runtime} min${t.kind === "series" ? " episodes" : ""}`);
      }

      const top = pool.filter((t) => (t.tmdb?.rating ?? 0) >= 7.3 && (t.tmdb?.votes ?? 0) >= 50 && !S(t).finished).sort(byRating);
      push("top", "Highest rated in your library", top, (t) => `★ ${t.tmdb!.rating} on TMDB`);

      const newShows = pool.filter((t) => t.kind === "series" && !S(t).startedAny).sort(byRating);
      push("startshow", "Start a new series", newShows, (t) => `${t.files.length} episode${t.files.length > 1 ? "s" : ""} ready`);

      const unseen = pool.filter((t) => t.kind === "movie" && !S(t).startedAny).sort((a, b) => b.addedAt - a.addedAt);
      push("unseen", "Films you haven't seen", unseen, () => "Not watched yet");

      if (!mood) {
        for (const m of MOODS) {
          const list = pool.filter((t) => !S(t).finished && t.tmdb?.genres.some((g) => m.genres.includes(g))).sort(byRating);
          if (list.length >= 3) push(`mood-${m.id}`, `${m.emoji} ${m.label}`, list, (t) => (t.tmdb ? t.tmdb.genres.map((g) => GENRES[g]).filter(Boolean).slice(0, 2).join(" · ") : ""));
        }
      }

      const again = pool.filter((t) => S(t).finished && (t.tmdb?.rating ?? 0) >= 7).sort(byRating);
      push("again", "Worth watching again", again, () => "You finished this");

      // Hero: the strongest reason to press play right now.
      const hero = (cont[0] && Date.now() - S(cont[0]).lastAt < 4 * 24 * 3600_000 ? card(cont[0], prog, "Pick up where you left off") : null)
        ?? (nextUp[0] ? card(nextUp[0], prog, `The next episode of ${nextUp[0].title} is ready`) : null)
        ?? rows.find((r) => r.id === "because" || r.id === "foryou" || r.id === "new" || r.id === "top")?.items[0]
        ?? (pool[0] ? card(pool[0], prog) : null);

      // Everything eligible, for "Surprise me" on the client.
      const shuffle = pool.filter((t) => !S(t).finished).map((t) => card(t, prog, "Surprise pick"));

      // Not here yet: trending titles the library does not have.
      const have = libraryByTmdb();
      const trendingMissing = (await trending().catch(() => []))
        .filter((x) => !have.has(`${x.type}:${x.id}`))
        .filter((x) => kind === "all" || (kind === "movie" ? x.type === "movie" : x.type === "tv"))
        .filter((x) => !mood || x.genreIds.some((g: number) => mood.genres.includes(g)))
        .slice(0, 20);

      res.json({
        hero, rows, shuffle, trendingMissing,
        moods: MOODS.map(({ id, label, emoji }) => ({ id, label, emoji })),
        library: { titles: all.length, matched: all.filter((t) => t.tmdb).length, enriching: enriching ? enrichState : null },
        signedIn: !!uid,
      });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  /** The play target for one library title: resume point, else next episode. */
  app.get("/api/watch/next", async (req, res) => {
    await cacheLoaded;
    const t = libraryTitles().find((x) => x.key === String(req.query.key ?? ""));
    if (!t) return res.status(404).json({ error: "Not in the library" });
    res.json(card(t, await loadProgress(deps.userIdOf(req))));
  });

  // ── Discovery (TMDB) ───────────────────────────────────────────────────
  function mapTmdb(r: any, type: "movie" | "tv") {
    return {
      id: r.id, type, title: r.title ?? r.name ?? "Untitled",
      year: Number(String(r.release_date ?? r.first_air_date ?? "").slice(0, 4)) || null,
      overview: r.overview ?? "", poster: img(r.poster_path, "w342"), backdrop: img(r.backdrop_path, "w1280"),
      rating: r.vote_average ? Number(r.vote_average.toFixed(1)) : 0, votes: r.vote_count ?? 0,
      genreIds: r.genre_ids ?? [], genres: (r.genre_ids ?? []).map((g: number) => GENRES[g]).filter(Boolean).slice(0, 3),
    };
  }
  function markLibrary(items: any[], have: Map<string, Title>) {
    return items.map((x) => {
      const t = have.get(`${x.type}:${x.id}`);
      if (!t) return x;
      const f = t.files[0];
      return { ...x, inLibrary: { key: t.key, relPath: f.relPath, title: f.name, episodes: t.kind === "series" ? t.files.length : undefined } };
    });
  }

  const tmdbCache = new Map<string, { at: number; data: any }>();
  async function tmdbCached(p: string, ttl = 3 * 3600_000) {
    const hit = tmdbCache.get(p);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const data = await deps.tmdbGet(p);
    tmdbCache.set(p, { at: Date.now(), data });
    if (tmdbCache.size > 600) tmdbCache.delete(tmdbCache.keys().next().value as string);
    return data;
  }

  const today = () => new Date().toISOString().slice(0, 10);
  // Streaming services that operate in South Africa (TMDB provider ids).
  const PROVIDERS = [
    { id: 8, name: "Netflix" }, { id: 337, name: "Disney+" }, { id: 119, name: "Prime Video" },
    { id: 350, name: "Apple TV+" }, { id: 1899, name: "Max" }, { id: 55, name: "Showmax" },
  ];
  type RowDef = { id: string; title: string; path: string; browse?: Record<string, string> };
  function rowDefs(kind: "movie" | "tv"): RowDef[] {
    const D = `/discover/${kind}?include_adult=false`;
    const date = kind === "movie" ? "primary_release_date" : "first_air_date";
    const g = (id: number, title: string, extra = "") => ({ id: `genre-${id}${extra ? "-x" : ""}`, title, path: `${D}&with_genres=${id}&sort_by=popularity.desc&vote_count.gte=150${extra}`, browse: { genre: String(id) } });
    const common: RowDef[] = [
      { id: "trending", title: "Trending this week", path: `/trending/${kind}/week` },
      { id: "popular", title: "Popular right now", path: `/${kind}/popular` },
      kind === "movie"
        ? { id: "fresh", title: "Just released to watch at home", path: `${D}&with_release_type=4|5&release_date.lte=${today()}&sort_by=primary_release_date.desc&vote_count.gte=40&region=ZA` }
        : { id: "fresh", title: "New seasons on now", path: `/tv/on_the_air` },
      { id: "top", title: "All-time greats", path: `/${kind}/top_rated`, browse: { sort: "vote_average.desc" } },
      { id: "gems", title: "Hidden gems", path: `${D}&vote_average.gte=7.4&vote_count.gte=250&vote_count.lte=2500&sort_by=vote_average.desc` },
      ...PROVIDERS.slice(0, 4).map((p) => ({ id: `prov-${p.id}`, title: `Popular on ${p.name}`, path: `${D}&with_watch_providers=${p.id}&watch_region=ZA&sort_by=popularity.desc`, browse: { provider: String(p.id) } })),
    ];
    if (kind === "movie") {
      return [...common,
        g(28, "💥 Action"), g(35, "😂 Comedy"), g(878, "🚀 Sci-fi"), g(53, "😬 Thrillers"), g(27, "👻 Horror"),
        g(16, "🎨 Animated"), g(10749, "💛 Romance"), g(80, "🕵️ Crime"), g(99, "🎙️ Documentaries"), g(10751, "🧸 Family night"),
        { id: "short", title: "⏱️ Under 95 minutes", path: `${D}&with_runtime.lte=95&with_runtime.gte=60&vote_count.gte=500&sort_by=popularity.desc`, browse: { maxRuntime: "95" } },
        { id: "classics", title: "🎞️ Modern classics", path: `${D}&${date}.lte=2005-12-31&vote_count.gte=3000&sort_by=vote_average.desc` },
        { id: "upcoming", title: "📅 Coming soon", path: `/movie/upcoming` },
      ];
    }
    return [...common,
      g(10759, "💥 Action & adventure"), g(35, "😂 Comedy"), g(80, "🕵️ Crime"), g(10765, "🚀 Sci-fi & fantasy"),
      g(18, "🎭 Drama"), g(9648, "🔍 Mystery"), g(10764, "📺 Reality"), g(99, "🎙️ Docuseries"),
      { id: "anime", title: "🌸 Anime", path: `${D}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&vote_count.gte=100`, browse: { genre: "16", lang: "ja" } },
      { id: "kdrama", title: "🇰🇷 K-drama", path: `${D}&with_original_language=ko&with_genres=18&sort_by=popularity.desc&vote_count.gte=50`, browse: { lang: "ko" } },
      { id: "brit", title: "🇬🇧 British TV", path: `${D}&with_origin_country=GB&sort_by=popularity.desc&vote_count.gte=100`, browse: { country: "GB" } },
      { id: "binge", title: "🛋️ One-season binges", path: `${D}&vote_average.gte=7&vote_count.gte=300&sort_by=popularity.desc&with_status=3` },
    ];
  }

  app.get("/api/discover/rows", async (req, res) => {
    const kind = String(req.query.kind ?? "movie") === "tv" ? "tv" : "movie";
    const have = libraryByTmdb();
    const defs = rowDefs(kind);
    // "Because you have X": TMDB recommendations for a few library titles,
    // rotated daily so the row changes.
    const owned = [...have.values()].filter((t) => t.tmdb?.type === kind && t.tmdb.recs.length);
    const day = Math.floor(Date.now() / 86400_000);
    const seeds = owned.length ? [0, 1, 2].map((i) => owned[(day * 7 + i * 13) % owned.length]).filter((t, i, a) => a.indexOf(t) === i) : [];
    const recRows: RowDef[] = seeds.map((t) => ({ id: `recs-${t.tmdb!.id}`, title: `Because you have ${t.tmdb!.title}`, path: `/${kind}/${t.tmdb!.id}/recommendations` }));
    const all = [...defs.slice(0, 3), ...recRows, ...defs.slice(3)];
    const out = await Promise.all(all.map(async (d) => {
      try {
        const data = await tmdbCached(d.path);
        const items = markLibrary((data?.results ?? []).filter((r: any) => r.poster_path).map((r: any) => mapTmdb(r, kind)), have);
        return items.length ? { id: d.id, title: d.title, items, browse: d.browse ?? null } : null;
      } catch { return null; }
    }));
    res.json({ kind, rows: out.filter(Boolean), providers: PROVIDERS });
  });

  app.get("/api/discover/browse", async (req, res) => {
    const kind = String(req.query.kind ?? "movie") === "tv" ? "tv" : "movie";
    const q = new URLSearchParams({ include_adult: "false", page: String(Math.min(500, Math.max(1, Number(req.query.page) || 1))) });
    const sort = String(req.query.sort ?? "popularity.desc");
    q.set("sort_by", /^(popularity|vote_average|primary_release_date|first_air_date|revenue)\.(asc|desc)$/.test(sort) ? sort : "popularity.desc");
    if (sort.startsWith("vote_average")) q.set("vote_count.gte", "300");
    const date = kind === "movie" ? "primary_release_date" : "first_air_date";
    const num = (k: string) => (req.query[k] != null && /^\d+(\.\d+)?$/.test(String(req.query[k])) ? String(req.query[k]) : "");
    if (num("genre")) q.set("with_genres", num("genre"));
    if (num("yearFrom")) q.set(`${date}.gte`, `${num("yearFrom")}-01-01`);
    if (num("yearTo")) q.set(`${date}.lte`, `${num("yearTo")}-12-31`);
    if (num("minRating")) { q.set("vote_average.gte", num("minRating")); if (!q.has("vote_count.gte")) q.set("vote_count.gte", "100"); }
    if (num("maxRuntime")) q.set("with_runtime.lte", num("maxRuntime"));
    if (num("provider")) { q.set("with_watch_providers", num("provider")); q.set("watch_region", "ZA"); }
    if (/^[a-z]{2}$/.test(String(req.query.lang ?? ""))) q.set("with_original_language", String(req.query.lang));
    if (/^[A-Z]{2}$/.test(String(req.query.country ?? ""))) q.set("with_origin_country", String(req.query.country));
    try {
      const data = await tmdbCached(`/discover/${kind}?${q}`, 3600_000);
      const items = markLibrary((data?.results ?? []).filter((r: any) => r.poster_path).map((r: any) => mapTmdb(r, kind)), libraryByTmdb());
      res.json({ items, page: data?.page ?? 1, totalPages: Math.min(500, data?.total_pages ?? 1), total: data?.total_results ?? 0 });
    } catch (e: any) { res.status(502).json({ error: String(e?.message ?? e) }); }
  });

  app.get("/api/discover/find", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ items: [] });
    try {
      const data = await tmdbCached(`/search/multi?query=${encodeURIComponent(q)}&include_adult=false&page=${Math.max(1, Number(req.query.page) || 1)}`, 3600_000);
      const items = (data?.results ?? []).filter((r: any) => (r.media_type === "movie" || r.media_type === "tv") && r.poster_path)
        .map((r: any) => mapTmdb(r, r.media_type));
      res.json({ items: markLibrary(items, libraryByTmdb()), totalPages: data?.total_pages ?? 1 });
    } catch (e: any) { res.status(502).json({ error: String(e?.message ?? e) }); }
  });

  app.get("/api/discover/title", async (req, res) => {
    const kind = String(req.query.kind ?? "movie") === "tv" ? "tv" : "movie";
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "id required" });
    try {
      const d = await tmdbCached(`/${kind}/${id}?append_to_response=videos,credits,recommendations,similar,watch/providers,release_dates,content_ratings`, 6 * 3600_000);
      const yt = (d.videos?.results ?? []).filter((v: any) => v.site === "YouTube");
      const trailer = yt.find((v: any) => v.type === "Trailer" && v.official) ?? yt.find((v: any) => v.type === "Trailer") ?? yt.find((v: any) => v.type === "Teaser") ?? null;
      const za = d["watch/providers"]?.results?.ZA ?? null;
      const have = libraryByTmdb();
      const lib = have.get(`${kind}:${id}`);
      const cert = kind === "movie"
        ? (d.release_dates?.results ?? []).find((r: any) => r.iso_3166_1 === "ZA" || r.iso_3166_1 === "US")?.release_dates?.find((x: any) => x.certification)?.certification
        : (d.content_ratings?.results ?? []).find((r: any) => r.iso_3166_1 === "ZA" || r.iso_3166_1 === "US")?.rating;
      const recs = [...(d.recommendations?.results ?? []), ...(d.similar?.results ?? [])]
        .filter((r: any, i: number, a: any[]) => r.poster_path && a.findIndex((x) => x.id === r.id) === i).slice(0, 24).map((r: any) => mapTmdb(r, kind));
      res.json({
        ...mapTmdb({ ...d, genre_ids: (d.genres ?? []).map((g: any) => g.id) }, kind),
        tagline: d.tagline ?? "", status: d.status ?? "", certification: cert ?? null,
        runtime: d.runtime ?? d.episode_run_time?.[0] ?? d.last_episode_to_air?.runtime ?? null,
        seasons: kind === "tv" ? (d.seasons ?? []).filter((s: any) => s.season_number > 0).map((s: any) => ({ number: s.season_number, episodes: s.episode_count, year: Number(String(s.air_date ?? "").slice(0, 4)) || null })) : undefined,
        nextEpisode: d.next_episode_to_air ? { season: d.next_episode_to_air.season_number, episode: d.next_episode_to_air.episode_number, date: d.next_episode_to_air.air_date } : null,
        trailerKey: trailer?.key ?? null,
        cast: (d.credits?.cast ?? []).slice(0, 12).map((c: any) => ({ name: c.name, character: c.character ?? "", photo: img(c.profile_path, "w185") })),
        director: (d.credits?.crew ?? []).find((c: any) => c.job === "Director")?.name ?? (d.created_by ?? [])[0]?.name ?? null,
        providers: (za?.flatrate ?? []).map((p: any) => ({ name: p.provider_name, logo: img(p.logo_path, "w92") })),
        recommendations: markLibrary(recs, have),
        inLibrary: lib ? { key: lib.key, relPath: lib.files[0].relPath, title: lib.files[0].name, episodes: lib.kind === "series" ? lib.files.length : undefined, seasons: lib.kind === "series" ? [...new Set(lib.files.map((f: any) => f.season).filter((s: any) => typeof s === "number"))] : undefined } : null,
      });
    } catch (e: any) { res.status(502).json({ error: String(e?.message ?? e) }); }
  });

  deps.log("INFO", "What to Watch and Discover routes ready");
}
