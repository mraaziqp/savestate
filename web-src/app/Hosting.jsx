// Which machine serves savestate.co.za (top of Connections, admins), and the
// switch to move it (server/serving.ts). Refreshed every 15 s.
import React, { useState, useEffect } from "react";
import { api, Icon, Note } from "./lib.jsx";

const NAME = { pc: "this PC", nas: "the NAS" };
const LABEL = { pc: "PC", nas: "NAS" };

function Machine({ id, s, serving }) {
  const on = serving === id || serving === "both";
  const color = s?.error ? "#f87171" : on ? "#34d399" : "#94a3b8";
  const word = s?.error ? `Not reachable (${s.error})`
    : on ? "Serving savestate.co.za"
    : id === "nas" && s?.auto ? "Standing by: takes over by itself if the PC stops answering"
    : "Standing by";
  return (
    <div className="nxa-card" style={{ margin: 0, borderColor: color + "66" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 12, height: 12, borderRadius: 6, background: color, boxShadow: on ? `0 0 10px ${color}` : "none" }} />
        <strong>{id === "pc" ? "PC" : "NAS"}</strong>
      </div>
      <p style={{ margin: "6px 0 0", color }}>{word}</p>
    </div>
  );
}

export function Hosting() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = () => api("/api/host/serving").then((r) => { setS(r); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => clearInterval(t);
  }, []);
  async function move(to) {
    if (!confirm(`Serve savestate.co.za from ${NAME[to]}? It starts there first, so the site stays up; it takes up to a minute.`)) return;
    setBusy(to); setError("");
    try { setS(await api("/api/host/serving", { method: "POST", body: { to } })); }
    catch (e) { setError(e.message); } finally { setBusy(""); load(); }
  }
  const serving = s?.serving;
  const head = serving === "pc" || serving === "nas" ? `Running on the ${LABEL[serving]}`
    : serving === "both" ? "Both are serving: about to settle on one"
    : serving === "none" ? "Neither machine's tunnel is running" : "Checking…";
  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="cloud" /> Where SaveState runs</h3>
          <p className="nxa-sub" style={{ margin: 0 }}>The machine that answers savestate.co.za. Switching starts the other one first, so visitors never see it go down.</p></div>
        <div className="nxa-row nxa-wrap">
          <button className={`nxa-btn sm ${s?.mode === "pc" ? "primary" : ""}`} disabled={!!busy || !s || s.mode === "pc" || !!s.pc?.error} onClick={() => move("pc")}>
            {busy === "pc" ? <><Icon name="spinner" /> Moving…</> : "Run on the PC"}</button>
          <button className={`nxa-btn sm ${s?.mode === "nas" ? "primary" : ""}`} disabled={!!busy || !s || s.mode === "nas" || !!s.nas?.error} onClick={() => move("nas")}>
            {busy === "nas" ? <><Icon name="spinner" /> Moving…</> : "Run on the NAS"}</button>
        </div>
      </div>
      {error && <Note kind="bad">{error}</Note>}
      <p style={{ fontSize: 20, fontWeight: 700, margin: "4px 0 10px" }}>{head}{s?.here ? <span className="nxa-dim" style={{ fontSize: 13, fontWeight: 500 }}> · this page comes from the {LABEL[s.here]}</span> : null}</p>
      {busy && <Note kind="warn">Moving the site to {NAME[busy]}: waiting for its connection to come up, then the other one stops.</Note>}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <Machine id="pc" s={s?.pc} serving={serving} />
        <Machine id="nas" s={s?.nas} serving={serving} />
      </div>
    </div>
  );
}
