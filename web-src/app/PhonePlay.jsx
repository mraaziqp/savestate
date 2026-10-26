// Play on this phone, for consoles a browser can't run but an Android
// emulator app can (PSP in PPSSPP, PS2 in NetherSX2, GameCube and Wii in
// Dolphin...). In the SaveState Android app: the game downloads to
// Downloads/SaveState/<console> with Android's download manager (it keeps
// going with the screen off), then opens in the emulator app. A second Play
// opens the copy already on the phone. In a phone's browser, the game
// downloads the browser's way and this says where to open it.
//
// Opened by window.nxPhonePlay(game) (the game details' Play on this phone,
// build.mjs 3m), or a "nexus:phone-play" event with { game }.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useStyles, api, token, Icon, Note } from "./lib.jsx";
import { PHONE_APPS, PHONE_FOLDER, norm, inAndroidApp, nativeCore } from "./devices.js";

const native = (method, options = {}) => window.Capacitor.nativePromise("NxAndroid", method, options);
// The app's NxAndroid version, or 0 outside it. Before 3 every download id
// reached Android as -1, so no downloaded game could open; before 4 emulators
// got the download manager's address, which Dolphin couldn't read.
const nativeVersion = async () => { if (!inAndroidApp()) return 0; try { return Number((await native("info")).version) || 1; } catch { return 0; } };
const FIXED_IN = 4;
// The app plays some consoles itself (NxAndroid 5+, Phase 7: our own cores in
// SaveState's engine). Known once, at load, so Play can choose at once.
if (typeof window !== "undefined" && inAndroidApp()) {
  nativeVersion().then((v) => (v >= 5 ? native("engine") : null)).then((r) => { if (r) window.__nxEngineOK = !!r.available; }).catch(() => {});
}
// Where each emulator adds a folder to its game list.
const FOLDER_HELP = {
  "PPSSPP": "Games › Browse… › Download › SaveState › PSP",
  "PPSSPP Gold": "Games › Browse… › Download › SaveState › PSP",
  "Dolphin": "the + button › Download › SaveState › GameCube or Wii",
  "NetherSX2": "Settings › Game Directories › Add › Download › SaveState › PS2",
  "Azahar": "the + button (Add games folder) › Download › SaveState › 3DS",
};
const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const fileOf = (g) => String(g.fileName || g.file_name || g.relative_path || g.relativePath || g.title || "game").split(/[\\/]/).pop();
const saved = (k) => { try { return JSON.parse(localStorage.getItem("nx_phone_games") || "{}")[k]; } catch { return undefined; } };
const remember = (k, v) => { try { const all = JSON.parse(localStorage.getItem("nx_phone_games") || "{}"); all[k] = v; localStorage.setItem("nx_phone_games", JSON.stringify(all)); } catch { /* private mode */ } };

const CSS = `
.nxphone{position:fixed;inset:0;z-index:5400;overflow:auto;display:grid;place-items:center;padding:18px 16px;background:radial-gradient(ellipse at center,rgba(20,24,48,.95),rgba(4,5,12,.98));animation:nxaRise .2s ease}
.nxphone-box{width:100%;max-width:460px;display:grid;gap:14px;justify-items:center;text-align:center}
.nxphone-cover{width:min(170px,44vw);aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#11131f;box-shadow:0 24px 60px rgba(0,0,0,.55)}
.nxphone-cover img{width:100%;height:100%;object-fit:cover;display:block}
.nxphone h2{margin:0;font-size:21px;font-weight:900}
.nxphone p{margin:0;color:var(--dim);font-size:14px;line-height:1.5}
.nxphone-bar{width:100%;height:8px;border-radius:6px;background:rgba(255,255,255,.1);overflow:hidden}
.nxphone-bar b{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .4s ease}
.nxphone-bar.indef b{width:35%!important;animation:nxplayIndef 1.3s ease-in-out infinite}
@keyframes nxplayIndef{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
.nxphone-col{display:grid;gap:8px;width:100%}
.nxphone-col .nxa-btn{justify-content:center;width:100%}
.nxphone-app{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;text-align:left;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.03);width:100%}
.nxphone-app small{display:block;color:var(--dim);font-size:12.5px}
.nxphone-err{color:#fecaca!important;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);border-radius:12px;padding:10px 12px;overflow-wrap:anywhere}
`;

