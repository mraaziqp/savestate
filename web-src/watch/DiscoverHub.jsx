// Discover: everything worth knowing about that isn't in the library yet,
// with anything that already is marked playable. Rows for trends, acclaim,
// genres, streaming services and "because you have X", a filterable browser
// with endless paging, search across films and shows, and the original
// Discover page (requests, health check) kept under its own tab.
import React, { useState, useEffect, useRef, lazy, Suspense } from "react";
import { api, store, Icon, Row, Card, Skeleton, TitleSheet, GetButton, Toasts, useStyles, useOpen, useDebounced } from "./ui.jsx";
import { loadOldDiscover } from "old-discover";

const OldDiscover = lazy(() => loadOldDiscover().then((m) => ({ default: m.DiscoverFeed })));

const GENRES = {
  movie: [[28, "Action"], [12, "Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [99, "Documentary"], [18, "Drama"],
    [10751, "Family"], [14, "Fantasy"], [36, "History"], [27, "Horror"], [10402, "Music"], [9648, "Mystery"], [10749, "Romance"],
    [878, "Sci-Fi"], [53, "Thriller"], [10752, "War"], [37, "Western"]],
  tv: [[10759, "Action & Adventure"], [16, "Animation"], [35, "Comedy"], [80, "Crime"], [99, "Documentary"], [18, "Drama"],
    [10751, "Family"], [10762, "Kids"], [9648, "Mystery"], [10764, "Reality"], [10765, "Sci-Fi & Fantasy"], [10768, "War & Politics"], [37, "Western"]],
};
const SORTS = { movie: [["popularity.desc", "Most popular"], ["vote_average.desc", "Highest rated"], ["primary_release_date.desc", "Newest"], ["revenue.desc", "Biggest hits"]],
  tv: [["popularity.desc", "Most popular"], ["vote_average.desc", "Highest rated"], ["first_air_date.desc", "Newest"]] };
const LANGS = [["", "Any language"], ["en", "English"], ["ja", "Japanese"], ["ko", "Korean"], ["es", "Spanish"], ["fr", "French"], ["hi", "Hindi"], ["de", "German"], ["it", "Italian"]];

function Featured({ items, onOpen }) {
  const [i, setI] = useState(0);
  const list = items.filter((x) => x.backdrop).slice(0, 8);
  useEffect(() => {
    if (list.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % list.length), 8000);
    return () => clearInterval(t);
  }, [list.length]);
  const it = list[i];
  if (!it) return null;
  return (
    <div className="nxw-hero discover" style={{ backgroundImage: `url(${it.backdrop})` }} key={it.id}>
      <div className="nxw-hero-shade" />
      <div className="nxw-hero-body">
        <div className="nxw-hero-text">
          <span className="nxw-eyebrow">Trending #{i + 1}</span>
          <h2>{it.title}</h2>
          <div className="nxw-facts">
            {it.rating ? <span className="nxw-star"><Icon name="star" size={12} fill /> {it.rating.toFixed(1)}</span> : null}
            {it.year && <span>{it.year}</span>}
            {it.genres.map((g) => <span key={g}>{g}</span>)}
          </div>
          <p className="nxw-hero-overview">{it.overview}</p>
          <div className="nxw-actions">
            {it.inLibrary
              ? <button className="nxw-btn primary big" onClick={() => onOpen(it)}><Icon name="play" fill /> Watch now</button>
              : <GetButton item={it} />}
            {it.inLibrary && (it.type === "tv" || it.kind === "series") && (
              <GetButton item={it} buttonText="Get other seasons" />
            )}
            <button className="nxw-btn" onClick={() => onOpen(it)}><Icon name="info" /> Details</button>
          </div>
        </div>
      </div>
      <div className="nxw-dots">{list.map((x, k) => <button key={x.id} className={k === i ? "on" : ""} onClick={() => setI(k)} aria-label={`Show ${x.title}`} />)}</div>
    </div>
  );
}

