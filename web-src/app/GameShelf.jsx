// The Games tab's full list (replaces the compiled grid, build.mjs "game
// shelf"): systems along the top with their counts, search as you type, A-Z /
// recently played / most played, and a letter strip that jumps through the
// list. 3,791 games (2026-10-27) scroll smoothly: the browser skips drawing
// cards off screen (content-visibility), and the first 240 are drawn before
// the rest so the page shows at once. Every card stays in the page, so a
// controller moving down always finds the next row (boot.js navigation).
import React, { useState, useEffect, useMemo, useRef, useDeferredValue } from "react";
import { SYSTEMS } from "./systems.js";
import { norm } from "./devices.js";

const CSS = `
.nxs{display:flex;flex-direction:column;gap:12px}
.nxs-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.nxs-search{flex:1 1 220px;min-width:0;padding:11px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.35);color:#fff;font-size:15px;outline:none}
.nxs-search:focus{border-color:#22d3ee;box-shadow:0 0 0 3px rgba(34,211,238,.16)}
.nxs-sort{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.35);color:#fff;font-size:14px}
.nxs-count{color:rgba(255,255,255,.45);font-size:13px;white-space:nowrap}
.nxs-chips{display:flex;gap:6px;overflow-x:auto;padding:2px 2px 6px;scrollbar-width:thin}
.nxs-chip{flex:0 0 auto;padding:7px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(255,255,255,.75);font-size:13px;cursor:pointer;white-space:nowrap}
.nxs-chip b{color:rgba(255,255,255,.4);font-weight:500;margin-left:6px}
.nxs-chip[aria-pressed=true]{background:rgba(34,211,238,.16);border-color:rgba(34,211,238,.5);color:#fff}
.nxs-letters{position:sticky;top:0;z-index:5;display:flex;gap:2px;flex-wrap:wrap;padding:6px 4px;background:rgba(8,8,16,.85);backdrop-filter:blur(8px);border-radius:10px}
.nxs-letter{min-width:28px;padding:5px 6px;border:0;border-radius:7px;background:transparent;color:rgba(255,255,255,.6);font:600 12px/1 system-ui;cursor:pointer}
.nxs-letter:hover,.nxs-letter[aria-current=true]{background:rgba(34,211,238,.18);color:#fff}
.nxs-head{margin:14px 0 6px;color:rgba(255,255,255,.5);font:700 13px/1 system-ui;letter-spacing:.08em;scroll-margin-top:56px}
.nxs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
@media (max-width:640px){.nxs-grid{grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}}
.nxs-card{content-visibility:auto;contain-intrinsic-size:auto 250px;display:flex;flex-direction:column;gap:6px;padding:0;border:0;background:none;color:#fff;text-align:left;cursor:pointer;border-radius:12px}
.nxs-art{position:relative;aspect-ratio:3/4;border-radius:12px;overflow:hidden;background:#1a1a2e;box-shadow:0 4px 14px rgba(0,0,0,.35);transition:transform .15s ease}
.nxs-card:hover .nxs-art{transform:translateY(-2px)}
.nxs-art img{width:100%;height:100%;object-fit:cover;display:block}
.nxs-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:10px;text-align:center;font:700 14px/1.2 system-ui;color:rgba(255,255,255,.8)}
.nxs-sys{position:absolute;left:6px;bottom:6px;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.65);font:600 10px/1.4 system-ui;color:rgba(255,255,255,.85)}
.nxs-title{font-size:13px;line-height:1.25;color:rgba(255,255,255,.88);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nxs-empty{padding:40px 0;text-align:center;color:rgba(255,255,255,.5)}
`;

const NAMES = Object.fromEntries(SYSTEMS.map((s) => [s.id, s.name]));
const sysName = (p) => NAMES[norm(p)] ?? String(p ?? "").toUpperCase();
const played = (g) => { const t = Date.parse(g.lastPlayed ?? ""); return Number.isFinite(t) && t > 86400_000 ? t : 0; };
const letterOf = (t) => { const c = String(t ?? "").trim().charAt(0).toUpperCase(); return c >= "A" && c <= "Z" ? c : "#"; };
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

function Cover({ g }) {
  const [bad, setBad] = useState(false);
  const src = g.boxArt && !bad ? (window.nxThumb ? window.nxThumb(g.boxArt) : g.boxArt) : "";
  return (
    <div className="nxs-art" style={{ background: g.dominantColor || "#1a1a2e" }}>
      {src ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} /> : <div className="nxs-ph">{g.title}</div>}
      <span className="nxs-sys">{sysName(g.platform)}</span>
    </div>
  );
}

