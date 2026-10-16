// Games > Mini Games: browser games made with the agent builder.
// Members play them; admins upload (a .html file or a .zip with index.html),
// edit, replace, give covers, remove, and create publish keys the agent builder
// uses to post games straight in. Server side: server/minigames.ts.
//
// A game runs in an iframe with the same sandbox the server sends (no
// allow-same-origin), so it can't touch the player's sign-in. Its localStorage
// is a stand-in the server injects; changes arrive here by postMessage and are
// kept per game on this device (nx_mg_save_<id>), then handed back in the
// iframe's address (#nxs=) the next time it opens.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useStyles, api, token, store, Icon, Note } from "./lib.jsx";

const SANDBOX = "allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
const SAVE_LIMIT = 2 * 1024 * 1024;
const size = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ago = (d) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  return s < 3600 ? "just now" : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 30 ? `${Math.round(s / 86400)} days ago` : new Date(d).toLocaleDateString();
};
// A colour pair from the title, for games without a cover.
const initials = (t) => { const w = String(t).split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] ?? "?").slice(0, 2)).toUpperCase(); };
const hue = (t) => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

const CSS = `
.nxmg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
.nxmg-card{position:relative;display:flex;flex-direction:column;border-radius:18px;overflow:hidden;border:1px solid var(--line);background:rgba(255,255,255,.035);text-align:left;padding:0;color:inherit;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
.nxmg-card:hover,.nxmg-card:focus-within{transform:translateY(-4px);border-color:rgba(34,211,238,.45);box-shadow:0 18px 40px rgba(0,0,0,.45)}
.nxmg-art{aspect-ratio:16/10;display:grid;place-items:center;position:relative;overflow:hidden;cursor:pointer;border:0;padding:0;width:100%;color:#fff}
.nxmg-art img{width:100%;height:100%;object-fit:cover;display:block}
.nxmg-art .nxmg-initial{font-size:54px;font-weight:900;letter-spacing:-.04em;text-shadow:0 6px 24px rgba(0,0,0,.35)}
.nxmg-art .nxmg-play{position:absolute;inset:auto 12px 12px auto;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);opacity:0;transform:scale(.9);transition:all .18s ease}
.nxmg-card:hover .nxmg-play,.nxmg-art:focus-visible .nxmg-play{opacity:1;transform:none}
.nxmg-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.nxmg-body b{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nxmg-body p{margin:0;font-size:12.5px;color:var(--dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nxmg-meta{font-size:11px;color:var(--faint)}
.nxmg-tools{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:8px}
.nxmg-drop{border:2px dashed var(--line);border-radius:16px;padding:22px;text-align:center;transition:border-color .15s,background .15s;cursor:pointer}
.nxmg-drop.on{border-color:var(--acc);background:rgba(34,211,238,.06)}
.nxmg-player{position:fixed;inset:0;z-index:6000;display:flex;flex-direction:column;background:#05060b}
.nxmg-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(10,12,22,.95)}
.nxmg-bar b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}
.nxmg-frame{flex:1;border:0;width:100%;background:#000;display:block}
.nxmg-code{display:block;font:12px ui-monospace,Consolas,monospace;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;color:#cbd5e1}
@media (max-width:640px){.nxmg-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.nxmg-art .nxmg-initial{font-size:38px}.nxmg-play{opacity:1!important;transform:none!important;width:36px!important;height:36px!important}}
`;