export function PhonePlay() {
  useStyles();
  const [game, setGame] = useState(null);
  useEffect(() => {
    const on = (e) => e.detail?.game && setGame(e.detail.game);
    window.addEventListener("nexus:phone-play", on);
    window.nxPhonePlay = (g) => window.dispatchEvent(new CustomEvent("nexus:phone-play", { detail: { game: g } }));
    return () => window.removeEventListener("nexus:phone-play", on);
  }, []);
  if (!game) return null;
  return <Sheet key={game.id} game={game} onClose={() => setGame(null)} />;
}

function Sheet({ game, onClose }) {
  const sys = norm(game.platform);
  const apps = PHONE_APPS[sys] ?? [];
  const folder = PHONE_FOLDER[sys] ?? "Games";
  const name = fileOf(game);
  const core = nativeCore(game.platform);
  const [inApp, setInApp] = useState(null); // null while checking
  const [appVersion, setAppVersion] = useState(0);
  const [installed, setInstalled] = useState({});
  const [dl, setDl] = useState(null); // { id, status, bytes, total, error, path }
  const [msg, setMsg] = useState(null);
  const [me, setMe] = useState(null);
  const [bios, setBios] = useState(null); // admin: PS2 BIOS on the host
  const poll = useRef(null);
  useEffect(() => () => clearInterval(poll.current), []);

  const checkApps = useCallback(async () => {
    const v = await nativeVersion();
    if (!v) { setInApp(false); return; }
    setAppVersion(v);
    setInApp(true);
    try { setInstalled(await native("apps", { packages: apps.map((a) => a.pkg) })); } catch { /* none known */ }
  }, [sys]);
  useEffect(() => {
    checkApps();
    // Coming back from the Play Store: look again.
    const vis = () => document.visibilityState === "visible" && checkApps();
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [checkApps]);
  useEffect(() => { api("/api/plans/me").then(setMe).catch(() => {}); }, []);
  // The owner's own BIOS can come along to their phone (never anyone else's).
  useEffect(() => {
    if (!me?.isAdmin || !apps.some((a) => a.bios)) return;
    const name = "scph70012.bin";
    fetch(`/api/emulator/bios/serve/${name}?token=${encodeURIComponent(token())}`, { method: "HEAD" })
      .then((r) => setBios(r.ok ? name : "")).catch(() => setBios(""));
  }, [me?.isAdmin, sys]);

  const app = apps.find((a) => installed[a.pkg]) ?? null;
  const url = `${location.origin}/api/games/${encodeURIComponent(game.id)}/download/${encodeURIComponent(name)}?token=${encodeURIComponent(token())}`;

  const follow = useCallback((id, then) => {
    clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const p = await native("progress", { id });
        setDl((d) => ({ ...d, ...p, id }));
        if (p.status === "done") { clearInterval(poll.current); then?.(); }
        if (p.status === "failed" || p.status === "gone") clearInterval(poll.current);
      } catch { /* keep looking */ }
    }, 1000);
  }, []);

  const openIt = useCallback(async (id) => {
    setMsg(null);
    const a = apps.find((x) => installed[x.pkg]);
    try {
      const r = await native("open", { id, pkg: a?.pkg ?? "", mode: a?.mode ?? "view", folder, fileName: name });
      setMsg(r.opened === "app"
        ? { kind: "info", text: `${a.name} opened. If the game didn't start by itself, choose it there: Download › SaveState › ${folder} › ${name}. To see every game you download, add that folder to ${a.name}'s game list once (${FOLDER_HELP[a.name] ?? "its Games screen › browse to it"}).` }
        : { kind: "ok", text: `${game.title} is opening in ${a?.name ?? "your emulator"}. Come back to SaveState any time.` });
    } catch (e) { setMsg({ kind: "bad", text: e.message || "It didn't open." }); }
  }, [installed, sys]);

  // Inside SaveState: the app's own player with SaveState's build of the core.
  const playHere = useCallback(async () => {
    setMsg(null);
    try {
      await native("play", { folder, fileName: name, origin: location.origin, token: token(), core, platform: sys, title: game.title });
    } catch (e) { setMsg({ kind: "bad", text: e.message || "It didn't start." }); }
  }, [core, sys]);

  async function start() {
    window.__nxRequestStoragePersistence?.();
    setMsg(null);
    // Ask the host first, so a refusal reads as a sentence, not "failed".
    try {
      const h = await fetch(url, { method: "HEAD" });
      if (h.status === 409) { setDl({ status: "failed", error: `${game.title} is still downloading on the host. It plays once that finishes.` }); return; }
      if (h.status === 401 || h.status === 403) { setDl({ status: "failed", error: "You need access to the host's games for this (Games shows a button to ask), or sign in again." }); return; }
      if (h.status === 404) { setDl({ status: "failed", error: "The host can't find this game's file. The host can rescan the library in Games." }); return; }
    } catch { /* offline check failed; the download says why */ }
    if (!inApp) {
      // A phone's browser: its own download, then open it in the emulator.
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setDl({ status: "browser" });
      return;
    }
    try {
      native("pruneDownloads").catch(() => {});
      const r = await native("download", { url, token: token(), folder, fileName: name, title: game.title });
      remember(game.id, r.id);
      setDl({ id: r.id, status: r.done ? "done" : "waiting", path: r.path });
      if (r.done) { if (core) playHere(); else if (app) openIt(r.id); } else follow(r.id, () => (core ? playHere() : app && openIt(r.id)));
    } catch (e) { setDl({ status: "failed", error: e.message }); }
  }

  // Downloaded on an earlier visit: pick up where it is. A download this
  // phone no longer lists (or one started from another page) is found by its
  // file in Downloads/SaveState instead.
  useEffect(() => {
    if (!inApp) return;
    const byFile = () => native("find", { folder, fileName: name }).then((f) => {
      if (f.done) { remember(game.id, f.id); setDl({ id: f.id, status: "done", path: `Download › SaveState › ${folder}` }); }
    }).catch(() => {});
    const id = saved(game.id);
    if (id == null) { byFile(); return; }
    native("progress", { id }).then((p) => {
      if (p.status === "gone") { byFile(); return; }
      setDl({ ...p, id });
      if (p.status !== "done" && p.status !== "failed") follow(id);
    }).catch(byFile);
  }, [inApp]);

  async function copyBios() {
    setMsg(null);
    try {
      const r = await native("download", { url: `${location.origin}/api/emulator/bios/serve/${bios}?token=${encodeURIComponent(token())}`, token: token(), folder: "BIOS", fileName: bios, title: "PS2 BIOS" });
      setMsg({ kind: "ok", text: `Your PS2 BIOS is ${r.done ? "already" : "being saved"} in Downloads › SaveState › BIOS. In NetherSX2, choose it when it asks for a BIOS (Settings › BIOS › Import).` });
    } catch (e) { setMsg({ kind: "bad", text: e.message }); }
  }

  const pct = dl?.total > 0 ? Math.min(100, (dl.bytes / dl.total) * 100) : null;
  const busy = dl && (dl.status === "waiting" || dl.status === "running" || dl.status === "paused");
  const cover = game.coverUrl || game.boxArt || game.box_art || `/api/art/${encodeURIComponent(game.id)}`;
  const big = Number(game.file_size || game.fileSize || game.size || 0);

  return (
    <div className="nxphone nxa" role="dialog" aria-modal="true" aria-live="polite" aria-label={`Play ${game.title} on this phone`}>
      <style>{CSS}</style>
      <div className="nxphone-box">
        <div className="nxphone-cover"><img src={cover} alt="" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /></div>
        <h2>{game.title}</h2>
        {!apps.length && !core && <p className="nxphone-err">{String(game.platform ?? "This console").toUpperCase()} has no emulator for phones. Stream it from the host instead (game details › Stream from the host PC).</p>}

        {(apps.length > 0 || core) && inApp === null && <p><Icon name="spinner" /> Checking this phone…</p>}

        {(apps.length > 0 || core) && inApp !== null && (
          <>
            {inApp && appVersion < FIXED_IN && (
              <div className="nxphone-col">
                <p className="nxphone-err">This copy of the SaveState app can't hand downloaded games to an emulator (fixed in the new version). Install the update, then press Play again; games you already downloaded stay on the phone.</p>
                <a className="nxa-btn primary" href={`${location.origin}/api/downloads/apk`}><Icon name="down" /> Update the SaveState app</a>
              </div>
            )}
            {inApp && !app && !core && (
              <div className="nxphone-col">
                <p>{String(game.platform).toUpperCase()} games play on this phone in {[...new Set(apps.map((a) => a.name))].join(" or ")}. Install it first; this page notices when you come back.</p>
                {apps.filter((a) => a.get).map((a) => (
                  <div key={a.pkg} className="nxphone-app">
                    <div><b>{a.name}</b>{a.note && <small>{a.note}</small>}</div>
                    <a className="nxa-btn primary sm" href={a.get} target="_blank" rel="noopener noreferrer"><Icon name="down" /> Get it</a>
                  </div>
                ))}
              </div>
            )}
            {inApp && core && !dl && <p>Downloads {big ? `${mb(big)} ` : ""}to this phone once (Downloads › SaveState › {folder}), then plays right here in SaveState. After that it plays offline.</p>}
            {inApp && app && !core && !dl && <p>Downloads {big ? `${mb(big)} ` : ""}to this phone once (Downloads › SaveState › {folder}), then opens in {app.name}. After that it plays offline.</p>}
            {!inApp && !dl && <p>This downloads the game to this phone. Then open it in {[...new Set(apps.map((a) => a.name))].join(" or ")} (from your Downloads folder). In the SaveState Android app it opens by itself.</p>}

            {busy && (
              <div className="nxphone-col">
                <div className={`nxphone-bar ${pct == null ? "indef" : ""}`}><b style={{ width: `${pct ?? 0}%` }} /></div>
                <p>{dl.status === "paused" ? dl.error : dl.total > 0 ? `Downloading · ${mb(dl.bytes)} of ${mb(dl.total)}` : "Starting the download…"}</p>
                <p className="nxa-faint" style={{ fontSize: 12.5 }}>It carries on if you leave this screen or turn the screen off; it's in your notifications.</p>
              </div>
            )}
            {dl?.status === "failed" && <p className="nxphone-err">{dl.error || "The download stopped."}</p>}
            {dl?.status === "browser" && <Note kind="ok">The download has started (see your browser's downloads). When it finishes, open {apps[0].name} and choose the game from Downloads.</Note>}
            {dl?.status === "done" && !msg && <p>{game.title} is on this phone ({dl.path || `Downloads › SaveState › ${folder}`}).</p>}

            <div className="nxphone-col">
              {(!dl || dl.status === "failed") && (inApp === false || app || core) && <button className="nxa-btn primary" onClick={start}><Icon name="game" /> {dl?.status === "failed" ? "Try again" : inApp ? `Download and play` : "Download to this phone"}</button>}
              {inApp && !app && !core && !dl && <button className="nxa-btn" onClick={start}><Icon name="down" /> Download it now anyway</button>}
              {dl?.status === "done" && core && <button className="nxa-btn primary" onClick={playHere}><Icon name="game" /> Play</button>}
              {dl?.status === "done" && app && <button className={core ? "nxa-btn" : "nxa-btn primary"} onClick={() => openIt(dl.id)}><Icon name="game" /> {core ? `Play in ${app.name} instead` : `Play in ${app.name}`}</button>}
              {busy && <button className="nxa-btn" onClick={() => { native("cancel", { id: dl.id }).catch(() => {}); clearInterval(poll.current); setDl(null); }}><Icon name="x" /> Cancel download</button>}
              {inApp && bios && <button className="nxa-btn" onClick={copyBios}><Icon name="shield" /> Copy my PS2 BIOS to this phone</button>}
            </div>
          </>
        )}
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        <button className="nxa-btn" onClick={onClose}>{busy ? "Hide (keeps downloading)" : "Close"}</button>
      </div>
    </div>
  );
}

// A file the page built itself (a blob: address) can't go to Android's
// download manager; MainActivity hands it back here to save.
const toast = (text) => {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:6000;max-width:min(92vw,460px);padding:10px 14px;border-radius:12px;background:#151a2e;color:#e8ecff;border:1px solid rgba(255,255,255,.14);font:14px/1.4 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
};
if (typeof window !== "undefined" && !window.nxSaveBlob) {
  window.nxSaveBlob = async (href, fileName) => {
    try {
      const blob = await fetch(href).then((r) => r.blob());
      if (blob.size > 200 * 1024 * 1024) throw new Error("too big to save from here"); // read whole into memory as base64: more than this crashed the app
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] ?? ""); fr.onerror = rej; fr.readAsDataURL(blob); });
      const r = await native("saveData", { fileName, data, first: true });
      toast(`Saved ${fileName} to ${r.path}`);
    } catch (e) {
      toast(`Couldn't save ${fileName}: ${e.message}`);
    }
  };
}
