// Downloads > Downloader setup (admins): Sonarr, Radarr, Prowlarr and
// qBittorrent in one place: are they connected, what is wrong if downloads
// stall, a one-press "find on this PC", and a beginner's guide with the
// official download links (server/downloader.ts).
import React, { useState, useEffect, useCallback } from "react";
import { useStyles, api, Icon, Note } from "./lib.jsx";

const GUIDE = [
  ["Install qBittorrent", "It does the downloading. In Tools > Options > Web UI, tick \"Web User Interface\" (port 8080) and either set a username and password or tick \"Bypass authentication for clients on localhost\"."],
  ["Install Prowlarr", "Open http://localhost:9696, then Indexers > Add Indexer and add a few public torrent sites (1337x, The Pirate Bay, YTS for films, EZTV for TV, Nyaa for anime). Several sites means a search still works when one is down."],
  ["Install Sonarr (TV) and Radarr (films)", "In each: Settings > Media Management > add a root folder (where finished shows and films go), and Settings > Download Clients > + > qBittorrent (host 127.0.0.1, port 8080)."],
  ["Link Prowlarr to them", "Prowlarr > Settings > Apps > + Sonarr and + Radarr, pasting each one's API key (Settings > General in Sonarr / Radarr). Prowlarr then hands them all its sites."],
  ["Connect SaveState", "Press \"Find on this PC\" below. SaveState reads Sonarr and Radarr's settings itself, sets a 5-seeder minimum so dead torrents are skipped, and replaces downloads that stall."],
];

function Problems({ list }) {
  if (!list?.length) return <p className="nxa-faint" style={{ margin: "6px 0 0", fontSize: 12.5 }}><Icon name="check" size={13} /> No problems</p>;
  return (
    <ul style={{ margin: "8px 0 0", paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
      {list.map((p, i) => (
        <li key={i} style={{ fontSize: 12.5, lineHeight: 1.45 }}>
          <span className={`nxa-pill ${p.level === "bad" ? "bad" : "warn"}`} style={{ marginRight: 6 }}>{p.level === "bad" ? "Problem" : "Note"}</span>
          {p.text}{p.fix && <div className="nxa-faint" style={{ marginTop: 2 }}>{p.fix}</div>}
        </li>
      ))}
    </ul>
  );
}

function ArrForm({ app, onSaved }) {
  const [url, setUrl] = useState(app.url || `http://127.0.0.1:${app.id === "sonarr" ? 8989 : 7878}`);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await api("/api/arr/config", { method: "POST", body: app.id === "sonarr" ? { sonarrUrl: url, sonarrApiKey: key } : { radarrUrl: url, radarrApiKey: key } });
      if (!(app.id === "sonarr" ? r.sonarrConnected : r.radarrConnected)) setErr(`Saved, but ${app.label} didn't answer with that address and key.`);
      onSaved();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <form className="nxa-row nxa-wrap" onSubmit={save} style={{ marginTop: 8 }}>
      <input className="nxa-input sm" style={{ width: 220 }} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Address" placeholder="http://127.0.0.1:8989" />
      <input className="nxa-input sm" style={{ width: 260 }} value={key} onChange={(e) => setKey(e.target.value.trim())} aria-label="API key" placeholder={app.configured ? "API key (leave blank to keep)" : "API key (Settings > General)"} />
      <button type="submit" className="nxa-btn sm primary" disabled={busy}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} Save & test</button>
      {err && <Note kind="warn">{err}</Note>}
    </form>
  );
}

