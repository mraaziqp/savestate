// The whole film and series library on Movies & TV, in one place.
//
// The compiled Movies & TV page (dist/assets/MediaHub-*.js; its source was
// lost) showed films only as "Recently Added" and "Recommended For You" plus
// rows per genre, and the library sends no genres for films, so those rows
// were always empty and every other film could only be found by searching.
// Series were one huge grid that buried everything below it. This section
// replaces that grid: Movies / TV Series tabs, a sort, compact cards (the
// page's own, so play, details and delete work as before) and "Show more".
//
// Compiled by build.mjs with a JSX factory the page provides (__nxh) and the
// page's React (__nxReact); no imports, because it is pasted into the chunk.
// Props: movies, series ([title, episodes][]), Movie and Series (the page's
// card components), and the page's handlers.

const PAGE = 48;
const SORTS = [["added", "Recently added"], ["az", "A to Z"], ["year", "Year"]];
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const kept = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };

function NxLibrary({ movies, series, Movie, Series, titleOf, yearOf, onPlayMovie, onDeleteMovie, onOpenMovie, onOpenSeries, onDeleteSeries }) {
  const { useState, useMemo, useEffect } = __nxReact;
  const [tab, setTab] = useState(() => kept("nx_library_tab", movies.length ? "movies" : "series"));
  const [sort, setSort] = useState(() => kept("nx_library_sort", "added"));
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [tab, sort]);

  const newest = (items) => Math.max(0, ...items.map((i) => new Date(i.updatedAt || 0).getTime()));
  const films = useMemo(() => {
    const list = movies.map((m) => ({ m, title: titleOf(m.name) || m.name, year: Number(yearOf(m.name)) || 0, added: new Date(m.updatedAt || 0).getTime() }));
    if (sort === "az") list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "year") list.sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));
    else list.sort((a, b) => b.added - a.added);
    return list.map((x) => x.m);
  }, [movies, sort, titleOf, yearOf]);
  const shows = useMemo(() => {
    const list = series.map(([title, eps]) => ({ title, eps, added: newest(eps), year: Math.min(...eps.map((e) => Number(yearOf(e.name)) || 9999)) }));
    if (sort === "az") list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "year") list.sort((a, b) => (b.year === 9999 ? 0 : b.year) - (a.year === 9999 ? 0 : a.year) || a.title.localeCompare(b.title));
    else list.sort((a, b) => b.added - a.added);
    return list;
  }, [series, sort, yearOf]);

  const items = tab === "movies" ? films : shows;
  const left = items.length - shown;
  const pill = (on) => `px-3 py-1.5 rounded-xl text-xs font-black transition-colors ${on ? "bg-cyan-400 text-black" : "bg-white/5 text-white/60 hover:text-white hover:bg-white/10"}`;

  return (
    <div className="space-y-3" id="nx-library">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2">
          <span className="w-1 h-3.5 rounded-full" style={{ background: "linear-gradient(180deg, #22D3EE, #A855F7)", boxShadow: "0 0 10px rgba(34,211,238,0.7)" }} />
          <span className="text-gradient-accent">Your library</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="tablist" aria-label="Library">
            <button role="tab" aria-selected={tab === "movies"} className={pill(tab === "movies")} onClick={() => { setTab("movies"); keep("nx_library_tab", "movies"); }}>Movies ({movies.length})</button>
            <button role="tab" aria-selected={tab === "series"} className={pill(tab === "series")} onClick={() => { setTab("series"); keep("nx_library_tab", "series"); }}>TV Series ({series.length})</button>
          </div>
          <div className="flex gap-1" role="group" aria-label="Sort">
            {SORTS.map(([k, label]) => (
              <button key={k} aria-pressed={sort === k} className={pill(sort === k)} onClick={() => { setSort(k); keep("nx_library_sort", k); }}>{label}</button>
            ))}
          </div>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-white/40">{tab === "movies" ? "No films yet." : "No series yet."}</p>
      ) : tab === "movies" ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3">
          {films.slice(0, shown).map((m) => <Movie key={m.id} item={m} onPlay={(x) => onPlayMovie(x, films)} onDelete={onDeleteMovie} onOpenDetail={onOpenMovie} />)}
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3">
          {shows.slice(0, shown).map((s) => <Series key={s.title} title={s.title} episodes={s.eps} onSelect={() => onOpenSeries(s.title, s.eps)} onDeleteSeries={onDeleteSeries} />)}
        </div>
      )}
      {left > 0 && (
        <div className="flex justify-center gap-2 pt-1">
          <button className={pill(false)} onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, left)} more</button>
          <button className={pill(false)} onClick={() => setShown(items.length)}>Show all {items.length}</button>
        </div>
      )}
    </div>
  );
}
