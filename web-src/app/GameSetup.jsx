// Set up games: one guided path from "I want to play" to playing.
//   1. Pick the consoles you want.
//   2. Where they run: the browser (nothing to install), or SaveState for
//      Windows, which this page asks for when it's missing and then sets up
//      every chosen console in one go (RetroArch and cores, PCSX2, RPCS3...).
//   3. Your system files (BIOS): the ones only you can provide, added here
//      and put where each console looks.
//   4. Your games: this host's library, or a folder on this PC.
// Opened from Emulation Setup, Play Offline, Get started and Help & guides
// (window event "nexus:game-setup", or ?gamesetup).
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useStyles, api, token, Icon, Note, goTab } from "./lib.jsx";
import { SYSTEMS, EMULATORS } from "./systems.js";

const LAUNCHER = "http://127.0.0.1:17373";
// v8 unpacks downloads without extra modules (v7 stopped at "Cannot find module 'adm-zip'").
const NEEDS_VERSION = 8;
const MAKERS = ["Sony", "Nintendo", "Sega", "SNK", "Arcade", "NEC", "Atari", "Microsoft"];
// Systems that need a paid plan's "every console" (planlimits.ts HEAVY_SYSTEMS).
const HEAVY = new Set(["ps2", "ps3", "gamecube", "wii", "wiiu", "switch", "psp", "3ds", "xbox", "xbox360"]);

const CSS = `
.nxgset{position:fixed;inset:0;z-index:5300;overflow:auto;background:radial-gradient(ellipse at top,#16203b,#07080f 70%);display:grid;place-items:start center;padding:24px 16px}
.nxgset-box{width:100%;max-width:880px;display:grid;gap:16px;animation:nxaRise .25s ease}
.nxgset-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.nxgset h1{font-size:clamp(22px,3.6vw,30px);font-weight:900;margin:0}
.nxgset-steps{display:flex;gap:6px}.nxgset-steps i{flex:1;height:4px;border-radius:4px;background:rgba(255,255,255,.12)}.nxgset-steps i.on{background:linear-gradient(90deg,var(--acc),var(--acc2))}
.nxgset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.nxgset-sys{display:grid;gap:4px;text-align:left;padding:11px 12px;border-radius:13px;border:1px solid var(--line);background:rgba(255,255,255,.03);color:inherit;cursor:pointer}
.nxgset-sys.on{border-color:var(--acc);background:rgba(34,211,238,.1)}
.nxgset-sys:disabled{cursor:not-allowed;opacity:.55}
.nxgset-sys b{font-size:14px;display:flex;justify-content:space-between;gap:6px}
.nxgset-sys small{font-size:11.5px;color:var(--dim)}
.nxgset-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.03)}
.nxgset-row b{font-size:14px}.nxgset-row small{display:block;color:var(--dim);font-size:12.5px;overflow-wrap:anywhere}
.nxgset-foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.nxgset-drop{border:2px dashed var(--line);border-radius:14px;padding:18px;text-align:center;color:var(--dim);display:grid;gap:8px;justify-items:center}
.nxgset-drop.on{border-color:var(--acc);background:rgba(34,211,238,.08);color:var(--text)}
@media (max-width:520px){.nxgset-row{grid-template-columns:1fr}}
`;

const ua = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);
const device = () => {
  const u = ua();
  if (/Android/i.test(u)) return "android";
  if (/iPhone|iPad|iPod/i.test(u)) return "ios";
  if (/Windows/i.test(u)) return "windows";
  if (/Macintosh|Mac OS X/i.test(u)) return "mac";
  return "linux";
};
const DEVICE_NAME = { windows: "this Windows PC", mac: "this Mac", linux: "this computer", android: "this phone", ios: "this iPhone or iPad" };

