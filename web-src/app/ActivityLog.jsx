// Activity log: what is happening right now (admins, with progress bars) and
// receipts for everything that finished (server/receipts.ts). Members see
// their own receipts; admins see everyone's and can export them.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useStyles, api, Icon, Note } from "./lib.jsx";

const KINDS = [["", "Everything"], ["upload", "Uploads"], ["freed", "Space freed"], ["download", "Downloads"], ["search", "Deep search"],
  ["payment", "Payments"], ["plan", "Plans & access"], ["profile", "Profiles"], ["key", "Keys"], ["library", "Library"], ["system", "System"]];
const ICON = { upload: "cloud", freed: "trash", download: "down", search: "bolt", payment: "star", plan: "users", profile: "user", key: "key", library: "film", system: "chip", account: "user", convert: "film" };
const size = (n) => (n == null ? "" : n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(2)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const eta = (s) => (!s || s <= 0 || s > 30 * 86400 ? "" : s > 86400 ? `${Math.round(s / 86400)} d` : s > 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s > 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const when = (d) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function Live() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let live = true;
    const tick = () => api("/api/activity/live").then((r) => live && setItems(r.items)).catch((e) => live && setError(e.message));
    tick();
    const t = setInterval(() => { if (!document.hidden) tick(); }, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);
  // Pause / Continue a Drive copy (admins; the same actions as on Cloud Drives).
  async function act(ids, action) {
    setBusy(ids.join(",") + action); setError("");
    try {
      // "video-prep" is the films being prepared for every device (server/videoprep.ts).
      for (const id of ids) await api(id === "video-prep" ? `/api/admin/video-prep/${action}` : `/api/admin/offload/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {} });
      setItems((await api("/api/activity/live")).items);
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  }
  const pausable = (items ?? []).filter((i) => i.jobId && i.actions?.includes("pause")).map((i) => i.jobId);
  const resumable = (items ?? []).filter((i) => i.jobId && i.actions?.includes("resume")).map((i) => i.jobId);
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="refresh" /> Happening now</h3>
        <p className="nxa-sub" style={{ margin: 0 }}>Uploads to Drive, downloads, media uploads and searches, refreshed every few seconds.</p></div>
        <div className="nxa-row nxa-wrap">
          {pausable.length > 1 && <button className="nxa-btn sm" disabled={!!busy} onClick={() => act(pausable, "pause")}>Pause all uploads</button>}
          {resumable.length > 0 && <button className="nxa-btn sm primary" disabled={!!busy} onClick={() => act(resumable, "resume")}>{resumable.length > 1 ? "Continue all" : "Continue"}</button>}
        </div></div>
      {error && <Note kind="bad">{error}</Note>}
      {!items && !error && <p className="nxa-dim"><Icon name="spinner" /> Checking…</p>}
      {items?.length === 0 && <p className="nxa-faint" style={{ fontSize: 13 }}>Nothing running right now.</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {items?.map((i, n) => (
          <div key={n} className="nxa-file" style={{ display: "block", minWidth: 0 }}>
            <div className="nxa-row nxa-wrap" style={{ justifyContent: "space-between", gap: 4 }}>
              <b style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}><Icon name={ICON[i.kind] ?? "info"} size={14} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</span></b>
              <span className="nxa-row" style={{ gap: 8 }}>
                <span className="nxa-faint" style={{ fontSize: 12 }}>{i.progress != null ? `${(i.progress * 100).toFixed(i.progress < 0.1 ? 1 : 0)}%` : ""}{i.speed ? ` · ${size(i.speed)}/s` : ""}{i.eta ? ` · ${eta(i.eta)} left` : ""}</span>
                {i.jobId && i.actions?.includes("pause") && <button className="nxa-btn sm" disabled={!!busy} onClick={() => act([i.jobId], "pause")}>Pause</button>}
                {i.jobId && i.actions?.includes("resume") && <button className="nxa-btn sm primary" disabled={!!busy} onClick={() => act([i.jobId], "resume")}>Continue</button>}
              </span>
            </div>
            {i.progress != null && <div className="nxa-progress" style={{ marginTop: 6 }} role="progressbar" aria-valuenow={Math.round(i.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, i.progress * 100)}%` }} /></div>}
            <small>{i.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

// Finished jobs with proof: for a folder copied to Drive, how many files were
// checked against the copy on Drive, what matched, what didn't, how long it
// took, and the file-by-file report.
const RESULT = {
  verified: { icon: "check", color: "var(--ok)", label: "Done and checked" },
  warn: { icon: "alert", color: "var(--warn)", label: "Needs a look" },
  failed: { icon: "alert", color: "var(--bad)", label: "Stopped" },
};
const COMPLETED_KINDS = [["", "Everything"], ["upload", "Copies & uploads"], ["download", "Downloads"], ["freed", "Space freed"], ["library", "Library"], ["convert", "Films prepared"]];

async function downloadReport(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem("nexus_token") ?? ""}` } });
  if (!r.ok) throw new Error("The report couldn't be downloaded.");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob());
  a.download = (r.headers.get("Content-Disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "report.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function Completed() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState("");
  const [refresh, setRefresh] = useState(() => () => {});
  useEffect(() => {
    let live = true;
    const tick = () => api("/api/activity/completed").then((r) => live && setItems(r.items)).catch((e) => live && setError(e.message));
    setRefresh(() => tick);
    tick();
    const t = setInterval(() => { if (!document.hidden) tick(); }, 30000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const shown = (items ?? []).filter((i) => !kind || i.kind === kind);
  const list = all ? shown : shown.slice(0, 12);
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="check" /> Completed</h3>
        <p className="nxa-sub" style={{ margin: 0 }}>Everything that finished, and how it was checked. A folder copied to Drive is marked done only after every file was compared with the copy on Drive.</p></div></div>
      <div className="nxa-row nxa-wrap" style={{ gap: 6, marginBottom: 10 }}>
        {COMPLETED_KINDS.map(([k, label]) => <button key={k} className={`nxa-btn sm${kind === k ? " primary" : ""}`} onClick={() => setKind(k)}>{label}</button>)}
      </div>
      {error && <Note kind="bad">{error}</Note>}
      {!items && !error && <p className="nxa-dim"><Icon name="spinner" /> Loading…</p>}
      {items && shown.length === 0 && <p className="nxa-faint" style={{ fontSize: 13 }}>Nothing finished here yet.</p>}
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr)" }}>
        {list.map((i) => {
          const r = RESULT[i.result] ?? RESULT.verified;
          const isOpen = open === i.id;
          return (
            <div key={i.id} className="nxa-file" style={{ display: "block", minWidth: 0, borderColor: isOpen ? "rgba(34,211,238,.35)" : undefined }}>
              <button onClick={() => setOpen(isOpen ? null : i.id)} style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }} aria-expanded={isOpen}>
                <div className="nxa-row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <b style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ color: r.color, display: "flex", flex: "none" }} title={r.label}><Icon name={r.icon} size={15} /></span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</span>
                  </b>
                  <span className="nxa-faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{i.finishedAt ? when(i.finishedAt) : ""}</span>
                </div>
                <small style={{ color: i.result === "verified" ? undefined : r.color }}>{i.summary}</small>
              </button>
              {isOpen && (
                <div style={{ marginTop: 10, display: "grid", gap: 6, fontSize: 13 }}>
                  {(i.from || i.to) && <div className="nxa-dim" style={{ wordBreak: "break-all" }}>{i.from}{i.from && i.to ? " → " : ""}{i.to}</div>}
                  {i.startedAt && <div className="nxa-row" style={{ justifyContent: "space-between" }}><span className="nxa-faint">Started</span><span>{when(i.startedAt)}</span></div>}
                  {i.facts.map(([k, v]) => (
                    <div key={k} className="nxa-row" style={{ justifyContent: "space-between", gap: 12 }}>
                      <span className="nxa-faint">{k}</span>
                      {k === "Full report"
                        ? <button className="nxa-link" onClick={() => downloadReport(v).catch((e) => setError(e.message))}>Download the file-by-file check</button>
                        : <span style={{ textAlign: "right" }}>{v}</span>}
                    </div>
                  ))}
                  {i.actions?.length > 0 && (
                    <div className="nxa-row nxa-wrap" style={{ gap: 8, marginTop: 4 }}>
                      {i.actions.map((a) => (
                        <button key={a.post} className={`nxa-btn sm${a.danger ? " danger" : ""}`} disabled={busy === a.post}
                          onClick={async () => {
                            if (a.ask && !window.confirm(a.ask)) return;
                            setBusy(a.post); setError("");
                            try { await api(a.post, { method: "POST", body: { confirm: i.id } }); setTimeout(refresh, 1500); }
                            catch (e) { setError(e.message); }
                            finally { setBusy(""); }
                          }}>
                          {busy === a.post ? <Icon name="spinner" /> : <Icon name={a.danger ? "trash" : "refresh"} />} {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {i.problems?.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <div className="nxa-label" style={{ marginBottom: 4 }}>Files that need another go (they are retried by themselves)</div>
                      <div style={{ maxHeight: 180, overflow: "auto", fontSize: 12 }} className="nxa-dim">{i.problems.map((p) => <div key={p} style={{ wordBreak: "break-all" }}>{p}</div>)}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {shown.length > 12 && <button className="nxa-link" style={{ marginTop: 10 }} onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${shown.length}`}</button>}
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
      {admin && <Completed />}
      <Receipts admin={admin} />
    </div>
  );
}
