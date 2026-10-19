// Shared pieces for Discover and What to Watch: API access, playing a library
// title, poster cards, scrolling rows, the title sheet and the request flow.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { CSS } from "./styles.js";

export function useStyles() {
  useEffect(() => {
    if (document.getElementById("nxw-css")) return;
    const s = document.createElement("style");
    s.id = "nxw-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }, []);
}

const token = () => { try { return localStorage.getItem("nexus_token") ?? ""; } catch { return ""; } };

export async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token()}`, ...(opts.headers ?? {}) },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.message ?? j?.error ?? `HTTP ${r.status}`);
  return j;
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/**
 * Play a library file in the Movies & TV player. The player lives on another
 * tab and only knows the library once it has loaded, so the request is left in
 * sessionStorage and picked up there (see the MediaHub patch).
 */
export function playLocal(play, queue) {
  try { sessionStorage.setItem("nexus_pending_play", JSON.stringify({ relPath: play.relPath, title: play.title, queue: queue ?? null })); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("nexus:navigate-tab", { detail: { tab: "media" } }));
}

// ── Icons (inline so this module carries no icon dependency) ─────────────
const P = {
  play: "M7 4.5v15l13-7.5z",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7",
  star: "M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3.1-5.4 3.1 1.2-6L3.3 9.8l6.1-.7z",
  x: "M6 6l12 12M18 6L6 18",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  dice: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  down: "M12 4v12M6 11l6 6 6-6M5 20h14",
  skip: "M5 5l9 7-9 7zM18 5v14",
};
export function Icon({ name, size = 16, fill = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth={fill ? 0 : 2} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name]} />
    </svg>
  );
}

// ── Toasts ───────────────────────────────────────────────────────────────
let pushToast = () => {};
export const toast = (text, kind = "ok") => pushToast({ text, kind, id: Math.random() });
export function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => {
    pushToast = (t) => {
      setList((l) => [...l, t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), 4200);
    };
    return () => { pushToast = () => {}; };
  }, []);
  return <div className="nxw-toasts">{list.map((t) => <div key={t.id} className={`nxw-toast ${t.kind}`}>{t.text}</div>)}</div>;
}

// ── Requests (Radarr / Sonarr) ───────────────────────────────────────────
let arrStatus = null;
export function useArr() {
  const [cfg, setCfg] = useState(arrStatus);
  useEffect(() => {
    if (arrStatus) return;
    api("/api/arr/config").then((c) => { arrStatus = c; setCfg(c); }).catch(() => { arrStatus = { configured: false }; setCfg(arrStatus); });
  }, []);
  return cfg;
}
const reqKey = (it) => `${it.type}:${it.id}`;
export function isRequested(it) { return !!store.get("nxw_requested", {})[reqKey(it)]; }
function markRequested(it) {
  const all = store.get("nxw_requested", {});
  all[reqKey(it)] = Date.now();
  store.set("nxw_requested", all);
}

export async function requestTitle(it, seasons, qualityProfileId) {
  const q = qualityProfileId ? { qualityProfileId } : {};
  const r = it.type === "movie"
    ? await api("/api/arr/add", { method: "POST", body: JSON.stringify({ type: "movie", id: it.id, title: it.title, year: it.year, ...q }) })
    : await api("/api/arr/add-seasons", { method: "POST", body: JSON.stringify({ id: it.id, title: it.title, year: it.year, seasons: seasons ?? "all", ...q }) });
  markRequested(it);
  return r;
}

// ── Quality (Radarr / Sonarr quality profiles) ─────────────────────────────
// The quality to download in, as in Downloads > Search & Add: 1080p unless
// the person picked another one last time (per films / series).
const qualityRank = (name) => {
  const n = String(name).toLowerCase();
  return /\b(2160p|4k|ultra[\s-]?hd|uhd)\b/.test(n) ? 0 : /720p.*1080p?/.test(n) ? 4 : /\b(1080p?|hd[-\s]?1080)\b/.test(n) ? 6 : /\b720p?\b/.test(n) ? 3 : /\b(480p|sd)\b/.test(n) ? 2 : /\b(any|all|everything)\b/.test(n) ? 1 : 3;
};
function useQuality(kind) {
  const type = kind === "movie" ? "movie" : "series";
  const [profiles, setProfiles] = useState(null);
  const [pick, setPick] = useState(null);
  useEffect(() => {
    api(`/api/arr/quality-profiles?type=${type}`).then((r) => {
      const list = r.profiles ?? [];
      setProfiles(list);
      const kept = store.get(`nxw_quality_${type}`, null);
      const best = list.find((p) => p.id === kept) ?? list.reduce((a, b) => (a && qualityRank(a.name) >= qualityRank(b.name) ? a : b), null);
      setPick(best?.id ?? null);
    }).catch(() => setProfiles([]));
  }, [type]);
  const choose = (id) => { setPick(id); store.set(`nxw_quality_${type}`, id); };
  return { profiles, pick, choose };
}
function QualityChips({ q }) {
  if (q.profiles == null) return <div className="nxw-muted">Looking up qualities…</div>;
  if (!q.profiles.length) return null;
  return (
    <>
      <div className="nxw-seasons-head">Quality</div>
      <div className="nxw-chips" role="radiogroup" aria-label="Quality">
        {q.profiles.map((p) => (
          <button key={p.id} role="radio" aria-checked={q.pick === p.id} className={`nxw-chip ${q.pick === p.id ? "on" : ""}`} onClick={() => q.choose(p.id)}>
            {p.name}{p.sizeHint ? <span className="nxw-dim"> · {p.sizeHint}</span> : null}
          </button>
        ))}
      </div>
    </>
  );
}
function MoviePicker({ item, onDone, onCancel }) {
  const q = useQuality("movie");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await requestTitle(item, undefined, q.pick);
      toast(`${item.title} requested — it appears in Movies & TV when it's downloaded`);
      onDone();
    } catch (e) { toast(String(e.message ?? e), "err"); setBusy(false); }
  };
  return (
    <div className="nxw-seasons">
      <QualityChips q={q} />
      <div className="nxw-actions">
        <button className="nxw-btn primary" disabled={busy || q.profiles == null} onClick={send}><Icon name="down" /> {busy ? "Requesting…" : "Get it"}</button>
        <button className="nxw-btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function SeasonPicker({ item, onDone, onCancel }) {
  const q = useQuality("tv");
  const [seasons, setSeasons] = useState(null);
  const [pick, setPick] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/api/arr/series/lookup/${item.id}?title=${encodeURIComponent(item.title)}${item.year ? `&year=${item.year}` : ""}`)
      .then((r) => setSeasons(r.seasons ?? [])).catch(() => setSeasons([]));
  }, [item.id]);
  const send = async (which) => {
    setBusy(true);
    try {
      await requestTitle(item, which, q.pick);
      toast(`${item.title} is on its way — it appears in Movies & TV when it's downloaded`);
      onDone();
    } catch (e) { toast(String(e.message ?? e), "err"); setBusy(false); }
  };
  return (
    <div className="nxw-seasons">
      <QualityChips q={q} />
      <div className="nxw-seasons-head">Which seasons?</div>
      {seasons == null ? <div className="nxw-muted">Looking up seasons…</div> : (
        <div className="nxw-chips">
          {seasons.map((s) => {
            const hasFiles = (s.episodeFileCount ?? 0) > 0;
            return (
              <button key={s.seasonNumber} className={`nxw-chip ${pick.has(s.seasonNumber) ? "on" : ""} ${hasFiles ? "has-files" : ""}`}
                onClick={() => setPick((p) => { const n = new Set(p); n.has(s.seasonNumber) ? n.delete(s.seasonNumber) : n.add(s.seasonNumber); return n; })}>
                Season {s.seasonNumber}{hasFiles ? <span className="nxw-dim"> · In Library</span> : s.episodeCount ? <span className="nxw-dim"> · {s.episodeCount} ep</span> : null}
              </button>
            );
          })}
        </div>
      )}
      <div className="nxw-actions">
        <button className="nxw-btn primary" disabled={busy} onClick={() => send("all")}><Icon name="down" /> All seasons</button>
        <button className="nxw-btn" disabled={busy || !pick.size} onClick={() => send([...pick].sort((a, b) => a - b))}>Get {pick.size || ""} selected</button>
        <button className="nxw-btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** "Get it" for anything not in the library, or "Get other seasons" for shows already partially present. */
export function GetButton({ item, compact = false, buttonText = "Get it" }) {
  const arr = useArr();
  const [state, setState] = useState(isRequested(item) ? "done" : "idle");
  const [seasons, setSeasons] = useState(false);
  const [quality, setQuality] = useState(false);
  if (!arr?.configured) return null;
  if (state === "done" && buttonText === "Get it") return <button className={`nxw-btn ${compact ? "sm" : ""} done`} disabled><Icon name="check" /> Requested</button>;
  const go = async (e) => {
    e?.stopPropagation();
    if (item.type === "tv") { setSeasons(true); return; }
    setQuality(true);
  };
  return (
    <>
      <button className={`nxw-btn ${compact ? "sm" : ""} get`} disabled={state === "busy"} onClick={go}>
        <Icon name="down" /> {state === "busy" ? "Requesting…" : buttonText}
      </button>
      {seasons && (
        <div className="nxw-pop" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setSeasons(false); }}>
          <div className="nxw-pop-card">
            <SeasonPicker item={item} onDone={() => { setSeasons(false); setState("done"); }} onCancel={() => setSeasons(false)} />
          </div>
        </div>
      )}
      {quality && (
        <div className="nxw-pop" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setQuality(false); }}>
          <div className="nxw-pop-card">
            <MoviePicker item={item} onDone={() => { setQuality(false); setState("done"); }} onCancel={() => setQuality(false)} />
          </div>
        </div>
      )}
    </>
  );
}