function QbtForm({ app, onSaved }) {
  const [host, setHost] = useState(app.url || "http://127.0.0.1:8080");
  const [user, setUser] = useState("admin");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await api("/api/torrent/config", { method: "POST", body: { host, username: user, password: pass } });
      if (!r.connected) setErr("Saved, but qBittorrent didn't accept that address or login.");
      onSaved();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <form className="nxa-row nxa-wrap" onSubmit={save} style={{ marginTop: 8 }}>
      <input className="nxa-input sm" style={{ width: 200 }} value={host} onChange={(e) => setHost(e.target.value)} aria-label="Web UI address" />
      <input className="nxa-input sm" style={{ width: 130 }} value={user} onChange={(e) => setUser(e.target.value)} aria-label="Username" />
      <input className="nxa-input sm" style={{ width: 160 }} type="password" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Password" placeholder={app.configured ? "Password (blank: keep)" : "Password"} autoComplete="off" />
      <button type="submit" className="nxa-btn sm primary" disabled={busy}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} Save & test</button>
      {err && <Note kind="warn">{err}</Note>}
    </form>
  );
}

function AppCard({ app, onChanged, onSync, onRetest, onAddSites }) {
  const [edit, setEdit] = useState(false);
  const bad = app.problems.filter((p) => p.level === "bad").length;
  const state = !app.connected ? ["bad", app.configured ? "Not reachable" : "Not connected"] : bad ? ["bad", `${bad} problem${bad === 1 ? "" : "s"}`] : app.problems.length ? ["warn", "Working, with notes"] : ["ok", "Working"];
  return (
    <div className="nxa-card" style={{ padding: 16 }}>
      <div className="nxa-card-head" style={{ marginBottom: 0 }}>
        <div>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>{app.label} <span className={`nxa-pill ${state[0]}`}>{state[1]}</span>{app.version && <span className="nxa-faint" style={{ fontSize: 11, fontWeight: 500 }}>v{String(app.version).replace(/^v/i, "")}</span>}</h3>
          <p className="nxa-sub" style={{ margin: 0 }}>{app.what}
            {app.indexers != null && <> · {app.indexers} working site{app.indexers === 1 ? "" : "s"}</>}
            {app.downloadClients != null && <> · {app.downloadClients} download client{app.downloadClients === 1 ? "" : "s"}</>}
            {app.downloading != null && <> · {app.downloading} downloading{app.speedKBs ? `, ${app.speedKBs >= 1024 ? `${(app.speedKBs / 1024).toFixed(1)} MB/s` : `${app.speedKBs} kB/s`}` : ""}</>}
          </p>
        </div>
        <div className="nxa-row nxa-wrap">
          {(app.id === "sonarr" || app.id === "radarr" || app.id === "qbittorrent") && <button className="nxa-btn sm" onClick={() => setEdit((v) => !v)}><Icon name="edit" /> {app.configured ? "Change" : "Connect"}</button>}
          {app.id === "prowlarr" && app.connected && <>
            <button className="nxa-btn sm" onClick={onSync} title="Prowlarr > Settings > Apps must list Sonarr and Radarr"><Icon name="refresh" /> Send sites to Sonarr & Radarr</button>
            <button className="nxa-btn sm" onClick={onAddSites} title="Adds recommended public sites Prowlarr can reach (Knaben, The Pirate Bay, LimeTorrents...)"><Icon name="plus" /> Add more sites</button>
            <button className="nxa-btn sm" onClick={onRetest}><Icon name="bolt" /> Retry failing sites</button>
          </>}
          <a className="nxa-btn sm" href={app.download} target="_blank" rel="noreferrer"><Icon name="down" /> {app.connected ? "Official site" : "Download"}</a>
        </div>
      </div>
      {app.rootFolders?.length > 0 && <p className="nxa-faint" style={{ margin: "6px 0 0", fontSize: 12 }}>Library: {app.rootFolders.map((r) => `${r.path}${r.freeGb != null ? ` (${r.freeGb} GB free)` : ""}`).join(", ")}</p>}
      {app.indexerList?.length > 0 && <p className="nxa-faint" style={{ margin: "6px 0 0", fontSize: 12 }}>Sites: {app.indexerList.map((i) => `${i.name}${!i.enabled ? " (off)" : i.benchedUntil ? " (failing)" : ""}`).join(", ")}</p>}
      <Problems list={app.problems} />
      {edit && (app.id === "qbittorrent" ? <QbtForm app={app} onSaved={() => { setEdit(false); onChanged(); }} /> : <ArrForm app={app} onSaved={() => { setEdit(false); onChanged(); }} />)}
    </div>
  );
}