/** Upload raw bytes with progress (fetch can't report upload progress). */
function send(method, url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    const t = token();
    if (t) x.setRequestHeader("Authorization", `Bearer ${t}`);
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch { /* not json */ }
      x.status >= 200 && x.status < 300 ? resolve(data) : reject(new Error(data?.error ?? `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    x.send(file);
  });
}

function Art({ game, onPlay }) {
  const h = hue(game.title);
  return (
    <button className="nxmg-art" onClick={onPlay} aria-label={`Play ${game.title}`}
      style={game.coverUrl ? undefined : { background: `linear-gradient(135deg,hsl(${h} 70% 42%),hsl(${(h + 60) % 360} 75% 22%))` }}>
      {game.coverUrl ? <img src={game.coverUrl} alt="" loading="lazy" /> : <span className="nxmg-initial">{initials(game.title)}</span>}
      <span className="nxmg-play"><Icon name="game" size={20} /></span>
    </button>
  );
}

function Player({ game, onClose }) {
  const frame = useRef(null);
  const box = useRef(null);
  const [run, setRun] = useState(0);
  const key = `nx_mg_save_${game.id}`;
  const src = (() => {
    const saved = store.get(key);
    if (!saved || saved.length > SAVE_LIMIT) return game.playUrl;
    try { return `${game.playUrl}#nxs=${encodeURIComponent(btoa(unescape(encodeURIComponent(saved))))}`; } catch { return game.playUrl; }
  })();

  useEffect(() => {
    api(`/api/minigames/${game.id}/played`, { method: "POST" }).catch(() => {});
    const onMsg = (e) => {
      if (e.source !== frame.current?.contentWindow || e.data?.nxMiniGame !== game.id) return;
      const json = JSON.stringify(e.data.save ?? {});
      if (json.length <= SAVE_LIMIT) store.set(key, json);
    };
    window.addEventListener("message", onMsg);
    document.body.style.overflow = "hidden";
    // Focus the game so the keyboard goes to it straight away.
    const t = setTimeout(() => frame.current?.focus(), 300);
    return () => { window.removeEventListener("message", onMsg); document.body.style.overflow = ""; clearTimeout(t); };
  }, [game.id]);

  const full = () => (document.fullscreenElement ? document.exitFullscreen() : box.current?.requestFullscreen?.())?.catch?.(() => {});
  return (
    <div className="nxmg-player" ref={box} role="dialog" aria-label={game.title}>
      <div className="nxmg-bar">
        <span style={{ color: "var(--acc)", display: "flex" }}><Icon name="game" /></span>
        <b>{game.title}</b>
        <button className="nxa-btn sm" onClick={() => setRun((n) => n + 1)} title="Start again"><Icon name="refresh" size={14} /> Restart</button>
        <button className="nxa-btn sm" onClick={full} title="Full screen"><Icon name="ext" size={14} /> Full screen</button>
        <button className="nxa-btn sm" onClick={onClose}>Close</button>
      </div>
      <iframe key={run} ref={frame} className="nxmg-frame" src={src} title={game.title} sandbox={SANDBOX}
        allow="fullscreen; gamepad; autoplay; clipboard-write; accelerometer; gyroscope" allowFullScreen referrerPolicy="no-referrer" />
    </div>
  );
}

function AddGame({ onAdded }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const pick = useRef(null);
  const choose = (f) => {
    setError("");
    if (!f) return;
    if (!/\.(html?|zip)$/i.test(f.name)) return setError("Choose a .html file or a .zip of the game.");
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  };
  const upload = async () => {
    setError(""); setProgress(0);
    try {
      const q = new URLSearchParams({ title, description }).toString();
      const r = await send("POST", `/api/minigames?${q}`, file, setProgress);
      setFile(null); setTitle(""); setDescription(""); setProgress(null);
      onAdded(r.game);
    } catch (e) { setError(e.message); setProgress(null); }
  };
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="plus" /> Add a game</h3>
        <p className="nxa-sub" style={{ margin: 0 }}>A single .html file, or a .zip of the game with its index.html. Everyone with an account can play it.</p></div></div>
      <div className={`nxmg-drop${over ? " on" : ""}`} onClick={() => pick.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files?.[0]); }}>
        <input ref={pick} type="file" accept=".html,.htm,.zip" hidden onChange={(e) => choose(e.target.files?.[0])} />
        {file ? <><b>{file.name}</b><div className="nxa-faint" style={{ fontSize: 12 }}>{size(file.size)} · click to choose another</div></>
          : <><Icon name="cloud" size={22} /><div style={{ marginTop: 6 }}><b>Drop the game here</b> or click to choose it</div></>}
      </div>
      {file && (
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <div className="nxa-field"><label>Title</label><input className="nxa-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></div>
          <div className="nxa-field"><label>Description <i>(optional)</i></label><textarea className="nxa-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></div>
          {progress != null && <div className="nxa-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${progress * 100}%` }} /></div>}
          <button className="nxa-btn primary" disabled={progress != null || !title.trim()} onClick={upload}>
            {progress != null ? <><Icon name="spinner" /> {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : "Unpacking…"}</> : <><Icon name="plus" /> Add game</>}
          </button>
        </div>
      )}
      {error && <div style={{ marginTop: 10 }}><Note kind="bad">{error}</Note></div>}
    </div>
  );
}