export function GameShelf({ games = [], platform = null, loading = false, onSelect }) {
  const [system, setSystem] = useState(() => platform ?? store.get("nx_shelf_system", ""));
  const [sort, setSort] = useState(() => store.get("nx_shelf_sort", "az"));
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());
  const [limit, setLimit] = useState(240);
  const [atLetter, setAtLetter] = useState("");
  const root = useRef(null);

  useEffect(() => { if (platform) setSystem(platform); }, [platform]);
  useEffect(() => { store.set("nx_shelf_system", system); store.set("nx_shelf_sort", sort); }, [system, sort]);

  const systems = useMemo(() => {
    const n = new Map();
    for (const g of games) n.set(g.platform, (n.get(g.platform) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [games]);
  const recent = useMemo(() => games.filter(played).length, [games]);

  const list = useMemo(() => {
    let l = games;
    if (system === "@recent") l = l.filter(played);
    else if (system) l = l.filter((g) => g.platform === system);
    if (q) l = l.filter((g) => String(g.title).toLowerCase().includes(q) || sysName(g.platform).toLowerCase().includes(q));
    l = [...l];
    if (sort === "recent" || system === "@recent") l.sort((a, b) => played(b) - played(a) || String(a.title).localeCompare(String(b.title)));
    else if (sort === "most") l.sort((a, b) => (b.playtime ?? 0) - (a.playtime ?? 0) || String(a.title).localeCompare(String(b.title)));
    else l.sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: "base", numeric: true }));
    return l;
  }, [games, system, sort, q]);

  // The first screens at once, the rest on the next idle moment.
  useEffect(() => {
    setLimit(240);
    if (list.length <= 240) return;
    const idle = window.requestIdleCallback ?? ((f) => setTimeout(f, 60));
    const id = idle(() => setLimit(Infinity));
    return () => (window.cancelIdleCallback ?? clearTimeout)(id);
  }, [list]);

  const grouped = sort === "az" && system !== "@recent";
  const sections = useMemo(() => {
    const shown = list.slice(0, limit);
    if (!grouped) return [["", shown]];
    const m = new Map();
    for (const g of shown) { const k = letterOf(g.title); if (!m.has(k)) m.set(k, []); m.get(k).push(g); }
    return [...m.entries()];
  }, [list, limit, grouped]);
  const letters = useMemo(() => (grouped ? [...new Set(list.map((g) => letterOf(g.title)))] : []), [list, grouped]);

  function jump(l) {
    setLimit(Infinity);
    setAtLetter(l);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const head = root.current?.querySelector(`[data-letter="${l}"]`);
      head?.scrollIntoView({ block: "start", behavior: "instant" });
      // A controller lands on that letter's first game.
      const first = head?.nextElementSibling?.querySelector("[data-gameid]");
      if (first && document.querySelector(".nx-controller-focus")) { document.querySelectorAll(".nx-controller-focus").forEach((x) => x.classList.remove("nx-controller-focus")); first.classList.add("nx-controller-focus"); first.focus({ preventScroll: true }); }
    }));
  }

  return (
    <div className="nxs" ref={root}>
      <style>{CSS}</style>
      <div className="nxs-top">
        <input className="nxs-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={loading ? "Loading games…" : `Search ${games.length.toLocaleString()} games`} aria-label="Search games" />
        <select className="nxs-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="az">A–Z</option>
          <option value="recent">Recently played</option>
          <option value="most">Most played</option>
        </select>
        <span className="nxs-count">{list.length.toLocaleString()} shown</span>
      </div>
      <div className="nxs-chips" role="group" aria-label="Systems">
        <button className="nxs-chip" aria-pressed={!system} onClick={() => setSystem("")}>All<b>{games.length.toLocaleString()}</b></button>
        {recent > 0 && <button className="nxs-chip" aria-pressed={system === "@recent"} onClick={() => setSystem("@recent")}>Recently played<b>{recent}</b></button>}
        {systems.map(([p, n]) => (
          <button key={p} className="nxs-chip" aria-pressed={system === p} onClick={() => setSystem(p)}>{sysName(p)}<b>{n}</b></button>
        ))}
      </div>
      {letters.length > 6 && !q && (
        <div className="nxs-letters" role="group" aria-label="Jump to letter">
          {letters.map((l) => <button key={l} className="nxs-letter" aria-current={atLetter === l} onClick={() => jump(l)}>{l}</button>)}
        </div>
      )}
      {!list.length && <p className="nxs-empty">{loading ? "Loading games…" : q ? `No game matches “${query}”.` : "No games here yet."}</p>}
      {sections.map(([l, gs]) => (
        <React.Fragment key={l || "all"}>
          {l && <h3 className="nxs-head" data-letter={l}>{l}</h3>}
          <div className="nxs-grid">
            {gs.map((g) => (
              <button key={g.id} className="nxs-card" data-gameid={g.id} onClick={() => onSelect?.(g)} title={`${g.title} (${sysName(g.platform)})`}>
                <Cover g={g} />
                <span className="nxs-title">{g.title}</span>
              </button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
