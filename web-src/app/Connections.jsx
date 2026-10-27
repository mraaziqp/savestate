// Connections (admins): whether Jarvis, the Agent Builder and the NAS host are
// live, and the log of what passes between them and SaveState
// (server/integrations.ts). Refreshed every 10 s while the page is open.
import React, { useState, useEffect } from "react";
import { useStyles, api, Icon, Note } from "./lib.jsx";

const COLOR = { up: "#34d399", degraded: "#fbbf24", down: "#f87171" };
const WORD = { up: "Live", degraded: "Live, with a problem", down: "Not reachable" };
const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function Connections() {
  useStyles();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  useEffect(() => {
    let live = true;
    const tick = () => api("/api/admin/integrations").then((r) => { if (live) { setData(r); setError(""); } }).catch((e) => live && setError(e.message));
    tick();
    const t = setInterval(() => { if (!document.hidden) tick(); }, 10_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!data && !error) return <div className="nxa nxa-page"><p className="nxa-dim"><Icon name="spinner" /> Checking…</p></div>;
  const events = (data?.events ?? []).filter((e) => !filter || e.service.startsWith(filter));
  return (
    <div className="nxa nxa-page">
      {error && <Note kind="bad">{error}</Note>}
      <div className="nxa-card">
        <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="link" /> Connections</h3>
          <p className="nxa-sub" style={{ margin: 0 }}>The assistant, the game builder and the NAS, checked every few seconds.
            {data?.today && ` Last 24 hours: ${data.today.calls} call(s) in, ${data.today.failed} failed.`}</p></div></div>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {(data?.services ?? []).map((s) => (
            <div key={s.id} className="nxa-card" style={{ margin: 0, borderColor: COLOR[s.state] + "55" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: COLOR[s.state], boxShadow: `0 0 8px ${COLOR[s.state]}` }} />
                <strong>{s.name}</strong><span className="nxa-dim" style={{ marginLeft: "auto" }}>{s.ms} ms</span>
              </div>
              <p style={{ margin: "6px 0 2px", color: COLOR[s.state] }}>{WORD[s.state]}</p>
              <p className="nxa-dim" style={{ margin: 0, fontSize: 13 }}>{s.detail}</p>
              <p className="nxa-sub" style={{ margin: "6px 0 0", fontSize: 12 }}>{s.what}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="nxa-card">
        <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="refresh" /> What's being sent</h3>
          <p className="nxa-sub" style={{ margin: 0 }}>Calls from Jarvis and Second Brain (signed with the brain key), the in-app assistant, Mini Games syncs and changes of state. Newest first; keys are never shown.</p></div>
          <div className="nxa-row nxa-wrap">
            {[["", "All"], ["Jarvis", "Jarvis"], ["Agent Builder", "Agent Builder"], ["NAS", "NAS"]].map(([v, l]) => (
              <button key={v} className={`nxa-btn sm ${filter === v ? "primary" : ""}`} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div></div>
        {!events.length && <p className="nxa-dim">Nothing yet since the server started.</p>}
        <div style={{ display: "grid", gap: 2, fontSize: 13 }}>
          {events.map((e, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "72px 150px 1fr auto", gap: 8, padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", alignItems: "baseline" }}>
              <span className="nxa-dim">{time(e.at)}</span>
              <span>{e.direction === "in" ? "← " : e.direction === "out" ? "→ " : "• "}{e.service}</span>
              <span style={{ wordBreak: "break-word", color: e.ok ? undefined : "#f87171" }}>{e.summary}</span>
              <span className="nxa-dim">{e.status ? `${e.status} · ${e.ms} ms` : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