function PublishKeys() {
  const [keys, setKeys] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api("/api/minigames/keys").then((r) => setKeys(r.keys)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const create = async () => {
    setError("");
    try { const r = await api(`/api/minigames/keys?name=${encodeURIComponent("Agent builder")}`, { method: "POST" }); setFresh(r.rawKey); load(); } catch (e) { setError(e.message); }
  };
  const revoke = async (k) => {
    if (!confirm(`Revoke "${k.name}"? Anything using it can no longer publish games.`)) return;
    try { await api(`/api/minigames/keys/${k.id}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  };
  const origin = location.origin;
  const example = `curl -X POST "${origin}/api/minigames/publish?title=My%20Game&description=Made%20by%20the%20agent" \\\n  -H "X-SaveState-Publish-Key: ${fresh ?? "ssk_…"}" \\\n  -H "X-Filename: game.html" \\\n  -H "Content-Type: application/octet-stream" \\\n  --data-binary @game.html`;
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="key" /> Publish from the agent builder</h3>
        <p className="nxa-sub" style={{ margin: 0 }}>Give the agent builder a publish key and it can post finished games straight to this shelf (a .html file or a .zip). A key can only add games.</p></div></div>
      {fresh && <Note kind="ok">Copy this key now; it won't be shown again. <code className="nxmg-code" style={{ marginTop: 6 }}>{fresh}</code></Note>}
      <div className="nxa-row nxa-wrap" style={{ margin: "12px 0" }}>
        <button className="nxa-btn sm" onClick={create}><Icon name="plus" size={14} /> New publish key</button>
        {fresh && <button className="nxa-btn sm" onClick={() => navigator.clipboard?.writeText(fresh)}><Icon name="copy" size={14} /> Copy key</button>}
      </div>
      {keys?.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          {keys.map((k) => (
            <div key={k.id} className="nxa-row" style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span><b>{k.name}</b> <span className="nxa-faint">· made {ago(k.createdAt)} · {k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : "never used"}</span></span>
              <button className="nxa-btn sm danger" onClick={() => revoke(k)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
      <div className="nxa-label" style={{ marginBottom: 6 }}>How the agent builder sends a game</div>
      <code className="nxmg-code">{example}</code>
      <p className="nxa-faint" style={{ fontSize: 12, marginTop: 8 }}>The reply includes the game's link. For a zip, send <code>X-Filename: game.zip</code> and the zip file.</p>
      {error && <Note kind="bad">{error}</Note>}
    </div>
  );
}

function Edit({ game, onDone, onClose }) {
  const [title, setTitle] = useState(game.title);
  const [description, setDescription] = useState(game.description);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const coverPick = useRef(null);
  const filesPick = useRef(null);
  const run = async (label, fn) => { setBusy(label); setError(""); try { onDone(await fn()); } catch (e) { setError(e.message); } finally { setBusy(""); setProgress(null); } };
  const saveText = () => run("save", async () => (await api(`/api/minigames/${game.id}`, { method: "PATCH", body: { title, description } })).game);
  const cover = (f) => f && run("cover", async () => (await send("PUT", `/api/minigames/${game.id}/cover`, f)).game);
  const files = (f) => f && run("files", async () => (await send("PUT", `/api/minigames/${game.id}/files`, f, setProgress)).game);
  const remove = () => confirm(`Remove "${game.title}" for everyone?`) && run("delete", async () => { await api(`/api/minigames/${game.id}`, { method: "DELETE" }); return null; });
  return (
    <div className="nxa-card" style={{ borderColor: "rgba(34,211,238,.35)" }}>
      <div className="nxa-card-head"><div><h3>Edit {game.title}</h3><p className="nxa-sub" style={{ margin: 0 }}>{game.files} file{game.files === 1 ? "" : "s"} · {size(game.bytes)} · played {game.plays} time{game.plays === 1 ? "" : "s"}</p></div>
        <button className="nxa-btn sm" onClick={onClose}>Done</button></div>
      <div style={{ display: "grid", gap: 10 }}>
        <div className="nxa-field"><label>Title</label><input className="nxa-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></div>
        <div className="nxa-field"><label>Description</label><textarea className="nxa-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></div>
        {progress != null && <div className="nxa-progress"><i style={{ width: `${progress * 100}%` }} /></div>}
        <div className="nxa-row nxa-wrap">
          <button className="nxa-btn sm ok" disabled={!!busy || !title.trim()} onClick={saveText}>{busy === "save" ? <Icon name="spinner" /> : <Icon name="edit" size={14} />} Save</button>
          <button className="nxa-btn sm" disabled={!!busy} onClick={() => coverPick.current?.click()}>{busy === "cover" ? <Icon name="spinner" /> : <Icon name="star" size={14} />} {game.coverUrl ? "Change cover" : "Add a cover"}</button>
          <button className="nxa-btn sm" disabled={!!busy} onClick={() => filesPick.current?.click()}>{busy === "files" ? <Icon name="spinner" /> : <Icon name="refresh" size={14} />} Replace the game</button>
          <button className="nxa-btn sm danger" disabled={!!busy} onClick={remove}><Icon name="trash" size={14} /> Remove</button>
          <input ref={coverPick} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => cover(e.target.files?.[0])} />
          <input ref={filesPick} type="file" accept=".html,.htm,.zip" hidden onChange={(e) => files(e.target.files?.[0])} />
        </div>
        {error && <Note kind="bad">{error}</Note>}
      </div>
    </div>
  );
}

export function MiniGames() {
  useStyles();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(null);
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => api("/api/minigames").then((r) => { setData(r); setError(""); return r; }).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load().then((r) => {
      // ?game=<id> (the link the publish reply gives) opens that game.
      const want = new URLSearchParams(location.search).get("game");
      const g = want && r?.games?.find((x) => x.id === want);
      if (g) setPlaying(g);
    });
  }, [load]);
  const games = (data?.games ?? []).filter((g) => !q || `${g.title} ${g.description} ${g.author}`.toLowerCase().includes(q.toLowerCase()));
  const changed = (g) => { setEditing(g); load(); };

  return (
    <div className="nxa nxa-page">
      <style>{CSS}</style>
      <div className="nxa-card">
        <div className="nxa-card-head" style={{ alignItems: "center" }}>
          <div><h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20 }}><Icon name="game" /> Mini Games</h3>
            <p className="nxa-sub" style={{ margin: 0 }}>Games made with our agent builder. They play right here, on any device; nothing to install.</p></div>
          {data?.games?.length > 6 && <input className="nxa-input sm" style={{ maxWidth: 240 }} placeholder="Search games" value={q} onChange={(e) => setQ(e.target.value)} />}
        </div>
        {error && <Note kind="bad">{error}</Note>}
        {!data && !error && <p className="nxa-dim"><Icon name="spinner" /> Loading games…</p>}
        {data && data.games.length === 0 && <p className="nxa-dim" style={{ fontSize: 14 }}>No games yet.{data.canManage ? " Add the first one below, or let the agent builder publish one." : " Check back soon."}</p>}
        {games.length > 0 && (
          <div className="nxmg-grid">
            {games.map((g) => (
              <div key={g.id} className="nxmg-card">
                <Art game={g} onPlay={() => setPlaying(g)} />
                <div className="nxmg-body">
                  <b title={g.title}>{g.title}</b>
                  {g.description && <p>{g.description}</p>}
                  <span className="nxmg-meta">{g.author ? `${g.author} · ` : ""}{ago(g.createdAt)}{g.plays ? ` · ${g.plays} play${g.plays === 1 ? "" : "s"}` : ""}</span>
                  <div className="nxmg-tools">
                    <button className="nxa-btn sm primary" onClick={() => setPlaying(g)}><Icon name="game" size={14} /> Play</button>
                    {data.canManage && <button className="nxa-btn sm" onClick={() => setEditing(g)}><Icon name="edit" size={14} /> Edit</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {data?.canManage && editing && <Edit key={editing.id} game={editing} onDone={changed} onClose={() => setEditing(null)} />}
      {data?.canManage && <AddGame onAdded={() => load()} />}
      {data?.canManage && <PublishKeys />}
      {playing && <Player game={playing} onClose={() => { setPlaying(null); const u = new URL(location.href); if (u.searchParams.has("game")) { u.searchParams.delete("game"); history.replaceState(null, "", u); } }} />}
    </div>
  );
}