// ── Cards and rows ───────────────────────────────────────────────────────
export function Poster({ src, title }) {
  const [ok, setOk] = useState(!!src);
  return ok
    ? <img className="nxw-poster-img" src={src} alt="" loading="lazy" decoding="async" onError={() => setOk(false)} />
    : <div className="nxw-poster-fallback"><Icon name="film" size={28} /><span>{title}</span></div>;
}

/** A TMDB title (discovery) or a library title (What to Watch) as a poster. */
export function Card({ item, onOpen, wide = false }) {
  const local = !!item.play;
  const inLib = local || !!item.inLibrary;
  const sub = item.reason || [item.year, item.genres?.[0]].filter(Boolean).join(" · ");
  return (
    <button className={`nxw-card ${wide ? "wide" : ""}`} onClick={() => onOpen(item)} title={item.title}>
      <div className="nxw-poster">
        {wide && item.backdrop ? <img className="nxw-poster-img" src={item.backdrop.replace("/w1280/", "/w780/")} alt="" loading="lazy" /> : <Poster src={item.poster} title={item.title} />}
        {item.rating ? <span className="nxw-rating"><Icon name="star" size={10} fill />{Number(item.rating).toFixed(1)}</span> : null}
        {inLib && <span className="nxw-badge lib"><Icon name="play" size={9} fill /> {local && item.newEpisodes ? `${item.newEpisodes} new` : "In library"}</span>}
        {!inLib && isRequested(item) && <span className="nxw-badge req"><Icon name="check" size={9} /> Requested</span>}
        {item.progress > 0 && item.progress < 100 && <span className="nxw-progress"><i style={{ width: `${item.progress}%` }} /></span>}
        <span className="nxw-hover"><Icon name={inLib ? "play" : "info"} size={22} fill={inLib} /></span>
      </div>
      <div className="nxw-card-title">{item.title}</div>
      <div className="nxw-card-sub">{local ? item.play.label : sub}</div>
    </button>
  );
}