export function DownloaderSetup() {
  useStyles();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [guide, setGuide] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api("/api/admin/downloader"); setData(d); setOpen((o) => (o == null ? d.apps.some((a) => !a.connected || a.problems.some((p) => p.level === "bad")) : o)); }
    catch (e) { setMsg({ bad: e.message }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (url, done) => {
    setBusy(true); setMsg(null);
    try { const r = await api(url, { method: "POST" }); setMsg({ ok: done(r) }); await load(); }
    catch (e) { setMsg({ bad: e.message }); } finally { setBusy(false); }
  };
  const apps = data?.apps ?? [];
  const problems = apps.reduce((n, a) => n + a.problems.filter((p) => p.level === "bad").length + (a.connected ? 0 : 1), 0);

  return (
    <div className="nxa" style={{ marginBottom: 20 }}>
      <div className="nxa-card">
        <div className="nxa-card-head" style={{ marginBottom: open ? 12 : 0 }}>
          <div>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><Icon name="down" /> Downloader setup {data && (problems ? <span className="nxa-pill bad">{problems} to fix</span> : <span className="nxa-pill ok">All working</span>)}</h3>
            <p className="nxa-sub" style={{ margin: 0 }}>qBittorrent, Prowlarr, Sonarr and Radarr on the host PC: whether each is connected, and what to fix when downloads don't start or get stuck.</p>
          </div>
          <div className="nxa-row nxa-wrap">
            <button className="nxa-btn sm primary" disabled={busy} onClick={() => run("/api/admin/downloader/detect", (r) => (r.found.length ? `Found ${r.found.join(", ")} on this PC.` : "Nothing found on this PC. Install them first (see the guide)."))}>
              {busy ? <Icon name="spinner" /> : <Icon name="bolt" />} Find on this PC</button>
            <button className="nxa-btn sm" onClick={() => setGuide((v) => !v)}><Icon name="info" /> Guide</button>
            <button className="nxa-btn sm" onClick={() => { setOpen((v) => !v); load(); }}>{open ? "Hide" : "Show"}</button>
          </div>
        </div>
        {msg?.ok && <Note kind="ok">{msg.ok}</Note>}
        {msg?.bad && <Note kind="bad">{msg.bad}</Note>}
        {guide && (
          <ol className="nxa-steps" style={{ paddingLeft: 0, listStyle: "none", marginTop: 8 }}>
            {GUIDE.map(([t, d]) => <li key={t} className="nxa-step"><div><b>{t}</b><p>{d}</p></div></li>)}
          </ol>
        )}
        {open && !data && !msg?.bad && <p className="nxa-dim"><Icon name="spinner" /> Asking each app…</p>}
        {open && data && (
          <div style={{ display: "grid", gap: 10 }}>
            {apps.map((a) => (
              <AppCard key={a.id} app={a} onChanged={load}
                onSync={() => run("/api/admin/downloader/prowlarr-sync", () => "Prowlarr is sending its sites to Sonarr and Radarr.")}
                onRetest={() => run("/api/admin/downloader/prowlarr-retest", (r) => `Tested ${r.tested} site(s); ${r.failed} still failing.`)}
                onAddSites={() => run("/api/admin/downloader/prowlarr-add-sites", (r) => (r.added.length ? `Added ${r.added.join(", ")} and sent them to Sonarr and Radarr.` : "No new sites could be added from this connection.") + (r.skipped.length ? ` Not reachable from here: ${r.skipped.join(", ")}.` : ""))} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
