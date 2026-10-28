// Performance (admins, top of Connections): how the host serving this page
// and the NAS are running, from server/perf.ts. A verdict at the top, the
// latest numbers, and the last hours as small charts. Refreshed every 30 s.
import React, { useState, useEffect } from "react";
import { api, Icon, Note } from "./lib.jsx";

const STATE = {
  good: ["#34d399", "Running well"],
  busy: ["#fbbf24", "Busy"],
  struggling: ["#f87171", "Struggling"],
  starting: ["#60a5fa", "Measuring"],
};
const RANGES = [["1 h", 120], ["6 h", 720], ["24 h", 2880]];
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };

// A small line chart of one number over time (no library: an SVG polyline).
function Spark({ points, color, max }) {
  if (points.length < 2) return <div className="nxa-dim" style={{ fontSize: 12, height: 44 }}>Not enough yet</div>;
  const top = Math.max(max ?? 0, ...points, 1);
  const w = 240, h = 44;
  const d = points.map((v, i) => `${(i / (points.length - 1)) * w},${h - 2 - (v / top) * (h - 4)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: h, display: "block" }} aria-hidden="true">
      <polyline points={`0,${h} ${d} ${w},${h}`} fill={color + "22"} stroke="none" />
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({ label, value, unit, hint, points, color, max }) {
  return (
    <div className="nxa-card" style={{ margin: 0, padding: 12 }}>
      <div className="nxa-dim" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, margin: "2px 0 4px" }}>{value}<span className="nxa-dim" style={{ fontSize: 13, fontWeight: 500 }}> {unit}</span></div>
      <Spark points={points} color={color} max={max} />
      {hint && <div className="nxa-sub" style={{ fontSize: 11, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function HostPanel({ r, range }) {
  const h = r.history.slice(-range);
  const last = h[h.length - 1] || {};
  const pick = (k) => h.map((s) => Number(s[k]) || 0);
  const [color, word] = STATE[r.verdict.state] || STATE.starting;
  const perMin = (k) => Math.round((h.slice(-2).reduce((n, s) => n + (s[k] || 0), 0)));
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "4px 0 10px" }}>
        <span style={{ width: 12, height: 12, borderRadius: 6, background: color, boxShadow: `0 0 10px ${color}` }} />
        <strong style={{ color }}>{word}</strong>
        <span className="nxa-dim" style={{ fontSize: 13 }}>
          {r.host.name} · {r.host.platform} · {r.host.cpus} cores · {Math.round(r.host.memTotalMB / 102.4) / 10} GB RAM · SaveState {r.host.version} · up {ago(r.host.upSince)}
          {r.host.servingPublic ? " · serving savestate.co.za" : " · not serving the public site right now"}
        </span>
      </div>
      {r.verdict.notes.map((n) => <Note key={n} kind={r.verdict.state === "struggling" ? "bad" : "warn"}>{n}</Note>)}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Metric label="Answer time (95% faster than)" value={last.p95 ?? "–"} unit="ms" hint={`Typical ${last.p50 ?? "–"} ms`} points={pick("p95")} color="#60a5fa" />
        <Metric label="Requests per minute" value={perMin("requests")} unit="" hint={`${perMin("publicRequests")} from the internet · ${perMin("errors")} failed`} points={pick("requests")} color="#a78bfa" />
        <Metric label="CPU" value={last.cpu ?? "–"} unit="%" hint={`Load ${last.load1 ?? "–"}`} points={pick("cpu")} color="#f472b6" max={100} />
        <Metric label="Memory in use" value={last.memUsedPct ?? "–"} unit="%" hint={`SaveState uses ${last.rssMB ?? "–"} MB`} points={pick("memUsedPct")} color="#34d399" max={100} />
        <Metric label="Server stalls (worst)" value={last.loopMax ?? "–"} unit="ms" hint="How long requests waited on the server at worst. Under 200 ms is fine." points={pick("loopMax")} color="#fbbf24" />
        <Metric label="Free on the data disk" value={last.diskFreeGB ?? "–"} unit="GB" points={pick("diskFreeGB")} color="#22d3ee" />
      </div>
    </>
  );
}

export function Perf() {
  const [which, setWhich] = useState("nas");
  const [range, setRange] = useState(120);
  const [here, setHere] = useState(null);
  const [nas, setNas] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const tick = () => {
      api("/api/host/perf").then((r) => live && (setHere(r), setError(""))).catch((e) => live && setError(e.message));
      api("/api/host/perf/nas").then((r) => live && setNas(r)).catch(() => {});
    };
    tick();
    const t = setInterval(() => { if (!document.hidden) tick(); }, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  // When the NAS itself serves this page, "this host" is the NAS.
  const hereIsNas = here?.host?.lowMemory;
  const shown = which === "nas" && !hereIsNas ? nas : here;
  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="bolt" /> Performance</h3>
          <p className="nxa-sub" style={{ margin: 0 }}>How the host is coping: measured every 30 s, kept for 24 hours.</p></div>
        <div className="nxa-row nxa-wrap">
          {!hereIsNas && <>
            <button className={"nxa-btn sm" + (which === "nas" ? " primary" : "")} onClick={() => setWhich("nas")}>NAS</button>
            <button className={"nxa-btn sm" + (which === "here" ? " primary" : "")} onClick={() => setWhich("here")}>This PC</button>
          </>}
          {RANGES.map(([l, n]) => <button key={l} className={"nxa-btn sm" + (range === n ? " primary" : "")} onClick={() => setRange(n)}>{l}</button>)}
        </div>
      </div>
      {error && <Note kind="bad">{error}</Note>}
      {!shown && <p className="nxa-dim"><Icon name="spinner" /> Measuring…</p>}
      {shown && shown.reachable === false && <Note kind="bad">{shown.error} It needs to be switched on and connected to the home network; check its lights and cable, or restart it.</Note>}
      {shown && shown.reachable && !shown.history && <Note kind="warn">{shown.error}</Note>}
      {shown?.history && <HostPanel r={shown} range={range} />}
    </div>
  );
}