async function launcher(pathname, opts = {}) {
  const r = await fetch(`${LAUNCHER}${pathname}`, { ...opts, signal: opts.signal ?? AbortSignal.timeout(opts.timeout ?? 8000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.canceled) throw Object.assign(new Error(data.error || data.detail || "The SaveState app on this PC didn't answer."), { data });
  return data;
}

export function GameSetup() {
  useStyles();
  const [open, setOpen] = useState(() => { try { return new URLSearchParams(location.search).has("gamesetup"); } catch { return false; } });
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("nexus:game-setup", on);
    return () => window.removeEventListener("nexus:game-setup", on);
  }, []);
  if (!open) return null;
  return <Wizard onClose={() => {
    setOpen(false);
    try { const q = new URLSearchParams(location.search); if (q.has("gamesetup")) { q.delete("gamesetup"); history.replaceState(null, "", location.pathname + (q.toString() ? `?${q}` : "")); } } catch { /* ignore */ }
  }} />;
}

/** Opens the wizard from anywhere. */
export const openGameSetup = () => window.dispatchEvent(new CustomEvent("nexus:game-setup"));

function Wizard({ onClose }) {
  const dev = device();
  const desktop = dev === "windows";
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState(() => new Set());
  const [me, setMe] = useState(null);
  useEffect(() => { api("/api/plans/me").then(setMe).catch(() => {}); }, []);
  const fullGames = me ? me.isAdmin || me.features?.["games.full"] !== false : true;
  const chosen = SYSTEMS.filter((s) => picked.has(s.id));
  const needsApp = chosen.filter((s) => s.play !== "browser");
  const steps = ["Consoles", "Install", "System files", "Your games"];

  const toggle = (id) => setPicked((old) => { const n = new Set(old); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const finish = (tab) => { onClose(); if (tab) goTab(tab); };

  return (
    <div className="nxgset nxa" role="dialog" aria-modal="true" aria-label="Set up games">
      <style>{CSS}</style>
      <div className="nxgset-box">
        <div className="nxgset-top">
          <h1>Set up games</h1>
          <button className="nxa-btn" onClick={onClose}><Icon name="x" /> Close</button>
        </div>
        <div className="nxgset-steps" aria-hidden="true">{steps.map((s, i) => <i key={s} className={i <= step ? "on" : ""} />)}</div>
        <p className="nxa-dim" style={{ margin: 0 }}>Step {step + 1} of {steps.length}: {steps[step]}</p>

        {step === 0 && (
          <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
            <div>
              <h3 style={{ fontSize: 18 }}>Which consoles do you want to play?</h3>
              <p className="nxa-dim" style={{ marginTop: 4 }}>
                Green ones play right in the browser on any device, with nothing to install.
                {desktop ? " Blue ones need SaveState for Windows (a one-time install); the next step does it for you." : ` Blue ones need SaveState for Windows on a PC; on ${DEVICE_NAME[dev]} they stream from the host instead.`}
              </p>
            </div>
            <div className="nxa-row nxa-wrap">
              <button className="nxa-btn sm" onClick={() => setPicked(new Set(SYSTEMS.filter((s) => s.play === "browser").map((s) => s.id)))}>All browser consoles</button>
              {desktop && <button className="nxa-btn sm" onClick={() => setPicked(new Set(SYSTEMS.filter((s) => fullGames || !HEAVY.has(s.id)).map((s) => s.id)))}>Everything I can play</button>}
              {picked.size > 0 && <button className="nxa-btn sm" onClick={() => setPicked(new Set())}>Clear</button>}
            </div>
            {MAKERS.map((maker) => {
              const list = SYSTEMS.filter((s) => s.maker === maker);
              if (!list.length) return null;
              return (
                <div key={maker}>
                  <p className="nxa-label" style={{ marginBottom: 6 }}>{maker.toUpperCase()}</p>
                  <div className="nxgset-grid">
                    {list.map((s) => {
                      const locked = !fullGames && HEAVY.has(s.id);
                      return (
                        <button key={s.id} className={`nxgset-sys ${picked.has(s.id) ? "on" : ""}`} aria-pressed={picked.has(s.id)} disabled={locked} onClick={() => toggle(s.id)}>
                          <b>{s.name}{picked.has(s.id) && <Icon name="check" size={15} />}</b>
                          <span className="nxa-row" style={{ gap: 5, flexWrap: "wrap" }}>
                            {locked ? <span className="nxa-pill warn">Paid plan</span>
                              : <span className={`nxa-pill ${s.play === "browser" ? "ok" : "acc"}`}>{s.play === "browser" ? "In the browser" : "Desktop app"}</span>}
                            {s.bios.need === "required" && <span className="nxa-pill">Needs your BIOS</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {!fullGames && <Note>PS2, GameCube, PS3, Switch and PSP come with the paid plans. <button className="nxa-link" onClick={() => finish("plans")}>See plans</button></Note>}
            <div className="nxgset-foot">
              <span className="nxa-dim">{picked.size ? `${picked.size} chosen` : "Choose one or more"}</span>
              <button className="nxa-btn primary" disabled={!picked.size} onClick={() => setStep(1)}>Next <Icon name="arrow" /></button>
            </div>
          </div>
        )}

        {step === 1 && <InstallStep dev={dev} chosen={chosen} needsApp={needsApp} onBack={() => setStep(0)} onNext={() => setStep(2)} />}
        {step === 2 && <BiosStep dev={dev} chosen={chosen} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
        {step === 3 && <GamesStep dev={dev} me={me} onBack={() => setStep(2)} onDone={finish} />}
      </div>
    </div>
  );
}

// ── Step 2: install ───────────────────────────────────────────────────────
function useLauncher(enabled) {
  const [state, setState] = useState({ status: "checking", version: 0 });
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const check = async () => {
      try {
        const h = await launcher("/health", { timeout: 2500 });
        if (live) setState({ status: (h.version ?? 0) >= NEEDS_VERSION ? "ready" : "old", version: h.version ?? 0, health: h });
      } catch { if (live) setState((s) => ({ ...s, status: "missing" })); }
    };
    check();
    const t = setInterval(check, 3000);
    return () => { live = false; clearInterval(t); };
  }, [enabled]);
  return state;
}

function InstallStep({ dev, chosen, needsApp, onBack, onNext }) {
  const desktop = dev === "windows";
  const app = useLauncher(desktop);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const poll = useRef(null);
  useEffect(() => () => clearInterval(poll.current), []);

  const start = useCallback(async () => {
    setError("");
    try {
      const r = await launcher("/setup-consoles", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms: chosen.map((s) => s.id), hostUrl: location.origin, token: token() }) });
      setJob(r.job);
      clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try { const p = await launcher("/setup-consoles/progress"); setJob(p.job); if (p.job && !p.job.running) clearInterval(poll.current); } catch { /* keep trying */ }
      }, 1500);
    } catch (e) { setError(e.message); }
  }, [chosen]);

  // Nothing to press: once SaveState for Windows answers, set up what was chosen.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (desktop && app.status === "ready" && !job && !autoStarted.current) { autoStarted.current = true; start(); }
  }, [desktop, app.status, job, start]);
  const browserOnes = chosen.filter((s) => s.play === "browser");
  const done = job && !job.running;
  const failed = job ? job.steps.filter((s) => s.status === "failed") : [];
  return (
    <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
      <h3 style={{ fontSize: 18 }}>{desktop ? "Install what these consoles need" : "Where these consoles play"}</h3>
      {browserOnes.length > 0 && (
        <Note kind="ok">{browserOnes.map((s) => s.name).join(", ")} play{browserOnes.length === 1 ? "s" : ""} right in the browser{desktop ? "" : ` on ${DEVICE_NAME[dev]}`}: nothing to install.{desktop ? " The app below also sets them up to play offline at full speed." : ""}</Note>
      )}

      {desktop ? (
        <>
          {app.status === "checking" && <p className="nxa-dim"><Icon name="spinner" /> Looking for SaveState for Windows on this PC…</p>}
          {app.status === "missing" && (
            <div className="nxgset-row">
              <div><b>1. Install SaveState for Windows (once)</b>
                <small>Download it, open the file and let it finish (about a minute). It adds SaveState to the Start menu and keeps a small game launcher running so Play works offline. This page carries on by itself as soon as it's installed.</small></div>
              <a className="nxa-btn primary" href="/api/downloads/desktop?platform=windows" download><Icon name="down" /> Download</a>
            </div>
          )}
          {app.status === "old" && (
            <div className="nxgset-row">
              <div><b>Update SaveState for Windows</b>
                <small>This PC has an older version. Download and run the installer again (it replaces the old one in place); this page carries on by itself.</small></div>
              <a className="nxa-btn primary" href="/api/downloads/desktop?platform=windows" download><Icon name="down" /> Download update</a>
            </div>
          )}
          {(app.status === "missing" || app.status === "old") && <p className="nxa-dim"><Icon name="spinner" /> Waiting for it on this PC…</p>}
          {app.status === "missing" && <p className="nxa-faint" style={{ fontSize: 12.5, margin: 0 }}>Already installed? If the browser asks whether this site may connect to devices or apps on this computer, choose <b>Allow</b>: that's how it reaches SaveState for Windows.</p>}
          {app.status === "ready" && !job && (
            <div className="nxgset-row">
              <div><b><Icon name="check" /> SaveState for Windows is installed</b>
                <small>Set up {chosen.length === 1 ? chosen[0].name : `all ${chosen.length} consoles`} in one go: emulators and their parts download from their official sources (or from this host where there's no public download).</small></div>
              <button className="nxa-btn primary" onClick={start}><Icon name="bolt" /> Set up {chosen.length === 1 ? "it" : "all"}</button>
            </div>
          )}
          {job && (
            <div style={{ display: "grid", gap: 8 }}>
              {job.steps.map((s) => {
                const sys = SYSTEMS.find((x) => x.id === s.platform);
                const icon = s.status === "done" ? "check" : s.status === "failed" ? "alert" : s.status === "manual" ? "info" : s.status === "working" ? "spinner" : "info";
                return (
                  <div key={s.platform} className="nxgset-row">
                    <div><b><Icon name={icon} /> {sys?.name ?? s.platform}</b>
                      <small>{s.status === "waiting" ? "Waiting…" : s.detail || s.status}
                        {s.status === "manual" && sys?.emu && EMULATORS[sys.emu] && <> <a href={EMULATORS[sys.emu].url} target="_blank" rel="noopener noreferrer">Download {EMULATORS[sys.emu].name}</a></>}</small></div>
                    <span className={`nxa-pill ${s.status === "done" ? "ok" : s.status === "failed" ? "warn" : ""}`}>{s.status === "done" ? "Ready" : s.status === "failed" ? "Didn't finish" : s.status === "manual" ? "Install yourself" : s.status === "working" ? "Working…" : "Waiting"}</span>
                  </div>
                );
              })}
              {done && !failed.length && <Note kind="ok">All set. Next, add any system files these consoles need.</Note>}
              {done && failed.length > 0 && <button className="nxa-btn sm primary" onClick={start}><Icon name="refresh" /> Try {failed.length === 1 ? "it" : `those ${failed.length}`} again</button>}
            </div>
          )}
          {error && <Note kind="bad">{error}</Note>}
        </>
      ) : needsApp.length > 0 ? (
        <Note>
          {needsApp.map((s) => s.name).join(", ")} need{needsApp.length === 1 ? "s" : ""} more power than a browser has.
          {dev === "android" || dev === "ios"
            ? " On a phone, open the game in Games and choose Stream from the host PC: the host runs it and the free Moonlight app shows it here (Help & guides > Play from anywhere)."
            : " On a Windows PC, open this page there to install SaveState for Windows. On this computer, install the emulator from each console's card in Emulation Setup, or stream from the host with Moonlight."}
        </Note>
      ) : null}

      <div className="nxgset-foot">
        <button className="nxa-btn" onClick={onBack}>Back</button>
        <button className="nxa-btn primary" disabled={desktop && job?.running} onClick={onNext}>{desktop && !job && needsApp.length ? "Skip for now" : "Next"} <Icon name="arrow" /></button>
      </div>
    </div>
  );
}

// ── Step 3: system files ──────────────────────────────────────────────────
function BiosStep({ dev, chosen, onBack, onNext }) {
  const desktop = dev === "windows";
  const app = useLauncher(desktop);
  const need = chosen.filter((s) => s.bios.need === "required" || s.bios.need === "optional" || s.bios.need === "varies");
  const [found, setFound] = useState({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [over, setOver] = useState(false);
  const ready = desktop && app.status === "ready";
  // Every file name these consoles use, to match dropped files to.
  const wanted = need.flatMap((sys) => (sys.bios.files ?? []).filter((f) => /\./.test(f.name)).map((f) => ({ sys, file: f })));
  async function dropped(list) {
    const files = [...(list ?? [])];
    const unknown = [];
    for (const fl of files) {
      const hit = wanted.find((w) => w.file.name.toLowerCase() === fl.name.toLowerCase());
      if (hit) await add(hit.sys, hit.file, fl); else unknown.push(fl.name);
    }
    if (unknown.length) setMsg({ kind: "warn", text: `${unknown.join(", ")}: not a file these consoles use by that name. Use the Add file button next to the file it is, and it will be saved under the right name.` });
  }

  const refresh = useCallback(async () => {
    if (!ready) return;
    const files = need.flatMap((s) => (s.bios.files ?? []).filter((f) => /\./.test(f.name)).map((f) => ({ name: f.name, system: s.id })));
    if (!files.length) return;
    try {
      const r = await launcher("/bios-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files }) });
      const map = {};
      for (const f of r.files ?? []) map[`${f.system}:${f.name.toLowerCase()}`] = f.found;
      setFound(map);
    } catch { /* launcher busy */ }
  }, [ready, need.map((s) => s.id).join(",")]);
  useEffect(() => { refresh(); }, [refresh]);

  async function add(sys, file, picked) {
    setBusy(`${sys.id}:${file.name}`); setMsg(null);
    try {
      const r = await launcher(`/bios-add?name=${encodeURIComponent(file.name)}&system=${encodeURIComponent(sys.id)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: picked, timeout: 120000 });
      const bad = file.md5 && r.md5 && r.md5 !== file.md5;
      setMsg(r.opened === "rpcs3" ? { kind: "ok", text: "RPCS3 opened to install the PS3 system software: confirm there, and PS3 games are ready." }
        : bad ? { kind: "warn", text: `${file.name} is saved, but it isn't the usual ${file.name} (checksum differs). If ${sys.name} games don't start, dump it again from your console.` }
        : { kind: "ok", text: `${file.name} is in place for ${sys.name}.` });
      await refresh();
    } catch (e) { setMsg({ kind: "bad", text: e.message }); }
    finally { setBusy(""); }
  }

  return (
    <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
      <h3 style={{ fontSize: 18 }}>Your system files</h3>
      <p className="nxa-dim" style={{ margin: 0 }}>
        Some consoles need a file from the console itself (a BIOS, keys or firmware). They're copyrighted, so SaveState can't include them:
        dump them from consoles you own and add them here. {desktop ? "Each one is put exactly where its console looks." : ""}
      </p>
      {!need.length && <Note kind="ok">None of the consoles you chose need system files. Nothing to do here.</Note>}
      {need.length > 0 && !ready && desktop && <Note>Finish the install step first (SaveState for Windows), then the files you add here go straight into place.</Note>}
      {ready && wanted.length > 0 && (
        <label className={`nxgset-drop ${over ? "on" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); dropped(e.dataTransfer.files); }}>
          <Icon name="down" size={22} />
          <b>Drop your system files here</b>
          <span>or click to choose them. Each one is matched by its name and put where its console looks.</span>
          <input type="file" multiple hidden onChange={(e) => { const fl = e.target.files; dropped(fl); e.target.value = ""; }} />
        </label>
      )}
      {need.map((sys) => (
        <div key={sys.id} style={{ display: "grid", gap: 6 }}>
          <p className="nxa-label">{sys.name.toUpperCase()}{sys.bios.anyOne ? " · any one of these" : ""}{sys.bios.need === "optional" ? " · optional" : ""}</p>
          {(sys.bios.files ?? []).map((f) => {
            const have = found[`${sys.id}:${f.name.toLowerCase()}`];
            const id = `${sys.id}:${f.name}`;
            const isFile = /\./.test(f.name);
            return (
              <div key={f.name} className="nxgset-row">
                <div><b>{have ? <Icon name="check" /> : null} <span className="nxa-code">{f.name}</span></b>
                  <small>{f.note}{have ? ` · in place (${have})` : ""}{!isFile ? " · install it inside the emulator (see how below)" : ""}</small></div>
                {ready && isFile && (
                  <label className={`nxa-btn sm ${have ? "" : "primary"}`} style={{ cursor: "pointer" }}>
                    {busy === id ? <Icon name="spinner" /> : <Icon name="plus" />} {have ? "Replace" : "Add file"}
                    <input type="file" hidden onChange={(e) => { const fl = e.target.files?.[0]; e.target.value = ""; if (fl) add(sys, f, fl); }} />
                  </label>
                )}
              </div>
            );
          })}
          {sys.bios.how && <small className="nxa-dim">{sys.bios.how}{sys.bios.links?.length ? " " : ""}{sys.bios.links?.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" style={{ marginRight: 8 }}>{l.label}</a>)}</small>}
        </div>
      ))}
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
      <div className="nxgset-foot">
        <button className="nxa-btn" onClick={onBack}>Back</button>
        <button className="nxa-btn primary" onClick={onNext}>Next <Icon name="arrow" /></button>
      </div>
    </div>
  );
}

// ── Step 4: games ─────────────────────────────────────────────────────────
function GamesStep({ dev, me, onBack, onDone }) {
  const desktop = dev === "windows";
  const app = useLauncher(desktop);
  const [folder, setFolder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasLibrary = !!me?.access?.games || !!me?.isAdmin;

  async function pick() {
    setBusy(true); setError("");
    try {
      const r = await launcher("/add-rom-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", timeout: 10 * 60_000 });
      if (r.ok) setFolder(r);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
      <h3 style={{ fontSize: 18 }}>Your games</h3>
      {hasLibrary
        ? <Note kind="ok">You have this host's game library: its games are ready in Games and Play Offline. Pick one and press Play; it downloads once, then plays offline.</Note>
        : <Note>This host's game library is private. Ask the host for access (Games shows a button), or use your own games below.</Note>}
      {desktop && app.status === "ready" && (
        <div className="nxgset-row">
          <div><b>Games on this PC</b>
            <small>{folder ? `Added ${folder.path}: ${folder.filesFound} game file(s) found.` : "Choose the folder with your own games (one folder per console inside it works best, e.g. PS2, SNES, GBA). A folder picker opens on this PC."}</small></div>
          <button className="nxa-btn" disabled={busy} onClick={pick}>{busy ? <Icon name="spinner" /> : <Icon name="folder" />} {folder ? "Add another folder" : "Choose folder"}</button>
        </div>
      )}
      {!desktop && <p className="nxa-dim" style={{ margin: 0 }}>On {DEVICE_NAME[dev]}, games come from the host's library. Your own games can be added by the host in Games &gt; Add games.</p>}
      {me?.isAdmin && <div className="nxgset-row"><div><b>Add games to the host's library</b><small>Drop files or folders; they're sorted by console and show up for everyone with access.</small></div><button className="nxa-btn" onClick={() => onDone("addgames")}><Icon name="plus" /> Add games</button></div>}
      {error && <Note kind="bad">{error}</Note>}
      <div className="nxgset-foot">
        <button className="nxa-btn" onClick={onBack}>Back</button>
        <div className="nxa-row nxa-wrap">
          <button className="nxa-btn" onClick={() => onDone("library")}><Icon name="game" /> Open Games</button>
          <button className="nxa-btn primary" onClick={() => onDone("consoles")}><Icon name="check" /> Done: Play Offline</button>
        </div>
      </div>
    </div>
  );
}
