// Local cache (admin, on the Drives page): copies of films and games played
// from Google Drive, kept on a fast disk of this PC so they start at once the
// next time. Shows how full it is, what's in it, and its folder and size.
import React, { useState, useEffect, useCallback } from "react";
import { api, Icon, Note, when } from "./lib.jsx";

const gb = (n) => (n == null ? "?" : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(0)} MB` : `${Math.round((n || 0) / 1024)} KB`);

export function HotCache() {
  const [s, setS] = useState(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => api("/api/admin/hot-cache").then(setS).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(() => { if (!document.hidden) load(); }, 5000); return () => clearInterval(t); }, [load]);

  async function save(body) {
    setBusy(true); setError("");
    try { setS(await api("/api/admin/hot-cache", { method: "PUT", body })); setEdit(null); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function clear() {
    if (!confirm("Remove every local copy? Films and games stay on Google Drive; the next play of each fetches it again.")) return;
    setBusy(true);
    try { setS(await api("/api/admin/hot-cache/clear", { method: "POST" })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!s) return <div className="nxa-card"><h3>Local cache</h3>{error ? <Note kind="bad">{error}</Note> : <p className="nxa-dim"><Icon name="spinner" /> Loading…</p>}</div>;
  const max = s.maxGb * 1024 ** 3;
  const pct = Math.min(100, Math.round((s.usedBytes / max) * 100));
  const rate = s.hits + s.misses ? Math.round((s.hits / (s.hits + s.misses)) * 100) : null;
  const list = showAll ? s.recent : s.recent.slice(0, 6);
  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <h3>Local cache</h3>
        <button type="button" className={`nxa-switch ${s.enabled ? "on" : ""}`} role="switch" aria-checked={s.enabled} aria-label="Keep local copies" disabled={busy} onClick={() => save({ enabled: !s.enabled })} />
      </div>
      <p className="nxa-dim" style={{ marginTop: 4 }}>
        Films, episodes and games played from Google Drive are copied to this PC, so the next play starts at once and seeking doesn't wait on Google.
        The next episode is copied ahead, and games added through Add games stay here too. The oldest copies make room when it's full.
      </p>
      <div style={{ margin: "12px 0 6px", height: 10, borderRadius: 6, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg,var(--acc),var(--acc2))" }} />
      </div>
      <p className="nxa-faint" style={{ margin: 0 }}>
        {gb(s.usedBytes)} of {s.maxGb} GB · {s.files} file{s.files === 1 ? "" : "s"} · {gb(s.freeOnDisk)} free on that disk
        {rate != null ? ` · ${rate}% of plays from this PC since the last restart` : ""}
      </p>
      {s.copying && (
        <Note><Icon name="spinner" /> Copying {s.copying.name} ({s.copying.reason}): {gb(s.copying.done)} of {gb(s.copying.size)}{s.waiting ? `, ${s.waiting} more waiting` : ""}</Note>
      )}
      {s.lastError && <p className="nxa-faint" style={{ margin: "6px 0 0" }}>Last problem: {s.lastError}</p>}
      {error && <Note kind="bad">{error}</Note>}

      {list.length > 0 && (
        <table className="nxa-table" style={{ marginTop: 10 }}><tbody>
          {list.map((r) => (
            <tr key={r.name + r.usedAt}><td style={{ overflowWrap: "anywhere" }}>{r.name}</td><td className="nxa-faint">{gb(r.size)}</td>
              <td className="nxa-faint">{r.reason}{r.hits ? ` · played ${r.hits}×` : ""} · {when(r.usedAt)}</td></tr>
          ))}
        </tbody></table>
      )}
      {s.recent.length > 6 && <button className="nxa-link" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${s.recent.length}`}</button>}

      {edit ? (
        <form className="nxa-form" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); save({ dir: edit.dir, maxGb: Number(edit.maxGb) }); }}>
          <div className="nxa-field wide"><label>Folder <i>(on a local disk; an SSD is best)</i></label><input className="nxa-input sm" value={edit.dir} onChange={(e) => setEdit({ ...edit, dir: e.target.value })} /></div>
          <div className="nxa-field"><label>Size (GB)</label><input className="nxa-input sm" value={edit.maxGb} inputMode="numeric" onChange={(e) => setEdit({ ...edit, maxGb: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></div>
          <div className="nxa-row wide">
            <button className="nxa-btn primary" disabled={busy}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} Save</button>
            <button type="button" className="nxa-btn" onClick={() => setEdit(null)}>Cancel</button>
          </div>
          <p className="nxa-faint wide" style={{ margin: 0 }}>It always leaves {gb(s.keepFree)} free on that disk, whatever the size says.</p>
        </form>
      ) : (
        <div className="nxa-row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
          <button className="nxa-btn" onClick={() => setEdit({ dir: s.dir, maxGb: String(s.maxGb) })}><Icon name="edit" /> Folder and size</button>
          <button className="nxa-btn" disabled={busy || !s.files} onClick={clear}><Icon name="trash" /> Clear</button>
          <span className="nxa-faint" style={{ alignSelf: "center", overflowWrap: "anywhere" }}>{s.dir}</span>
        </div>
      )}
    </div>
  );
}