function Rows({ kind, onOpen, onBrowse }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setData(null); setErr(null);
    api(`/api/discover/rows?kind=${kind}`).then(setData).catch((e) => setErr(String(e.message ?? e)));
  }, [kind]);
  if (err) return <div className="nxw-empty"><p>Couldn't reach TMDB: {err}</p></div>;
  if (!data) return <><div className="nxw-hero skel" /><Skeleton rows={4} /></>;
  const trending = data.rows.find((r) => r.id === "trending");
  return (
    <>
      {trending && <Featured items={trending.items} onOpen={onOpen} />}
      {data.rows.map((r) => (
        <Row key={r.id} title={r.title} items={r.items} onOpen={onOpen}
          onMore={r.browse ? () => onBrowse({ kind, ...r.browse }) : undefined} />
      ))}
    </>
  );
}

function Browse({ initial, onOpen }) {
  const [f, setF] = useState(() => ({ kind: "movie", sort: "popularity.desc", genre: "", yearFrom: "", yearTo: "", minRating: "", maxRuntime: "", provider: "", lang: "", country: "", ...store.get("nxw_browse", {}), ...(initial ?? {}) }));
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(null);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const sentinel = useRef(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v, ...(k === "kind" ? { genre: "", sort: "popularity.desc" } : {}) }));

  const fetchPage = (p, reset) => {
    setBusy(true);
    const q = new URLSearchParams(Object.entries({ ...f, page: p }).filter(([, v]) => v !== "" && v != null));
    api(`/api/discover/browse?${q}`).then((d) => {
      setItems((old) => {
        const merged = reset ? d.items : [...old, ...d.items];
        return merged.filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
      });
      setPage(p); setPages(d.totalPages); setTotal(d.total);
    }).catch(() => {}).finally(() => setBusy(false));
  };
  useEffect(() => { store.set("nxw_browse", f); setItems([]); fetchPage(1, true); }, [JSON.stringify(f)]);

  // Endless paging: load the next page as the end of the grid comes into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting && !busy && page < pages) fetchPage(page + 1, false); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [busy, page, pages, JSON.stringify(f)]);

  const years = Array.from({ length: new Date().getFullYear() - 1949 }, (_, i) => new Date().getFullYear() + 1 - i);
  return (
    <div>
      <div className="nxw-browse-filters">
        <div className="nxw-seg">
          <button className={f.kind === "movie" ? "on" : ""} onClick={() => set("kind", "movie")}>Films</button>
          <button className={f.kind === "tv" ? "on" : ""} onClick={() => set("kind", "tv")}>Shows</button>
        </div>
        <select value={f.genre} onChange={(e) => set("genre", e.target.value)}>
          <option value="">All genres</option>
          {GENRES[f.kind].map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select value={f.sort} onChange={(e) => set("sort", e.target.value)}>
          {SORTS[f.kind].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
        <select value={f.minRating} onChange={(e) => set("minRating", e.target.value)}>
          <option value="">Any rating</option><option value="6">★ 6+</option><option value="7">★ 7+</option><option value="8">★ 8+</option>
        </select>
        <select value={f.yearFrom} onChange={(e) => set("yearFrom", e.target.value)}>
          <option value="">From any year</option>{years.map((y) => <option key={y} value={y}>From {y}</option>)}
        </select>
        <select value={f.yearTo} onChange={(e) => set("yearTo", e.target.value)}>
          <option value="">To now</option>{years.map((y) => <option key={y} value={y}>To {y}</option>)}
        </select>
        {f.kind === "movie" && (
          <select value={f.maxRuntime} onChange={(e) => set("maxRuntime", e.target.value)}>
            <option value="">Any length</option><option value="95">Under 95 min</option><option value="120">Under 2 hours</option><option value="150">Under 2½ hours</option>
          </select>
        )}
        <select value={f.provider} onChange={(e) => set("provider", e.target.value)}>
          <option value="">Any service</option><option value="8">Netflix</option><option value="337">Disney+</option><option value="119">Prime Video</option><option value="350">Apple TV+</option><option value="1899">Max</option><option value="55">Showmax</option>
        </select>
        <select value={f.lang} onChange={(e) => set("lang", e.target.value)}>
          {LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
        <button className="nxw-link" onClick={() => setF({ kind: f.kind, sort: "popularity.desc", genre: "", yearFrom: "", yearTo: "", minRating: "", maxRuntime: "", provider: "", lang: "", country: "" })}>Reset</button>
      </div>
      {total != null && <p className="nxw-muted">{total.toLocaleString()} titles</p>}
      <div className="nxw-grid">
        {items.map((it) => <Card key={`${it.type}-${it.id}`} item={it} onOpen={onOpen} />)}
      </div>
      {busy && <div className="nxw-muted nxw-center">Loading…</div>}
      {!busy && items.length === 0 && total === 0 && <div className="nxw-empty"><p>Nothing matches those filters.</p></div>}
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}

function Search({ q, onOpen }) {
  const dq = useDebounced(q, 300);
  const [res, setRes] = useState(null);
  useEffect(() => {
    if (dq.trim().length < 2) { setRes(null); return; }
    let gone = false;
    api(`/api/discover/find?q=${encodeURIComponent(dq.trim())}`).then((d) => !gone && setRes(d.items)).catch(() => !gone && setRes([]));
    return () => { gone = true; };
  }, [dq]);
  if (res == null) return <div className="nxw-muted nxw-center">Searching…</div>;
  if (!res.length) return <div className="nxw-empty"><p>No films or shows called “{dq}”.</p></div>;
  const lib = res.filter((x) => x.inLibrary);
  return (
    <>
      {lib.length > 0 && <Row title="Already in your library" items={lib} onOpen={onOpen} />}
      <h3 className="nxw-h3">Results for “{dq}”</h3>
      <div className="nxw-grid">{res.map((it) => <Card key={`${it.type}-${it.id}`} item={it} onOpen={onOpen} />)}</div>
    </>
  );
}

export function DiscoverHub() {
  useStyles();
  const [tab, setTab] = useState(store.get("nxw_discover_tab", "movie"));
  const [q, setQ] = useState("");
  const [browseInit, setBrowseInit] = useState(null);
  const [open, setOpen, close] = useOpen();
  useEffect(() => { store.set("nxw_discover_tab", tab); }, [tab]);
  const toBrowse = (init) => { setBrowseInit({ ...init, _t: Date.now() }); setTab("browse"); setQ(""); window.scrollTo?.({ top: 0, behavior: "smooth" }); };
  const TABS = [["movie", "Films"], ["tv", "Shows"], ["browse", "Browse"], ["classic", "Requests & tools"]];

  return (
    <div className="nxw nxw-page">
      <Toasts />
      <header className="nxw-head">
        <div>
          <h1>Discover</h1>
          <p className="nxw-muted">Find something new — anything you already have plays straight away.</p>
        </div>
        <label className="nxw-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search films and shows…" />
          {q && <button onClick={() => setQ("")} aria-label="Clear"><Icon name="x" size={14} /></button>}
        </label>
      </header>
      {!q && (
        <nav className="nxw-tabs">
          {TABS.map(([id, label]) => <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
      )}
      {q ? <Search q={q} onOpen={setOpen} />
        : tab === "browse" ? <Browse key={browseInit?._t ?? "b"} initial={browseInit && (({ _t, ...r }) => r)(browseInit)} onOpen={setOpen} />
        : tab === "classic" ? <Suspense fallback={<div className="nxw-muted nxw-center">Loading…</div>}><OldDiscover /></Suspense>
        : <Rows kind={tab === "tv" ? "tv" : "movie"} onOpen={setOpen} onBrowse={toBrowse} />}
      {open && <TitleSheet item={open} onClose={close} />}
    </div>
  );
}
