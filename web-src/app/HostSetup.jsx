// Become a Host, at the top of the page: one button sets this PC up as a
// SaveState host from inside the app. The Windows app's launcher (17373) runs
// the installer with no window, no prompts and no admin rights (/host/setup in
// client-launcher.cjs) and this page shows each step, then the addresses.
// Without the app (an ordinary browser, a phone) the one thing to do is get it.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStyles, Icon, Note } from "./lib.jsx";

const LAUNCHER = "http://127.0.0.1:17373";
const FOLDERS = [
  { key: "mediaDir", label: "Films & series", hint: "The folder with your films and TV shows" },
  { key: "musicDir", label: "Music", hint: "Your music folder" },
  { key: "gamesDir", label: "Games", hint: "Your game files (ROMs), if you have any" },
];
const STEP_NAMES = ["Node.js", "SaveState", "Streaming tools", "Your folders", "Starting SaveState"];

async function launcher(pathname, opts = {}) {
  const r = await fetch(`${LAUNCHER}${pathname}`, { ...opts, signal: opts.signal ?? AbortSignal.timeout(opts.timeout ?? 8000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.canceled) throw Object.assign(new Error(data.error || "The SaveState app on this PC didn't answer."), { data });
  return data;
}

const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const notify = (title, body) => {
  try {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
  } catch { /* not available */ }
};

// Inside .nxa: the app's colours (the buttons' accent) are set there.
export function HostSetup() {
  return <div className="nxa"><HostSetupPanel /></div>;
}

function HostSetupPanel() {
  useStyles();
  const [app, setApp] = useState(null); // null = checking, false = no app, true = app with host setup
  const [st, setSt] = useState(null);
  const [folders, setFolders] = useState({});
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await launcher("/host/status", { timeout: 10000 });
      setSt(s);
      const running = s.job?.state === "running";
      if (wasRunning.current && !running && s.job) {
        if (s.job.state === "done") notify("SaveState Host is ready", `Open ${s.job.url || s.url} and create your owner account.`);
        else if (s.job.state === "failed") notify("SaveState Host setup stopped", s.job.error || "Open SaveState to see why.");
      }
      wasRunning.current = running;
      return s;
    } catch { return null; }
  }, []);

  // Is the SaveState app (with host setup) on this PC?
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const h = await launcher("/health", { timeout: 4000 });
        const ok = Array.isArray(h.features) && h.features.includes("host-setup");
        if (!alive) return;
        setApp(ok);
        if (ok) await refresh();
      } catch { if (alive) setApp(false); }
    })();
    return () => { alive = false; };
  }, [refresh]);

  // While setting up: every 2 s.
  useEffect(() => {
    if (st?.job?.state !== "running") return undefined;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [st?.job?.state, refresh]);

  const pick = async (key, label) => {
    setErr("");
    try {
      const r = await launcher("/pick-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "folder", title: `Choose your ${label} folder` }), timeout: 600000 });
      if (r.ok && r.path) setFolders((f) => ({ ...f, [key]: r.path }));
    } catch (e) { setErr(e.message); }
  };

  const start = async () => {
    setErr(""); setBusy("start");
    try {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    } catch { /* fine */ }
    try {
      await launcher("/host/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(folders), timeout: 90000 });
      setChoosing(false);
      wasRunning.current = true;
      await refresh();
    } catch (e) { setErr(e.message); }
    setBusy("");
  };

  const open = async () => {
    setErr("");
    try { await launcher("/host/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
    catch (e) { setErr(e.message); }
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* shown anyway */ }
  };

  const card = { display: "grid", gap: 14, padding: 20, marginBottom: 20 };
  const big = { fontSize: 16, padding: "12px 22px" };

  if (app === null) {
    return <div className="nxa-card" style={card}><p className="nxa-dim" style={{ margin: 0 }}>Checking this device…</p></div>;
  }

  // No app here: the only step is to get it.
  if (!app) {
    return (
      <div className="nxa-card" style={card}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Make your PC a SaveState host</h2>
          <p className="nxa-dim" style={{ margin: "6px 0 0" }}>
            {isPhone()
              ? "Hosting runs on a Windows PC. Open this page on that PC to set it up."
              : "Install the SaveState app on this PC, open it, and press “Set up this PC as a host”. The app does the rest: no commands and no admin rights."}
          </p>
        </div>
        {!isPhone() && (
          <div className="nxa-row nxa-wrap" style={{ gap: 10 }}>
            <a className="nxa-btn primary" style={big} href="/api/downloads/desktop?platform=windows"><Icon name="down" /> Get the SaveState app for Windows</a>
          </div>
        )}
        <p className="nxa-faint" style={{ margin: 0, fontSize: 13 }}>Linux or a NAS? The steps are in Help &amp; guides, under hosting.</p>
      </div>
    );
  }

  const job = st?.job;
  const running = job?.state === "running";
  const failed = job?.state === "failed";
  const ready = st?.installed && st?.running && !running;

  // Setting up: each step, as it happens.
  if (running) {
    const pct = Math.max(4, Math.round(((job.step || 0) / 5) * 100));
    return (
      <div className="nxa-card" style={card}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Setting up this PC as a host…</h2>
          <p className="nxa-dim" style={{ margin: "6px 0 0" }}>This takes a few minutes. You can keep using SaveState; you'll get a notification when it's done.</p>
        </div>
        <div className="nxa-meter" style={{ height: 8, borderRadius: 6, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg,#22d3ee,#6366f1)", transition: "width .6s" }} />
        </div>
        <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 8 }}>
          {STEP_NAMES.map((name, i) => {
            const n = i + 1;
            const done = (job.step || 0) > n;
            const now = (job.step || 0) === n;
            return (
              <li key={name} style={{ display: "flex", alignItems: "center", gap: 10, opacity: done || now ? 1 : 0.45 }}>
                <span style={{ width: 22, textAlign: "center" }}>{done ? "✅" : now ? <Icon name="spinner" /> : "○"}</span>
                <span style={{ fontWeight: now ? 700 : 500 }}>{name}</span>
              </li>
            );
          })}
        </ol>
        {job.lines?.length > 0 && <p className="nxa-faint" style={{ margin: 0, fontSize: 12, fontFamily: "ui-monospace,monospace" }}>{job.lines[job.lines.length - 1]}</p>}
      </div>
    );
  }

  // Ready: where it is, and what to do next.
  if (ready && !choosing) {
    const url = job?.state === "done" && job.url ? job.url : st.url;
    const lan = (job?.state === "done" && job.lanUrl) || st.lanUrl;
    return (
      <div className="nxa-card" style={card}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>{"✅"} This PC is a SaveState host</h2>
          <p className="nxa-dim" style={{ margin: "6px 0 0" }}>
            {job?.state === "done" ? "Set up and running. " : "Running. "}
            It starts by itself when you sign in to Windows.{st.version ? ` Version ${st.version}.` : ""}
          </p>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <div><span className="nxa-dim">On this PC: </span><b>{url}</b></div>
          {lan && <div><span className="nxa-dim">Phones and TVs on your Wi-Fi: </span><b>{lan}</b> <button className="nxa-btn sm" onClick={() => copy(lan)}>{copied ? "Copied" : "Copy"}</button></div>}
        </div>
        <div className="nxa-row nxa-wrap" style={{ gap: 10 }}>
          <button className="nxa-btn primary" style={big} onClick={open}><Icon name="ext" /> Open my host</button>
          <button className="nxa-btn" onClick={() => { setFolders({ ...st.folders }); setChoosing(true); }}>Change folders</button>
          <button className="nxa-btn" disabled={busy === "start"} onClick={() => { setFolders({ ...st.folders }); start(); }}>Update</button>
        </div>
        <Note>The first account you create on your host becomes its owner. If Windows asks whether SaveState may use the network, choose Allow so phones and TVs can reach it.</Note>
        {err && <Note kind="bad">{err}</Note>}
      </div>
    );
  }

  // Start (or choose folders, or try again).
  return (
    <div className="nxa-card" style={card}>
      <div>
        <h2 style={{ margin: 0, fontSize: 22 }}>{failed ? "Setup stopped" : st?.installed ? "SaveState Host isn’t running" : "Set up this PC as a host"}</h2>
        <p className="nxa-dim" style={{ margin: "6px 0 0" }}>
          {failed
            ? job.error
            : st?.installed
              ? "It's installed but not answering. Press the button to update it and start it again."
              : "Share your films, music and games with your phones, TVs and friends. SaveState installs everything it needs on this PC: no commands and no admin rights."}
        </p>
      </div>
      {st?.otherHost && !st?.installed && (
        <Note>SaveState is already running on this PC at {st.otherHost.url}. You only need this if you want a separate host here.</Note>
      )}
      {!st?.supported && <Note kind="bad">Setting up a host from the app works on Windows. On Linux or a NAS, follow the steps in Help &amp; guides.</Note>}
      {(choosing || failed || st?.installed) && st?.supported ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p className="nxa-dim" style={{ margin: 0 }}>Choose your folders (any of them can be added later):</p>
          {FOLDERS.map((f) => (
            <div key={f.key} className="nxa-row nxa-wrap" style={{ gap: 10, alignItems: "center" }}>
              <div style={{ minWidth: 140 }}><b>{f.label}</b><div className="nxa-faint" style={{ fontSize: 12 }}>{f.hint}</div></div>
              <div className="nxa-grow" style={{ fontSize: 13, wordBreak: "break-all" }}>{folders[f.key] || <span className="nxa-faint">Not chosen</span>}</div>
              <button className="nxa-btn sm" onClick={() => pick(f.key, f.label)}><Icon name="folder" /> {folders[f.key] ? "Change" : "Choose folder"}</button>
              {folders[f.key] && <button className="nxa-btn sm" onClick={() => setFolders((x) => ({ ...x, [f.key]: "" }))}>Clear</button>}
            </div>
          ))}
          <div className="nxa-row nxa-wrap" style={{ gap: 10, marginTop: 6 }}>
            <button className="nxa-btn primary" style={big} disabled={busy === "start"} onClick={start}>
              {busy === "start" ? "Starting…" : failed ? "Try again" : st?.installed ? "Update and start" : "Set up now"}
            </button>
            {choosing && ready && <button className="nxa-btn" onClick={() => setChoosing(false)}>Cancel</button>}
          </div>
        </div>
      ) : st?.supported && (
        <div className="nxa-row nxa-wrap">
          <button className="nxa-btn primary" style={big} onClick={() => setChoosing(true)}><Icon name="chip" /> Set up this PC as a host</button>
        </div>
      )}
      {err && <Note kind="bad">{err}</Note>}
    </div>
  );
}
