// Pause all (admins): one button for the PC back. Stops uploads, conversions,
// downloads, scans and the AI model (server/pause-all.ts); Resume starts
// exactly what it stopped. Bottom right on every page, out of the way of
// the phone tab bar and the music bar; hidden while a game is open.
import React, { useState, useEffect } from "react";
import { api } from "./lib.jsx";

const CSS = `
.nxpa{position:fixed;right:16px;bottom:88px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font:600 13px/1.2 system-ui}
.nxpa-btn{display:flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(12,12,24,.88);color:#fff;cursor:pointer;backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.nxpa-btn:hover{border-color:rgba(255,255,255,.3)}
.nxpa-btn[data-on=true]{background:rgba(245,158,11,.92);border-color:#fbbf24;color:#1a1204}
.nxpa-btn:disabled{opacity:.6;cursor:default}
.nxpa-note{max-width:280px;padding:8px 12px;border-radius:12px;background:rgba(12,12,24,.92);color:rgba(255,255,255,.85);font-weight:500;box-shadow:0 6px 20px rgba(0,0,0,.35)}
@media (min-width:1024px){.nxpa{bottom:24px}}
`;
const mins = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

export function PauseAll() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [game, setGame] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    let live = true;
    let allowed = true; // members are refused once, and not asked again
    const load = () => allowed && api("/api/admin/pause-all").then((s) => live && setState(s)).catch(() => { allowed = false; if (live) setState(null); });
    load();
    const t = setInterval(() => { tick((n) => n + 1); setGame(!!(window.__nxGameOpen || document.getElementById("ejs-game-container"))); if (!document.hidden) load(); }, 30_000);
    const g = setInterval(() => setGame(!!(window.__nxGameOpen || document.getElementById("ejs-game-container"))), 2000);
    return () => { live = false; clearInterval(t); clearInterval(g); };
  }, []);
  if (!state || game) return null;

  async function toggle() {
    setBusy(true); setNote("");
    try {
      const s = await api("/api/admin/pause-all", { method: "POST", body: { paused: !state.paused } });
      setState(s);
      setNote(s.paused ? `Paused: ${s.stopped?.join(", ") || "background work"}. Watching and playing still work.` : "Everything is running again.");
      setTimeout(() => setNote(""), 7000);
    } catch (e) { setNote(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="nxpa">
      <style>{CSS}</style>
      {note && <div className="nxpa-note" role="status">{note}</div>}
      <button className="nxpa-btn" data-on={state.paused} disabled={busy} onClick={toggle}
        title={state.paused ? "Start uploads, conversions, downloads and the AI model again" : "Stop uploads, conversions, downloads, scans and the AI model so the PC is all yours"}>
        {busy ? "…" : state.paused ? `▶ Resume (paused ${mins(state.since)})` : "⏸ Pause all"}
      </button>
    </div>
  );
}
