// What to Watch: answers "what do I put on now?" from the library itself —
// what you were in the middle of, the next episode, things like what you've
// been watching, what fits the time you have and the mood you're in — with a
// spin-the-wheel pick for when you can't decide.
import React, { useState, useEffect, useMemo, useRef } from "react";
import { api, store, playLocal, Icon, Row, Skeleton, TitleSheet, Toasts, useStyles, useOpen, Poster } from "./ui.jsx";

const TIMES = [
  { v: 0, label: "Any length" }, { v: 30, label: "30 min" }, { v: 60, label: "1 hour" }, { v: 120, label: "2 hours" },
];
const KINDS = [{ v: "all", label: "Everything" }, { v: "movie", label: "Films" }, { v: "series", label: "Shows" }];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Late night";
}

function Hero({ pick, onInfo, onSkip, spinning }) {
  if (!pick) return null;
  return (
    <div className={`nxw-hero ${spinning ? "spinning" : ""}`} style={pick.backdrop ? { backgroundImage: `url(${pick.backdrop})` } : undefined}>
      <div className="nxw-hero-shade" />
      <div className="nxw-hero-body">
        <div className="nxw-hero-poster"><Poster src={pick.poster} title={pick.title} /></div>
        <div className="nxw-hero-text">
          <span className="nxw-eyebrow">{pick.reason || "Tonight's pick"}</span>
          <h2>{pick.title}</h2>
          <div className="nxw-facts">
            {pick.rating ? <span className="nxw-star"><Icon name="star" size={12} fill /> {pick.rating.toFixed(1)}</span> : null}
            {pick.year && <span>{pick.year}</span>}
            {pick.runtime && <span>{pick.kind === "series" ? `${pick.runtime} min episodes` : `${pick.runtime} min`}</span>}
            {pick.kind === "series" && pick.episodes && <span>{pick.episodes} episodes</span>}
            {pick.genres?.map((g) => <span key={g}>{g}</span>)}
          </div>
          {pick.overview && <p className="nxw-hero-overview">{pick.overview}</p>}
          {pick.progress > 0 && pick.progress < 100 && <div className="nxw-hero-progress"><i style={{ width: `${pick.progress}%` }} /></div>}
          <div className="nxw-actions">
            <button className="nxw-btn primary big" onClick={() => playLocal(pick.play, pick.queue)}><Icon name="play" fill /> {pick.play.label}</button>
            <button className="nxw-btn" onClick={() => onInfo(pick)}><Icon name="info" /> Details</button>
            {onSkip && <button className="nxw-btn ghost" onClick={onSkip}><Icon name="skip" /> Not tonight</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The slot-machine reel shown while "Surprise me" picks. */
function Reel({ items }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    let n = 0, delay = 60, t;
    const tick = () => { n++; setI((x) => x + 1); delay *= 1.12; if (n < 22) t = setTimeout(tick, delay); };
    t = setTimeout(tick, delay);
    return () => clearTimeout(t);
  }, []);
  const show = [-1, 0, 1].map((o) => items[(i + o + items.length * 3) % items.length]);
  return (
    <div className="nxw-reel">
      {show.map((it, k) => <div key={k} className={`nxw-reel-cell ${k === 1 ? "mid" : ""}`}><Poster src={it?.poster} title={it?.title} /></div>)}
    </div>
  );
}

export function WhatToWatch() {
  useStyles();
  const [minutes, setMinutes] = useState(store.get("nxw_minutes", 0));
  const [kind, setKind] = useState(store.get("nxw_kind", "all"));
  const [mood, setMood] = useState(store.get("nxw_mood", ""));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const [spinning, setSpinning] = useState(false);
  const [open, setOpen, close] = useOpen();
  const poll = useRef(null);

  const load = () => {
    setError(null);
    return api(`/api/watch/home?minutes=${minutes}&kind=${kind}${mood ? `&mood=${mood}` : ""}`)
      .then((d) => { setData(d); setPick(null); setSkipped([]); return d; })
      .catch((e) => setError(String(e.message ?? e)));
  };
  useEffect(() => {
    store.set("nxw_minutes", minutes); store.set("nxw_kind", kind); store.set("nxw_mood", mood);
    setData(null);
    load();
  }, [minutes, kind, mood]);

  // While the library is still being matched to TMDB, refresh now and then
  // so genres, ratings and artwork fill in.
  useEffect(() => {
    clearTimeout(poll.current);
    if (data?.library?.enriching) poll.current = setTimeout(load, 8000);
    return () => clearTimeout(poll.current);
  }, [data]);

  const hero = pick ?? data?.hero ?? null;
  const pool = useMemo(() => (data?.shuffle ?? []).filter((x) => !skipped.includes(x.key)), [data, skipped]);

  const surprise = () => {
    if (!pool.length) return;
    setSpinning(true);
    // Weight toward well-rated and recently added titles, but anything can come up.
    const weights = pool.map((x) => 1 + (x.rating ?? 6) / 3 + (x.newEpisodes ? 1 : 0));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0), chosen = pool[0];
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) { chosen = pool[i]; break; } }
    setTimeout(() => { setPick({ ...chosen, reason: "🎲 Surprise pick" }); setSpinning(false); }, 2300);
  };
  const skip = () => {
    if (!hero) return;
    const next = [...skipped, hero.key];
    setSkipped(next);
    const rest = (data?.shuffle ?? []).filter((x) => !next.includes(x.key));
    setPick(rest.length ? { ...rest[Math.floor(Math.random() * rest.length)], reason: "How about this instead?" } : null);
  };

  const lib = data?.library;
  return (
    <div className="nxw nxw-page">
      <Toasts />
      <header className="nxw-head">
        <div>
          <h1>{greeting()} — what are we watching?</h1>
          <p className="nxw-muted">
            {lib ? `${lib.titles} titles in your library` : "Reading your library…"}
            {lib?.enriching ? ` · learning about them (${lib.enriching.done}/${lib.enriching.total})` : ""}
          </p>
        </div>
        <button className="nxw-btn surprise" onClick={surprise} disabled={spinning || !pool.length}><Icon name="dice" /> {spinning ? "Picking…" : "Surprise me"}</button>
      </header>

      <div className="nxw-filters">
        <div className="nxw-seg" role="group" aria-label="How long">
          <Icon name="clock" size={14} />
          {TIMES.map((t) => <button key={t.v} className={minutes === t.v ? "on" : ""} onClick={() => setMinutes(t.v)}>{t.label}</button>)}
        </div>
        <div className="nxw-seg" role="group" aria-label="Type">
          {KINDS.map((t) => <button key={t.v} className={kind === t.v ? "on" : ""} onClick={() => setKind(t.v)}>{t.label}</button>)}
        </div>
      </div>
      <div className="nxw-chips moods">
        {(data?.moods ?? []).map((m) => (
          <button key={m.id} className={`nxw-chip ${mood === m.id ? "on" : ""}`} onClick={() => setMood(mood === m.id ? "" : m.id)}>
            <span>{m.emoji}</span> {m.label}
          </button>
        ))}
      </div>

      {error && <div className="nxw-empty"><p>Couldn't load suggestions: {error}</p><button className="nxw-btn" onClick={load}>Try again</button></div>}
      {!data && !error && <><div className="nxw-hero skel" /><Skeleton rows={3} /></>}

      {data && (spinning ? <Reel items={pool.length ? pool : data.shuffle} /> : <Hero pick={hero} onInfo={setOpen} onSkip={pool.length > 1 ? skip : null} />)}

      {data && !data.rows.length && !hero && (
        <div className="nxw-empty">
          <p>Nothing in the library matches {mood || minutes || kind !== "all" ? "those filters" : "yet"}.</p>
          {(mood || minutes || kind !== "all") && <button className="nxw-btn" onClick={() => { setMood(""); setMinutes(0); setKind("all"); }}>Clear filters</button>}
        </div>
      )}

      {data?.rows.map((r) => <Row key={r.id} title={r.title} subtitle={r.subtitle} items={r.items} onOpen={setOpen} wide={r.id === "continue"} />)}

      {data?.trendingMissing?.length > 0 && (
        <Row title="Trending — not in your library yet" subtitle="Tap one to see it, or get it straight away"
          items={data.trendingMissing} onOpen={setOpen} />
      )}
      {open && <TitleSheet item={open} onClose={close} />}
    </div>
  );
}
