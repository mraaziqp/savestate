// Activity log: what is happening right now (admins, with progress bars) and
// receipts for everything that finished (server/receipts.ts). Members see
// their own receipts; admins see everyone's and can export them.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useStyles, api, Icon, Note } from "./lib.jsx";

const KINDS = [["", "Everything"], ["upload", "Uploads"], ["freed", "Space freed"], ["download", "Downloads"], ["search", "Deep search"],
  ["payment", "Payments"], ["plan", "Plans & access"], ["profile", "Profiles"], ["key", "Keys"], ["library", "Library"], ["system", "System"]];
const ICON = { upload: "cloud", freed: "trash", download: "down", search: "bolt", payment: "star", plan: "users", profile: "user", key: "key", library: "film", system: "chip", account: "user" };
const size = (n) => (n == null ? "" : n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(2)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const eta = (s) => (!s || s <= 0 ? "" : s > 86400 ? `${Math.round(s / 86400)} d` : s > 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s > 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const when = (d) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function Live() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const tick = () => api("/api/activity/live").then((r) => live && setItems(r.items)).catch((e) => live && setError(e.message));
    tick();
    const t = setInterval(() => { if (!document.hidden) tick(); }, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="refresh" /> Happening now</h3>
        <p className="nxa-sub" style={{ margin: 0 }}>Uploads to Drive, downloads, media uploads and searches, refreshed every few seconds.</p></div></div>
      {error && <Note kind="bad">{error}</Note>}
      {!items && !error && <p className="nxa-dim"><Icon name="spinner" /> Checking…</p>}
      {items?.length === 0 && <p className="nxa-faint" style={{ fontSize: 13 }}>Nothing running right now.</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {items?.map((i, n) => (
          <div key={n} className="nxa-file" style={{ display: "block" }}>
            <div className="nxa-row" style={{ justifyContent: "space-between", gap: 8 }}>
              <b style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}><Icon name={ICON[i.kind] ?? "info"} size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</span></b>
              <span className="nxa-faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{i.progress != null ? `${(i.progress * 100).toFixed(i.progress < 0.1 ? 1 : 0)}%` : ""}{i.speed ? ` · ${size(i.speed)}/s` : ""}{i.eta ? ` · ${eta(i.eta)} left` : ""}</span>
            </div>
            {i.progress != null && <div className="nxa-progress" style={{ marginTop: 6 }} role="progressbar" aria-valuenow={Math.round(i.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, i.progress * 100)}%` }} /></div>}
            <small>{i.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function printReceipt(r) {
  const w = window.open("", "_blank", "width=480,height=640");
  if (!w) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Receipt #${r.id}</title><body style="font:14px system-ui,sans-serif;padding:24px;max-width:420px">
    <h2 style="margin:0 0 4px">SaveState</h2><p style="color:#666;margin:0 0 18px">Receipt #${r.id} · ${esc(when(r.at))}</p>
    <p><b>${esc(r.title)}</b></p><p>${esc(r.detail)}</p>
    ${r.amount_cents != null ? `<p style="font-size:20px"><b>${esc(r.currency ?? "ZAR")} ${(Number(r.amount_cents) / 100).toFixed(2)}</b></p>` : ""}
    ${r.actor ? `<p style="color:#666">By ${esc(r.actor)}</p>` : ""}<p style="color:#666">savestate.co.za</p>
    <script>print()</script></body>`);
  w.document.close();
}

function Receipts({ admin }) {
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState(admin ? "all" : "mine");
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const load = useCallback(async (append) => {
    setError("");
    try {
      const before = append && rows?.length ? `&before=${rows[rows.length - 1].id}` : "";
      const r = await api(`/api/receipts?limit=100&scope=${scope}${kind ? `&kind=${kind}` : ""}${before}`);
      setRows((old) => (append ? [...(old ?? []), ...r.receipts] : r.receipts));
      setMore(r.receipts.length === 100);
    } catch (e) { setError(e.message); }
  }, [kind, scope, rows]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { loadRef.current(false); const t = setInterval(() => { if (!document.hidden) loadRef.current(false); }, 30_000); return () => clearInterval(t); }, [kind, scope]);

  const shown = (rows ?? []).filter((r) => !search || `${r.title} ${r.detail}`.toLowerCase().includes(search.toLowerCase()));
  function exportCsv() {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["id,time,kind,title,detail,status,actor,size_bytes,amount,currency", ...shown.map((r) => [r.id, new Date(r.at).toISOString(), r.kind, r.title, r.detail, r.status, r.actor, r.bytes, r.amount_cents != null ? (Number(r.amount_cents) / 100).toFixed(2) : "", r.currency].map(q).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `savestate-receipts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="check" /> Receipts</h3>
        <p className="nxa-sub" style={{ margin: 0 }}>A permanent record of everything that finished: uploads confirmed on Drive, space freed, downloads, payments, and changes to plans, profiles and keys.</p></div>
        <div className="nxa-row nxa-wrap">
          {admin && <div className="nxa-seg" role="tablist">{[["all", "Everyone"], ["mine", "Mine"]].map(([id, l]) => <button key={id} className={scope === id ? "on" : ""} onClick={() => setScope(id)}>{l}</button>)}</div>}
          <button className="nxa-btn sm" onClick={exportCsv} disabled={!shown.length}><Icon name="down" /> Export CSV</button>
        </div>
      </div>
      <div className="nxa-row nxa-wrap" style={{ marginBottom: 10 }}>
        <select className="nxa-input sm" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What">
          {KINDS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
        </select>
        <input className="nxa-input sm nxa-grow" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search receipts" aria-label="Search receipts" style={{ minWidth: 160 }} />
      </div>
      {error && <Note kind="bad">{error}</Note>}
      {!rows && !error && <p className="nxa-dim"><Icon name="spinner" /> Loading…</p>}
      {rows && !shown.length && <p className="nxa-faint" style={{ fontSize: 13 }}>No receipts yet{kind ? " of this kind" : ""}. They appear here as things finish.</p>}
      <div style={{ display: "grid", gap: 6 }}>
        {shown.map((r) => (
          <div key={r.id} className="nxa-file" style={{ alignItems: "flex-start" }}>
            <span className={`nxa-pill ${r.status === "ok" ? "ok" : r.status === "warn" ? "warn" : "bad"}`} style={{ marginTop: 2 }}><Icon name={ICON[r.kind] ?? "info"} size={11} /></span>
            <div className="nxa-grow" style={{ minWidth: 0 }}>
              <b>{r.title}</b>{r.amount_cents != null && <b style={{ marginLeft: 8, color: "var(--ok)" }}>{r.currency ?? "ZAR"} {(Number(r.amount_cents) / 100).toFixed(2)}</b>}
              <small>{r.detail}</small>
              <small>{when(r.at)} · #{r.id}{r.actor ? ` · by ${r.actor}` : ""}</small>
            </div>
            <button className="nxa-btn sm" onClick={() => printReceipt(r)} title="Print or save as PDF"><Icon name="copy" size={12} /></button>
          </div>
        ))}
      </div>
      {more && <div className="nxa-row" style={{ marginTop: 10 }}><button className="nxa-btn sm" onClick={() => load(true)}>Show older</button></div>}
    </div>
  );
}

export function ActivityLog() {
  useStyles();
  const [admin, setAdmin] = useState(null);
  useEffect(() => { api("/api/plans/me").then((m) => setAdmin(!!m.isAdmin)).catch(() => setAdmin(false)); }, []);
  if (admin === null) return <div className="nxa nxa-page"><p className="nxa-dim"><Icon name="spinner" /> Loading…</p></div>;
  return (
    <div className="nxa nxa-page">
      {admin && <Live />}
      <Receipts admin={admin} />
    </div>
  );
}
