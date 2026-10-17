// The game setup guide (Games > Emulation Setup).
//
// The app plays games people own; it does not hand out the host's ROMs or
// console system files. So this page has to answer, for every system, the
// questions a new member otherwise has to ask the host: what do I install,
// which files do I need, what are they called, where do they go, and where
// can I legitimately get them.
//
// Admins also get the host's own tools underneath (the previous content of
// this tab), plus which BIOS files the host already has.
import React, { useState, useEffect, useMemo, Suspense, lazy } from "react";
import { useStyles, api, Icon, Note, goTab } from "./lib.jsx";
import { SYSTEMS, EMULATORS, PLAY } from "./systems.js";
import { loadOldEmulationHub } from "old-emulation";

const HostTools = lazy(loadOldEmulationHub);
const MAKERS = ["Sony", "Nintendo", "Sega", "Microsoft", "SNK", "Arcade", "NEC", "Atari"];
const NEED = {
  required: { label: "BIOS required", cls: "warn" },
  optional: { label: "BIOS optional", cls: "" },
  varies: { label: "BIOS for some games", cls: "" },
  none: { label: "No BIOS needed", cls: "ok" },
};

function Ext({ href, children }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children} <Icon name="ext" size={12} /></a>;
}

function SystemDetail({ sys, hostFiles }) {
  const play = PLAY[sys.play];
  const emu = sys.emu ? EMULATORS[sys.emu] : null;
  const alt = sys.alt ? EMULATORS[sys.alt] : null;
  const bios = sys.bios;
  const have = (name) => hostFiles?.get(name.toLowerCase());
  return (
    <div className="nxa-card" style={{ animation: "nxaRise .2s ease" }}>
      <div className="nxa-card-head">
        <div><h3 style={{ fontSize: 19 }}>{sys.name}</h3><p className="nxa-sub">{sys.maker}</p></div>
        <div className="nxa-row nxa-wrap">
          <span className={`nxa-pill ${sys.play === "browser" ? "ok" : "acc"}`}>{play.label}</span>
          <span className={`nxa-pill ${NEED[bios.need].cls}`}>{NEED[bios.need].label}</span>
        </div>
      </div>

      <dl className="nxa-kv">
        <dt>Runs on</dt>
        <dd>
          {sys.play === "standalone"
            ? emu ? <><b>{emu.name}</b>. <Ext href={emu.url}>Download {emu.name}</Ext></> : <>A Switch emulator you install yourself.</>
            : <><b>{sys.core}</b> core{sys.play === "retroarch" ? <> in RetroArch. <Ext href={EMULATORS.retroarch.url}>Download RetroArch</Ext></> : <>, built in.</>}
              {alt && <> Prefer a dedicated emulator? <Ext href={alt.url}>{alt.name}</Ext></>}</>}
          <div className="nxa-faint" style={{ fontSize: 12, marginTop: 3 }}>{play.detail}</div>
        </dd>
        <dt>Game files</dt>
        <dd><span className="nxa-code">{sys.formats}</span></dd>
        <dt>System files</dt>
        <dd>
          {bios.need === "none" && !bios.how ? "None. Add your games and play." : bios.how}
          {bios.files?.length > 0 && (
            <div className="nxa-files" style={{ marginTop: 10 }}>
              {bios.anyOne && <div className="nxa-faint" style={{ fontSize: 12 }}>You need any one of these:</div>}
              {bios.files.map((f) => {
                const onHost = have(f.name);
                return (
                  <div className="nxa-file" key={f.name}>
                    <Icon name={onHost ? "check" : "chip"} className={onHost ? "" : "nxa-faint"} />
                    <div className="nxa-grow">
                      <span className="nxa-code">{f.name}</span>{f.note && <span className="nxa-dim"> {f.note}</span>}
                      {onHost && <span className="nxa-pill ok" style={{ marginLeft: 8 }}>On this host{onHost.status === "HASH_MISMATCH" ? " (checksum differs)" : ""}</span>}
                      {f.md5 && <small>MD5 {f.md5}</small>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </dd>
        {bios.folder && (<><dt>Where they go</dt><dd>{bios.folder}.{sys.play !== "standalone" && bios.folder.startsWith("RetroArch") && <span className="nxa-dim"> In the Android app that is the <span className="nxa-code">NexusEmu/bios</span> folder on the device.</span>}</dd></>)}
        {bios.links?.length > 0 && (<><dt>How to get them</dt><dd>{bios.links.map((l) => <div key={l.url}><Ext href={l.url}>{l.label}</Ext></div>)}</dd></>)}
      </dl>
    </div>
  );
}

export function SetupGuide({ isAdmin = false }) {
  useStyles();
  const [selected, setSelected] = useState("ps1");
  const [me, setMe] = useState(null);
  const [hostBios, setHostBios] = useState(null);
  const sys = SYSTEMS.find((s) => s.id === selected) ?? SYSTEMS[0];

  useEffect(() => {
    let live = true;
    api("/api/plans/me").then((m) => { if (live) setMe(m); }).catch(() => {});
    if (isAdmin) api("/api/bios/verify").then((b) => { if (live) setHostBios(b); }).catch(() => {});
    return () => { live = false; };
  }, [isAdmin]);

  const hostFiles = useMemo(() => (hostBios?.files ? new Map(hostBios.files.map((f) => [String(f.filename).toLowerCase(), f])) : null), [hostBios]);
  const hasLibrary = !!me?.access?.games;

  return (
    <div className="nxa nxa-page">
      <div className="nxa-card">
        <h3 style={{ fontSize: 20 }}>Set up your games</h3>
        <p className="nxa-sub" style={{ maxWidth: 760 }}>
          SaveState plays games you own. It doesn't come with games, and it doesn't hand out console system files (BIOS),
          because those are copyrighted. This page tells you exactly what each system needs and where every file goes.
        </p>
        {me && !me.isAdmin && (
          <div style={{ marginTop: 14 }}>
            {hasLibrary
              ? <Note kind="ok">You have access to this host's game library, so games in it are ready to play. Follow the steps below to add your own as well.</Note>
              : <Note>This host's game library is private. Follow the steps below to play your own games, or ask the host for access.</Note>}
          </div>
        )}
        <div className="nxa-steps" style={{ marginTop: 18 }}>
          <div className="nxa-step"><div><b>Choose where you'll play</b>
            <p>Older consoles and handhelds run right here in the browser. Bigger systems run in the desktop or Android app, which installs RetroArch and the right cores for you. A few (PS2, PS3, GameCube, Wii, Xbox, Switch) use their own emulator: install it from the link on the system's card.</p>
            <p>On Windows, install SaveState once: it sets up the game launcher (it starts by itself at login, so Play just works, and games you download stay on this PC) and adds SaveState to the Desktop and Start menu.</p>
            <a className="nxa-btn sm" style={{ marginTop: 8 }} href="/api/downloads/desktop?platform=windows" download><Icon name="down" size={14} /> Get SaveState for Windows</a></div></div>
          <div className="nxa-step"><div><b>Add your games</b>
            <p>Keep one folder per system (for example <span className="nxa-code">PS1</span>, <span className="nxa-code">SNES</span>, <span className="nxa-code">GBA</span>) inside one games folder. Then open Games, choose Library Setup and pick that folder. Each system's card lists the file types that work.</p>
            <div className="nxa-row nxa-wrap" style={{ marginTop: 8 }}>
              <button className="nxa-btn sm" onClick={() => goTab("library")}><Icon name="game" size={14} /> Open Games</button>
              {me?.isAdmin && <button className="nxa-btn sm primary" onClick={() => goTab("addgames")}><Icon name="plus" size={14} /> Add games to the host's library</button>}
            </div></div></div>
          <div className="nxa-step"><div><b>Add system files where a system needs them</b>
            <p>Check the system below. If it says "BIOS required", copy the exact file named there into the folder shown. File names matter: a wrong name is the most common reason a game will not start.</p></div></div>
        </div>
      </div>

      <div className="nxa-card">
        <div className="nxa-card-head"><div><h3>Pick a system</h3><p className="nxa-sub">See what it runs on, which files it needs and where they go.</p></div></div>
        {MAKERS.map((maker) => {
          const list = SYSTEMS.filter((s) => s.maker === maker);
          if (!list.length) return null;
          return (
            <div key={maker} style={{ marginBottom: 14 }}>
              <p className="nxa-label" style={{ marginBottom: 6 }}>{maker.toUpperCase()}</p>
              <div className="nxa-sys">
                {list.map((s) => (
                  <button key={s.id} className={s.id === selected ? "on" : ""} aria-pressed={s.id === selected} onClick={() => setSelected(s.id)}>
                    <b>{s.name}</b><small>{NEED[s.bios.need].label}</small>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <SystemDetail sys={sys} hostFiles={hostFiles} />

      <Note>
        Only use games and system files dumped from discs, cartridges and consoles you own. Sites that offer them for download are not
        legitimate sources, and this host will not share its own.
      </Note>

      {isAdmin && (
        <div className="nxa-card">
          <div className="nxa-card-head"><div><h3>This host's emulators</h3>
            <p className="nxa-sub">Admin only: check RetroArch and cores on the host PC, install what is missing and upload BIOS files{hostBios?.bios_path ? <> to <span className="nxa-code">{hostBios.bios_path}</span></> : null}.</p></div></div>
          <Suspense fallback={<p className="nxa-dim"><Icon name="spinner" /> Loading host tools…</p>}><HostTools /></Suspense>
        </div>
      )}
    </div>
  );
}
