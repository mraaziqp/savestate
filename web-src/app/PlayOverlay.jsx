// What happens after Play, inside SaveState:
// 1. Dual-supported systems: offers choice between "Play in Browser" and "Play Native (Local PC)".
// 2. Browser Play: renders EmulatorPlayer right inside the window with instant start and cloud saves.
// 3. Local Native Play: follows the desktop emulator (PCSX2, RetroArch, etc.) with real download/launch
//    progress, status tracking, and "closed" / "failed" error handling with Retry.
import React, { useState, useEffect, useRef, useCallback, Suspense, lazy } from "react";
import { useStyles, Icon, goTab } from "./lib.jsx";
import { EnginePlayer } from "./EnginePlayer.jsx";
import { RemotePlayer } from "./RemotePlayer.jsx";
import { loadEmulatorPlayer } from "emulator-player";

const BrowserPlayer = lazy(loadEmulatorPlayer);

const LAUNCHER = "http://127.0.0.1:17373";
const EMULATOR = {
  ps2: "PCSX2", ps3: "RPCS3", switch: "Ryujinx", gamecube: "Dolphin", wii: "Dolphin", wiiu: "Cemu",
  psp: "PPSSPP", xbox: "xemu", xbox360: "Xenia",
};
const emulatorFor = (platform) => EMULATOR[String(platform ?? "").toLowerCase()] ?? "RetroArch";

const CSS = `
.nxplay{position:fixed;inset:0;z-index:5400;display:grid;place-items:center;padding:20px;background:radial-gradient(ellipse at center,rgba(20,24,48,.94),rgba(4,5,12,.97));animation:nxaRise .2s ease}
.nxplay-box{width:100%;max-width:540px;display:grid;gap:18px;justify-items:center;text-align:center}
.nxplay-cover{position:relative;width:min(200px,48vw);aspect-ratio:3/4;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6);background:#11131f}
.nxplay-cover img{width:100%;height:100%;object-fit:cover;display:block}
.nxplay-cover.busy img{animation:nxplayBreathe 2.4s ease-in-out infinite}
.nxplay-cover.busy::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.18) 50%,transparent 70%);background-size:220% 100%;animation:nxplaySheen 1.8s linear infinite}
@keyframes nxplayBreathe{0%,100%{transform:scale(1);filter:brightness(.85)}50%{transform:scale(1.035);filter:brightness(1.05)}}
@keyframes nxplaySheen{from{background-position:120% 0}to{background-position:-120% 0}}
.nxplay h2{margin:0;font-size:clamp(20px,3.4vw,26px);font-weight:900}
.nxplay-steps{display:grid;gap:8px;width:100%;max-width:380px;text-align:left}
.nxplay-step{display:flex;gap:10px;align-items:center;font-size:14px;color:var(--dim)}
.nxplay-step.now{color:var(--text);font-weight:700}
.nxplay-step.done{color:var(--ok)}
.nxplay-step i{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;border:2px solid currentColor;flex:none;font-style:normal;font-size:11px}
.nxplay-bar{width:100%;max-width:380px;height:8px;border-radius:6px;background:rgba(255,255,255,.1);overflow:hidden}
.nxplay-bar b{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .4s ease}
.nxplay-bar.indef b{width:35%!important;animation:nxplayIndef 1.3s ease-in-out infinite}
@keyframes nxplayIndef{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
.nxplay p{margin:0;color:var(--dim);font-size:14px;line-height:1.5}
.nxplay-err{color:#fecaca!important;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);border-radius:12px;padding:10px 12px;overflow-wrap:anywhere}
.nxplay-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}

.nxplay-mode-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;background:rgba(168,85,247,.18);color:#d8b4fe;border:1px solid rgba(168,85,247,.35);margin-bottom:4px}
.nxplay-mode-badge.browser{background:rgba(34,211,238,.18);color:#a5f3fc;border-color:rgba(34,211,238,.35)}

.nx-playmode-box{max-width:560px}
.nx-playmode-header{display:grid;gap:4px;margin-top:-6px}
.nx-playmode-sub{color:rgba(255,255,255,.6);font-size:13.5px;font-weight:600}
.nx-playmode-grid{display:grid;gap:12px;width:100%;text-align:left}
.nx-playmode-card{all:unset;display:flex;gap:16px;align-items:flex-start;padding:16px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);cursor:pointer;transition:all .18s ease;box-sizing:border-box}
.nx-playmode-card:hover,.nx-playmode-card:focus-visible{background:rgba(34,211,238,.12);border-color:rgba(34,211,238,.6);box-shadow:0 0 20px rgba(34,211,238,.25);transform:translateY(-2px)}
.nx-playmode-icon{font-size:26px;flex:none;line-height:1;margin-top:2px}
.nx-playmode-info{display:grid;gap:4px;flex:1;min-width:0}
.nx-playmode-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.nx-playmode-card-title{font-size:15px;font-weight:800;color:#fff}
.nx-playmode-tag{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;padding:2px 8px;border-radius:6px;background:rgba(34,211,238,.2);color:#67e8f9;border:1px solid rgba(34,211,238,.3)}
.nx-playmode-tag.local{background:rgba(168,85,247,.2);color:#c084fc;border-color:rgba(168,85,247,.3)}
.nx-playmode-card-desc{font-size:12.5px;color:rgba(255,255,255,.65);line-height:1.4;margin:0}
.nx-playmode-remember{display:flex;align-items:center;gap:10px;font-size:12.5px;color:rgba(255,255,255,.75);cursor:pointer;user-select:none;margin:4px 0}
.nx-playmode-remember input{-webkit-appearance:checkbox;appearance:auto;display:inline-block;opacity:1;position:static;cursor:pointer;accent-color:#22d3ee;width:18px;height:18px;margin:0;flex:none}
`;