export function Row({ title, subtitle, items, onOpen, onMore, wide = false, extra }) {
  const ref = useRef(null);
  const scroll = (dir) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });
  if (!items?.length) return null;
  return (
    <section className="nxw-row">
      <div className="nxw-row-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="nxw-row-tools">
          {extra}
          {onMore && <button className="nxw-link" onClick={onMore}>See all</button>}
          <button className="nxw-arrow" onClick={() => scroll(-1)} aria-label="Scroll left"><Icon name="left" /></button>
          <button className="nxw-arrow" onClick={() => scroll(1)} aria-label="Scroll right"><Icon name="right" /></button>
        </div>
      </div>
      <div className="nxw-strip" ref={ref}>
        {items.map((it) => <Card key={`${it.type ?? it.kind}-${it.id ?? it.key}`} item={it} onOpen={onOpen} wide={wide} />)}
      </div>
    </section>
  );
}

export function Skeleton({ rows = 3 }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, r) => (
        <section className="nxw-row" key={r}>
          <div className="nxw-row-head"><div className="nxw-skel-line" /></div>
          <div className="nxw-strip">{Array.from({ length: 8 }, (_, i) => <div className="nxw-card skel" key={i}><div className="nxw-poster" /></div>)}</div>
        </section>
      ))}
    </div>
  );
}

