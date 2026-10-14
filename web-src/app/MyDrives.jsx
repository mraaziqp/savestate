// My Drives (any member): connect your own Google Drive or WebDAV drive with
// a button, then browse, upload, download and organise it inside SaveState.
// Only you can open the drives you connect (server/drives.ts, connect.ts).
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useStyles, api, Icon, Note } from "./lib.jsx";
import { Pane, WebdavForm } from "./Drives.jsx";

const gb = (n) => (n == null ? "?" : n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(2)} TB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

export function MyDrives() {
  useStyles();
  const [cfg, setCfg] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [state, setState] = useState({ fs: "", path: "", version: 0 });
  const [other, setOther] = useState({ fs: "", path: "", version: 0 });
  const [busy, setBusy] = useState(false);
  const [webdav, setWebdav] = useState(false);
  const [msg, setMsg] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const out = { ok: q.get("drive_connected"), error: q.get("drive_error") };
      if (out.ok || out.error) {
        const u = new URL(window.location.href);
        u.searchParams.delete("drive_connected"); u.searchParams.delete("drive_error");
        window.history.replaceState(null, "", u.toString());
      }
      return out;
    } catch { return {}; }
  });

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api("/api/drives/connect/config"), api("/api/drives/my/accounts")]);
      setCfg(c); setAccounts(a.accounts);
      setState((s) => (s.fs && a.accounts.some((x) => x.name === s.fs) ? s : { ...s, fs: a.accounts[0]?.name ?? "", path: "" }));
    } catch (e) { setMsg({ error: e.status === 402 ? e.message : e.message }); setAccounts([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const connectGoogle = async () => {
    setBusy(true);
    try { const r = await api("/api/drives/connect/google", { method: "POST", body: { purpose: "personal" } }); window.location.href = r.url; }
    catch (e) { setMsg({ error: e.message }); setBusy(false); }
  };
  const disconnect = async (a) => {
    if (!window.confirm(`Disconnect ${a.label}? Nothing on the drive is deleted.`)) return;
    try { await api(`/api/drives/my/accounts/${encodeURIComponent(a.name)}`, { method: "DELETE" }); load(); } catch (e) { setMsg({ error: e.message }); }
  };
  const sources = useMemo(() => (accounts ?? []).map((a) => ({ id: a.name, label: a.label, short: a.label, space: a.total ? a : null })), [accounts]);

  return (
    <div className="nxa nxa-page" style={{ paddingBottom: 8 }}>
      <div className="nxa-card">
        <div className="nxa-card-head">
          <div><h3>My drives</h3>
            <p className="nxa-sub">Connect your own Google Drive (or a Nextcloud / WebDAV drive) and manage its files here: upload, download, make folders, rename, move. Only you can see the drives you connect.</p></div>
          <div className="nxa-row nxa-wrap">
            <button className="nxa-btn primary" disabled={busy || !cfg?.google} onClick={connectGoogle} title={cfg && !cfg.google ? "The host hasn't switched Google connections on yet" : ""}>
              {busy ? <Icon name="spinner" /> : <Icon name="cloud" />} Connect Google Drive</button>
            <button className="nxa-btn" onClick={() => setWebdav((v) => !v)}><Icon name="link" /> Other drive (WebDAV)</button>
          </div>
        </div>
        {cfg && !cfg.google && <Note>Google Drive connections aren't switched on for this host yet{cfg.isAdmin ? ": set up the Google app under Cloud Drives first" : "; ask the host"}. WebDAV drives work already.</Note>}
        {msg?.ok && <Note kind="ok">Connected {msg.ok}.</Note>}
        {msg?.error && <Note kind="bad">{msg.error}</Note>}
        {webdav && <WebdavForm purpose="personal" onDone={() => { setWebdav(false); setMsg({ ok: "your drive" }); load(); }} />}
        {accounts?.length > 0 && (
          <table className="nxa-table" style={{ marginTop: 10 }}><tbody>
            {accounts.map((a) => (
              <tr key={a.name}>
                <td><b>{a.label}</b> <span className="nxa-faint" style={{ fontSize: 12 }}>{a.type === "webdav" ? "WebDAV" : "Google Drive"}</span>{!a.ok && <span className="nxa-pill bad" style={{ marginLeft: 6 }}>Can't reach it; reconnect</span>}</td>
                <td className="nxa-faint" style={{ fontSize: 12 }}>{a.free != null ? `${gb(a.free)} free of ${gb(a.total)}` : ""}</td>
                <td style={{ textAlign: "right" }}><button className="nxa-btn sm" onClick={() => disconnect(a)}>Disconnect</button></td>
              </tr>
            ))}
          </tbody></table>
        )}
        {accounts?.length === 0 && cfg?.google && (
          <ol className="nxa-steps" style={{ marginTop: 14, paddingLeft: 0, listStyle: "none" }}>
            <li className="nxa-step"><div><b>Press "Connect Google Drive"</b><p>You go to Google's own sign-in page; SaveState never sees your password.</p></div></li>
            <li className="nxa-step"><div><b>Choose your account and allow access</b><p>If Google says the app isn't verified yet, choose Advanced, then Continue.</p></div></li>
            <li className="nxa-step"><div><b>You're back here with your drive open</b><p>Disconnect any time; nothing on the drive is touched.</p></div></li>
          </ol>
        )}
      </div>
      {accounts?.length > 0 && (
        <div className="nxa-row" style={{ alignItems: "stretch", gap: 14, flexWrap: "wrap" }}>
          <Pane side="Your drive" base="/api/drives/my" sources={sources} state={state} setState={setState} other={accounts.length > 1 ? other : { fs: "" }}
            onChanged={() => setOther((s) => ({ ...s, version: s.version + 1 }))} onOffload={() => {}} notice={(m) => setMsg({ ok: m })} />
          {accounts.length > 1 && <Pane side="Second drive" base="/api/drives/my" sources={sources} state={other.fs ? other : { ...other, fs: accounts[1].name }} setState={setOther} other={state}
            onChanged={() => setState((s) => ({ ...s, version: s.version + 1 }))} onOffload={() => {}} notice={(m) => setMsg({ ok: m })} />}
        </div>
      )}
    </div>
  );
}