const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export function PlayOverlay() {
  useStyles();
  const [remote, setRemote] = useState(() => { try { return new URLSearchParams(window.location.search).get("play"); } catch { return null; } });
  const [s, setS] = useState(null); // { phase, game, error, pid, retry, progress, startedAt, closed, launchLocal, launchBrowser }
  const [remember, setRemember] = useState(false);
  const timers = useRef([]);
  const clear = () => { timers.current.forEach(clearInterval); timers.current = []; };

  useEffect(() => {
    const on = (e) => {
      const d = e.detail ?? {};
      if (!d.game) return;
      setS((old) => {
        const same = old && old.game?.id === d.game.id;
        const base = same ? old : { game: d.game, startedAt: Date.now() };
        if (d.phase === "choose") {
          return { ...base, phase: "choose", launchLocal: d.launchLocal, launchBrowser: d.launchBrowser };
        }
        if (d.phase === "browser") {
          return { ...base, phase: "browser" };
        }
        if (d.phase === "failed") {
          return { ...base, phase: "failed", error: d.result?.error ?? d.error ?? "It didn't start.", retry: d.retry ?? base.retry };
        }
        if (d.phase === "started") {
          return {
            ...base,
            phase: d.result?.engine ? "engine" : "started",
            engine: d.result?.engine ?? null,
            pid: d.result?.pid ?? null,
            emulator: d.result?.emulator ?? null,
            retry: d.retry ?? base.retry,
          };
        }
        return { ...base, phase: d.phase, retry: d.retry ?? base.retry, error: null };
      });
    };

    const onCloseEv = () => setS(null);
    window.addEventListener("nexus:play", on);
    window.addEventListener("nexus:play-close", onCloseEv);
    return () => {
      window.removeEventListener("nexus:play", on);
      window.removeEventListener("nexus:play-close", onCloseEv);
      clear();
    };
  }, []);

  // While getting ready: the launcher's own download progress.
  useEffect(() => {
    clear();
    if (!s) return undefined;
    if (s.phase === "preparing") {
      const t = setInterval(async () => {
        try {
          const r = await fetch(`${LAUNCHER}/cache-rom/progress?gameId=${encodeURIComponent(s.game.id)}`).then((x) => x.json());
          if (r?.active) setS((o) => (o && o.phase === "preparing" ? { ...o, progress: { received: Number(r.received) || 0, total: Number(r.total) || 0 } } : o));
        } catch { /* launcher busy */ }
      }, 1000);
      timers.current.push(t);
    }
    // While playing: notice when the game closes, and a crash right at the start.
    if (s.phase === "started" && s.pid) {
      const t = setInterval(async () => {
        try {
          const r = await fetch(`${LAUNCHER}/launch/status?pid=${s.pid}`).then((x) => x.json());
          if (!r?.known || r.running) return;
          clearInterval(t);
          if (r.quick && r.exitCode !== 0) {
            setS((o) => o && { ...o, phase: "failed", error: `${r.emulator ?? emulatorFor(o.game.platform)} closed straight away${r.stderr ? `: ${r.stderr.slice(-240)}` : "."} The game file may be damaged, or this console may need its system files (Games > Set up games).` });
          } else {
            setS((o) => o && { ...o, phase: "closed" });
            const t2 = setTimeout(() => setS(null), 2500);
            timers.current.push(t2);
          }
        } catch { /* launcher busy */ }
      }, 2000);
      timers.current.push(t);
    }
    return undefined;
  }, [s?.phase, s?.pid, s?.game?.id]);

  const stop = useCallback(async () => {
    if (s?.pid) await fetch(`${LAUNCHER}/launch/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: s.pid }) }).catch(() => {});
    setS(null);
  }, [s?.pid]);

  if (remote) {
    return <RemotePlayer code={remote.toUpperCase()} onClose={() => {
      try { const u = new URL(window.location.href); u.searchParams.delete("play"); window.history.replaceState(null, "", u.toString()); } catch { /* fine */ }
      setRemote(null);
    }} />;
  }
  if (!s) return <style>{CSS}</style>;
  const { game, phase } = s;
  const cover = game.coverUrl || game.boxArt || game.box_art || `/api/art/${encodeURIComponent(game.id)}`;

  // 1. In-browser play view (EmulatorJS)
  if (phase === "browser" && game) {
    return (
      <div className="fixed inset-0 z-[5500] bg-black">
        <Suspense fallback={
          <div className="nxplay">
            <style>{CSS}</style>
            <div className="nxplay-box">
              <div className="nxplay-cover busy"><img src={cover} alt="" /></div>
              <h2>Starting Browser Player…</h2>
              <p>Loading {game.title} into in-browser emulator…</p>
            </div>
          </div>
        }>
          <BrowserPlayer game={game} forceBrowser={true} onClose={() => setS(null)} />
        </Suspense>
      </div>
    );
  }

  // 2. Play mode choice modal (Browser vs Local PC)
  if (phase === "choose" && game) {
    return (
      <div className="nxplay nxa nx-playmode-modal" role="dialog" aria-modal="true" aria-label={`Choose how to play ${game.title}`}>
        <style>{CSS}</style>
        <div className="nxplay-box nx-playmode-box">
          <div className="nxplay-cover">
            <img src={cover} alt="" onError={(e) => { e.currentTarget.src = `/api/art/${encodeURIComponent(game.id)}`; }} />
          </div>
          <div className="nx-playmode-header">
            <h2>{game.title}</h2>
            <p className="nx-playmode-sub">{String(game.platform || "").toUpperCase()} · Choose your play style</p>
          </div>
          <div className="nx-playmode-grid">
            <button
              type="button"
              className="nx-playmode-card"
              onClick={() => {
                if (remember) {
                  try { localStorage.setItem("nx_play_pref_" + String(game.platform).toLowerCase(), "browser"); } catch {}
                }
                s.launchBrowser?.();
              }}
            >
              <div className="nx-playmode-icon">🌐</div>
              <div className="nx-playmode-info">
                <div className="nx-playmode-title-row">
                  <span className="nx-playmode-card-title">Play in Browser</span>
                  <span className="nx-playmode-tag">Instant · Zero Setup</span>
                </div>
                <p className="nx-playmode-card-desc">Runs directly inside this browser window via EmulatorJS. Cloud save sync included with zero installation.</p>
              </div>
            </button>

            <button
              type="button"
              className="nx-playmode-card"
              onClick={() => {
                if (remember) {
                  try { localStorage.setItem("nx_play_pref_" + String(game.platform).toLowerCase(), "local"); } catch {}
                }
                s.launchLocal?.();
              }}
            >
              <div className="nx-playmode-icon">⚡</div>
              <div className="nx-playmode-info">
                <div className="nx-playmode-title-row">
                  <span className="nx-playmode-card-title">Play Native (Local PC)</span>
                  <span className="nx-playmode-tag local">Full Speed · Offline</span>
                </div>
                <p className="nx-playmode-card-desc">Runs through SaveState for Windows / standalone emulator with dedicated GPU hardware acceleration and offline access.</p>
              </div>
            </button>
          </div>

          <label className="nx-playmode-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Remember my choice for {String(game.platform || "this console").toUpperCase()} games on this device</span>
          </label>

          <div className="nxplay-row">
            <button type="button" className="nxa-btn" onClick={() => setS(null)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Playing inside SaveState Engine.
  if (phase === "engine" && s.engine) {
    const retroArch = () => {
      window.__nxEngineSkip = game.id;
      const r = s.retry;
      setS({ game, phase: "starting", startedAt: Date.now(), retry: r });
      r?.();
    };
    return (
      <EnginePlayer
        key={`${s.engine.port}:${s.engine.key}`}
        engine={s.engine}
        game={game}
        onUseRetroArch={retroArch}
        onExit={(how) => setS((o) => {
          if (!o || o.phase !== "engine") return o;
          if (how?.timedOut && o.pid) {
            fetch(`${LAUNCHER}/launch/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: o.pid }) }).catch(() => {});
          }
          if (how?.crashed || how?.error) {
            return { ...o, phase: "failed", engineFailed: true, error: how.error ?? "The game stopped unexpectedly. Your battery save is kept (it's written every 30 seconds). Try again, or play it in RetroArch." };
          }
          const t2 = setTimeout(() => setS((x) => (x?.phase === "closed" ? null : x)), 2500);
          timers.current.push(t2);
          return { ...o, phase: "closed" };
        })}
      />
    );
  }

  // 4. Native Desktop Emulator (Local Play)
  const exe = String(s.emulator ?? "").split(/[\\/]/).pop().replace(/\.exe$/i, "").replace(/-qt$/i, "");
  const emu = !exe ? emulatorFor(game.platform) : /^pcsx2$/i.test(exe) ? "PCSX2" : /^rpcs3$/i.test(exe) ? "RPCS3" : /^retroarch$/i.test(exe) ? "RetroArch" : exe;
  const pct = s.progress?.total ? Math.min(100, (s.progress.received / s.progress.total) * 100) : null;
  const steps = [
    ["preparing", "Getting the game ready"],
    ["starting", emulatorFor(game.platform) === "RetroArch" ? "Starting the game" : `Starting ${emulatorFor(game.platform)}`],
    ["started", "Playing"],
  ];
  const order = ["preparing", "starting", "started", "closed"];
  const at = order.indexOf(phase);
  const busy = phase === "preparing" || phase === "starting";
  const needsApp = /SaveState for Windows|Set up games/i.test(s.error ?? "");

  return (
    <div className="nxplay nxa" role="dialog" aria-modal="true" aria-live="polite" aria-label={`Playing ${game.title}`}>
      <style>{CSS}</style>
      <div className="nxplay-box">
        <div className="nxplay-mode-badge local">
          <Icon name="bolt" /> Native Desktop Emulator (Local PC Play)
        </div>
        <div className={`nxplay-cover ${busy ? "busy" : ""}`}><img src={cover} alt="" onError={(e) => { e.currentTarget.src = `/api/art/${encodeURIComponent(game.id)}`; }} /></div>
        <h2>{phase === "failed" ? `${game.title} didn't start` : phase === "closed" ? `${game.title} closed` : phase === "started" ? `Playing ${game.title}` : game.title}</h2>

        {phase !== "failed" && phase !== "closed" && (
          <div className="nxplay-steps">
            {steps.map(([key, label], i) => {
              const state = at > i ? "done" : at === i ? "now" : "";
              return (
                <div key={key} className={`nxplay-step ${state}`}>
                  <i>{state === "done" ? "✓" : state === "now" ? <Icon name="spinner" size={12} /> : ""}</i>
                  <span>{label}{key === "preparing" && state === "now" && s.progress?.total ? ` · ${mb(s.progress.received)} of ${mb(s.progress.total)}` : ""}</span>
                </div>
              );
            })}
          </div>
        )}
        {busy && <div className={`nxplay-bar ${pct == null ? "indef" : ""}`}><b style={{ width: `${pct ?? 0}%` }} /></div>}

        {phase === "started" && <p>{emu} is open full screen with your game. Play with your controller or keyboard; close the game (or press Stop) to come back here.</p>}
        {phase === "started" && (() => { try { return localStorage.getItem("nx_engine") === "off"; } catch { return false; } })() && (
          <button className="nxa-link" onClick={() => { try { localStorage.removeItem("nx_engine"); } catch { /* private mode */ } setS(null); }}>Play games inside SaveState next time</button>
        )}
        {phase === "closed" && <p>Welcome back.</p>}
        {phase === "failed" && <p className="nxplay-err">{s.error}</p>}

        <div className="nxplay-row">
          {phase === "failed" && s.retry && <button className="nxa-btn primary" onClick={() => { const r = s.retry; setS({ game, phase: "starting", startedAt: Date.now(), retry: r }); r(); }}><Icon name="refresh" /> Try again</button>}
          {phase === "failed" && s.engineFailed && s.retry && <button className="nxa-btn" onClick={() => { window.__nxEngineSkip = game.id; const r = s.retry; setS({ game, phase: "starting", startedAt: Date.now(), retry: r }); r(); }}><Icon name="game" /> Play in RetroArch</button>}
          {phase === "failed" && needsApp && <button className="nxa-btn" onClick={() => { setS(null); window.dispatchEvent(new CustomEvent("nexus:game-setup")); }}><Icon name="bolt" /> Set up games</button>}
          {phase === "started" && <button className="nxa-btn" onClick={stop}><Icon name="x" /> Stop game</button>}
          {(phase === "failed" || phase === "started" || phase === "closed") && <button className="nxa-btn" onClick={() => setS(null)}>{phase === "started" ? "Hide" : "Close"}</button>}
          {busy && <button className="nxa-btn" onClick={() => setS(null)}>Hide</button>}
        </div>

        {(() => {
          try {
            const p = localStorage.getItem("nx_play_pref_" + String(game.platform).toLowerCase());
            if (p) {
              return (
                <button
                  type="button"
                  className="nxa-link"
                  style={{ fontSize: "12px", opacity: 0.7, marginTop: "4px" }}
                  onClick={() => {
                    try { localStorage.removeItem("nx_play_pref_" + String(game.platform).toLowerCase()); } catch {}
                    setS(null);
                  }}
                >
                  Reset launch preference for {String(game.platform).toUpperCase()}
                </button>
              );
            }
          } catch {}
          return null;
        })()}

        {phase === "failed" && /system files|BIOS/i.test(s.error ?? "") && <button className="nxa-link" onClick={() => { setS(null); goTab("emulation"); }}>What this console needs</button>}
      </div>
    </div>
  );
}