// ── Title sheet ──────────────────────────────────────────────────────────
const fmtRuntime = (m) => (m ? (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `${m}m`) : null);

/**
 * Full details for a title. `item` is either a TMDB result ({id,type}) or a
 * library card ({key, play, tmdbId}); a stack lets "More like this" open
 * inside the sheet and Back return.
 */
export function TitleSheet({ item, onClose }) {
  const [stack, setStack] = useState([item]);
  const cur = stack[stack.length - 1];
  const tmdb = cur.play ? (cur.tmdbId ? { id: cur.tmdbId, type: cur.tmdbType === "tv" ? "tv" : "movie" } : null) : { id: cur.id, type: cur.type };
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [trailer, setTrailer] = useState(false);
  const [play, setPlay] = useState(cur.play ? { ...cur.play, queue: cur.queue } : null);
  const body = useRef(null);

  useEffect(() => {
    setD(null); setErr(null); setTrailer(false);
    setPlay(cur.play ? { ...cur.play, queue: cur.queue } : null);
    body.current?.scrollTo?.({ top: 0 });
    if (!tmdb) return;
    let gone = false;
    api(`/api/discover/title?kind=${tmdb.type}&id=${tmdb.id}`).then((x) => {
      if (gone) return;
      setD(x);
      // A library title found from discovery: ask the library for the right
      // episode (resume point or next unwatched) to play.
      if (!cur.play && x.inLibrary?.key) {
        api(`/api/watch/next?key=${encodeURIComponent(x.inLibrary.key)}`).then((c) => !gone && setPlay({ ...c.play, queue: c.queue })).catch(() => {});
      }
    }).catch((e) => !gone && setErr(String(e.message ?? e)));
    return () => { gone = true; };
  }, [stack.length, cur.id, cur.key]);

  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") (stack.length > 1 ? setStack((s) => s.slice(0, -1)) : onClose()); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [stack.length, onClose]);

  const title = d?.title ?? cur.title;
  const backdrop = d?.backdrop ?? cur.backdrop;
  const facts = [d?.year ?? cur.year, d?.certification, fmtRuntime(d?.runtime ?? cur.runtime), d?.type === "tv" && d?.seasons?.length ? `${d.seasons.length} season${d.seasons.length > 1 ? "s" : ""}` : null].filter(Boolean);
  const reqItem = d ? { id: d.id, type: d.type, title: d.title, year: d.year } : (cur.play ? null : cur);

  return (
    <div className="nxw-sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="nxw-sheet" ref={body}>
        <div className="nxw-sheet-hero" style={backdrop ? { backgroundImage: `url(${backdrop})` } : undefined}>
          {trailer && d?.trailerKey && (
            <iframe className="nxw-trailer" title="Trailer" allow="autoplay; fullscreen; encrypted-media" allowFullScreen
              src={`https://www.youtube-nocookie.com/embed/${d.trailerKey}?autoplay=1&rel=0&modestbranding=1`} />
          )}
          <div className="nxw-sheet-top">
            {stack.length > 1 && <button className="nxw-round" onClick={() => setStack((s) => s.slice(0, -1))} aria-label="Back"><Icon name="left" /></button>}
            <span style={{ flex: 1 }} />
            <button className="nxw-round" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          </div>
        </div>
        <div className="nxw-sheet-body">
          <div className="nxw-sheet-main">
            <div className="nxw-sheet-poster"><Poster src={d?.poster ?? cur.poster} title={title} /></div>
            <div className="nxw-sheet-info">
              <h2>{title}</h2>
              {d?.tagline && <p className="nxw-tagline">{d.tagline}</p>}
              <div className="nxw-facts">
                {(d?.rating ?? cur.rating) ? <span className="nxw-star"><Icon name="star" size={12} fill /> {Number(d?.rating ?? cur.rating).toFixed(1)}</span> : null}
                {facts.map((f) => <span key={f}>{f}</span>)}
              </div>
              <div className="nxw-genres">{(d?.genres ?? cur.genres ?? []).map((g) => <span key={g}>{g}</span>)}</div>
              <div className="nxw-actions">
                {play && <button className="nxw-btn primary big" onClick={() => playLocal(play, play.queue)}><Icon name="play" fill /> {play.label ?? "Play"}</button>}
                {(!play || d?.type === "tv" || cur?.type === "tv" || cur?.kind === "series") && reqItem && (
                  <GetButton item={reqItem} buttonText={play ? "Get other seasons" : "Get it"} />
                )}
                {d?.trailerKey && <button className="nxw-btn" onClick={() => setTrailer((t) => !t)}><Icon name={trailer ? "x" : "film"} /> {trailer ? "Close trailer" : "Trailer"}</button>}
              </div>
              {d?.providers?.length > 0 && (
                <div className="nxw-providers">
                  <span>Streaming in SA on</span>
                  {d.providers.map((p) => p.logo ? <img key={p.name} src={p.logo} alt={p.name} title={p.name} /> : <b key={p.name}>{p.name}</b>)}
                </div>
              )}
              {d?.nextEpisode && <p className="nxw-muted">Next episode S{d.nextEpisode.season}E{d.nextEpisode.episode} airs {d.nextEpisode.date}</p>}
            </div>
          </div>
          <p className="nxw-overview">{d?.overview || cur.overview || (err ? "No details found for this title." : "")}</p>
          {d?.director && <p className="nxw-muted">{d.type === "tv" ? "Created by" : "Directed by"} {d.director}</p>}
          {!d && tmdb && !err && <div className="nxw-muted">Loading details…</div>}
          {d?.cast?.length > 0 && (
            <div className="nxw-cast">
              {d.cast.map((c) => (
                <div key={c.name + c.character} className="nxw-person">
                  {c.photo ? <img src={c.photo} alt="" loading="lazy" /> : <div className="nxw-person-blank">{c.name[0]}</div>}
                  <b>{c.name}</b><span>{c.character}</span>
                </div>
              ))}
            </div>
          )}
          {d?.recommendations?.length > 0 && (
            <Row title="More like this" items={d.recommendations} onOpen={(it) => setStack((s) => [...s, it])} />
          )}
        </div>
      </div>
    </div>
  );
}

export function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const useOpen = () => {
  const [open, setOpen] = useState(null);
  return [open, useCallback((it) => setOpen(it), []), useCallback(() => setOpen(null), [])];
};
