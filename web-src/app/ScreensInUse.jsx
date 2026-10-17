// "All your screens are in use": shown over the app when a film or show won't
// start because the plan's screens are taken (boot.js spots the refusal from
// the player, hls.js or a <video> that failed). It names the devices that are
// watching, lets the member stop one of them here, and points to Plans for
// more screens. Also shown when a game needs a plan the member isn't on, so
// they hear why before anything downloads.
import React, { useState, useEffect, useCallback } from "react";
import { useStyles, api, Icon, Note, goTab } from "./lib.jsx";

const CSS = `
.nxsc{position:fixed;inset:0;z-index:5600;background:rgba(3,4,10,.72);backdrop-filter:blur(6px);display:grid;place-items:center;padding:16px}
.nxsc-box{width:100%;max-width:480px;max-height:calc(100vh - 32px);overflow:auto;border-radius:20px;border:1px solid var(--line);background:#11131f;padding:22px;display:grid;gap:14px;animation:nxaRise .2s ease}
.nxsc h2{margin:0;font-size:20px;font-weight:900;letter-spacing:-.01em;display:flex;gap:10px;align-items:center}
.nxsc p{margin:0;color:var(--dim);font-size:14px;line-height:1.5}
.nxsc-dev{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:12px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.03)}
.nxsc-dev b{display:block;font-size:14px}.nxsc-dev small{color:var(--dim);font-size:12.5px}
.nxsc-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
@media (max-width:420px){.nxsc-dev{grid-template-columns:1fr}.nxsc-row .nxa-btn{flex:1}}
`;

const since = (t) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `for ${m} min` : `for ${Math.floor(m / 60)} h ${m % 60} min`;
};

export function ScreensInUse() {
  useStyles();
  const [open, setOpen] = useState(null); // { kind: "screens" | "plan", message, others?, limit? }
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try { setList(await api("/api/plans/streams")); } catch { setList(null); }
  }, []);

  useEffect(() => {
    const onScreens = (e) => {
      const d = e.detail ?? {};
      setDone(false); setError(""); setBusy("");
      setOpen({ kind: "screens", message: d.message ?? "", limit: d.limit ?? null });
      refresh();
    };
    const onPlan = (e) => {
      const d = e.detail ?? {};
      setDone(false); setError("");
      setOpen({ kind: "plan", message: d.message ?? "That's part of a paid plan." });
    };
    window.addEventListener("nexus:stream-limit", onScreens);
    window.addEventListener("nexus:plan-needed", onPlan);
    return () => { window.removeEventListener("nexus:stream-limit", onScreens); window.removeEventListener("nexus:plan-needed", onPlan); };
  }, [refresh]);

  if (!open) return <style>{CSS}</style>;
  const close = () => { setOpen(null); setList(null); };
  const plans = () => { close(); goTab("plans"); };

  async function stop(device) {
    setBusy(device); setError("");
    try {
      await api("/api/plans/streams/stop", { method: "POST", body: { device } });
      setDone(true);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }

  if (open.kind === "plan") {
    return (
      <div className="nxsc nxa" role="dialog" aria-modal="true" aria-label="Part of a paid plan" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        <style>{CSS}</style>
        <div className="nxsc-box">
          <h2><Icon name="game" size={22} /> Part of a paid plan</h2>
          <p>{open.message}</p>
          <div className="nxsc-row">
            <button className="nxa-btn" onClick={close}>Not now</button>
            <button className="nxa-btn primary" onClick={plans}>See plans</button>
          </div>
        </div>
      </div>
    );
  }

  const others = (list?.active ?? []).filter((s) => !s.thisDevice);
  const limit = list?.limit ?? open.limit;
  return (
    <div className="nxsc nxa" role="dialog" aria-modal="true" aria-label="All your screens are in use" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <style>{CSS}</style>
      <div className="nxsc-box">
        <h2><Icon name="film" size={22} /> {done ? "Ready to watch here" : "All your screens are in use"}</h2>
        {done ? (
          <p>That device has stopped. Press play again to watch here.</p>
        ) : (
          <p>
            Your plan plays on {limit === 1 ? "one screen" : `${limit ?? "a set number of"} screens`} at a time.
            {list?.introUntil && list.after != null && list.after < limit
              ? ` As a new member you have ${limit} until ${new Date(list.introUntil).toLocaleDateString(undefined, { day: "numeric", month: "long" })}, then ${list.after === 1 ? "one" : list.after}.`
              : ""}
            {" "}Stop watching on another device to watch here.
          </p>
        )}
        {!done && others.map((s) => (
          <div className="nxsc-dev" key={s.device}>
            <div>
              <b>{s.label.replace(/^an? /, (m) => m[0].toUpperCase() + m.slice(1))}{s.who ? ` · ${s.who}` : ""}</b>
              <small>{s.title ? `${s.title} · ` : ""}watching {since(s.since)}</small>
            </div>
            <button className="nxa-btn" disabled={!!busy} onClick={() => stop(s.device)}>
              {busy === s.device ? <Icon name="spinner" /> : <Icon name="x" />} Stop watching there
            </button>
          </div>
        ))}
        {!done && list && !others.length && <Note>The other screen has just become free. Press play again.</Note>}
        {!done && !list && open.message && <p>{open.message}</p>}
        {error && <Note kind="bad">{error}</Note>}
        <div className="nxsc-row">
          {!done && <button className="nxa-btn" onClick={plans}>More screens: see plans</button>}
          <button className="nxa-btn primary" onClick={close}>{done ? "OK" : "Close"}</button>
        </div>
      </div>
    </div>
  );
}
