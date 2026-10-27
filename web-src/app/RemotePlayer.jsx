// Playing a game that runs on another PC (SaveState Engine, "play from
// another device"). Opened with ?play=<code>: the PC's player (EnginePlayer)
// sends the game's picture and sound over WebRTC; this page shows them and
// sends the controls back on a data channel: keyboard, controllers (Gamepad
// API), and on-screen buttons on touch screens. server/rtc.ts introduces the
// two; nothing of the game passes through the host.
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useStyles, Icon, token } from "./lib.jsx";
import { DEFAULT_KEYS, PAD_POSITION, ICE, iceGathered } from "./EnginePlayer.jsx";

const CSS = `
.nxr{position:fixed;inset:0;z-index:5700;background:#000;color:#fff;user-select:none;-webkit-user-select:none;touch-action:none}
.nxr video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.nxr-top{position:absolute;top:0;left:0;right:0;display:flex;gap:8px;align-items:center;padding:10px 12px;background:linear-gradient(rgba(0,0,0,.6),transparent)}
.nxr-top b{flex:1;font:800 14px system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nxr-ib{border:0;background:rgba(255,255,255,.14);color:#fff;border-radius:10px;height:36px;min-width:36px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;font:600 13px system-ui,sans-serif;cursor:pointer}
.nxr-msg{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px;font:600 15px system-ui,sans-serif;color:#cbd}
.nxr-msg p{max-width:420px;line-height:1.5}
.nxr-pad{position:absolute;inset:0;pointer-events:none}
.nxr-pad button{pointer-events:auto;position:absolute;border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff;border-radius:50%;font:800 15px system-ui,sans-serif;touch-action:none}
.nxr-pad button.on{background:rgba(124,140,255,.55)}
.nxr-pad .dp{border-radius:12px;width:58px;height:58px}
.nxr-pad .fc{width:62px;height:62px}
.nxr-pad .sh{border-radius:14px;width:84px;height:40px}
.nxr-pad .sm{border-radius:14px;width:70px;height:32px;font-size:12px}
.nxr-stat{position:absolute;left:10px;bottom:10px;font:11px ui-monospace,monospace;color:#9ab;background:rgba(0,0,0,.5);padding:4px 7px;border-radius:8px}
`;

// On-screen buttons: libretro ids and where they sit (as % of the screen, from the edges).
const TOUCH = [
  { id: 4, label: "▲", cls: "dp", style: { left: "calc(6% + 58px)", bottom: "calc(14% + 116px)" } },
  { id: 5, label: "▼", cls: "dp", style: { left: "calc(6% + 58px)", bottom: "14%" } },
  { id: 6, label: "◀", cls: "dp", style: { left: "6%", bottom: "calc(14% + 58px)" } },
  { id: 7, label: "▶", cls: "dp", style: { left: "calc(6% + 116px)", bottom: "calc(14% + 58px)" } },
  { id: 9, label: "X", cls: "fc", style: { right: "calc(6% + 62px)", bottom: "calc(14% + 124px)" } },
  { id: 1, label: "Y", cls: "fc", style: { right: "calc(6% + 124px)", bottom: "calc(14% + 62px)" } },
  { id: 8, label: "A", cls: "fc", style: { right: "6%", bottom: "calc(14% + 62px)" } },
  { id: 0, label: "B", cls: "fc", style: { right: "calc(6% + 62px)", bottom: "14%" } },
  { id: 10, label: "L", cls: "sh", style: { left: "4%", top: "64px" } },
  { id: 11, label: "R", cls: "sh", style: { right: "4%", top: "64px" } },
  { id: 2, label: "Select", cls: "sm", style: { left: "calc(50% - 80px)", bottom: "5%" } },
  { id: 3, label: "Start", cls: "sm", style: { left: "calc(50% + 10px)", bottom: "5%" } },
];

export function RemotePlayer({ code, onClose }) {
  useStyles();
  const video = useRef(null);
  const st = useRef({ dc: null, keys: 0, touch: 0, sent: "" });
  const [phase, setPhase] = useState("joining"); // joining | waiting | connecting | playing | ended | error
  const [error, setError] = useState(null);
  const [game, setGame] = useState("");
  const [muted, setMuted] = useState(true);
  const [touchOn, setTouchOn] = useState(() => typeof window !== "undefined" && (navigator.maxTouchPoints > 0 || "ontouchstart" in window));
  const [touchBits, setTouchBits] = useState(0);
  const [stat, setStat] = useState(null);

  // Connect.
  useEffect(() => {
    let gone = false;
    const headers = { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" };
    const pc = new RTCPeerConnection({ iceServers: ICE });
    st.current.pc = pc;
    pc.ontrack = (e) => {
      const v = video.current;
      if (!v) return;
      v.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      v.play().catch(() => {});
    };
    const ended = () => { if (gone) return; setPhase("ended"); try { pc.close(); } catch { /* closed */ } const v = video.current; if (v) v.srcObject = null; };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      st.current.dc = dc;
      dc.onmessage = (m) => { try { if (JSON.parse(m.data).t === "bye") ended(); } catch { /* not ours */ } };
      dc.onclose = ended;
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") setPhase("playing");
      else if (s === "failed") { setPhase("error"); setError("The connection to the PC failed. Both devices need to reach each other (the same network works best)."); }
      else if (s === "disconnected" || s === "closed") setPhase("ended");
    };
    (async () => {
      try {
        let offer = null;
        for (let i = 0; i < 6 && !gone && !offer; i++) {
          const r = await fetch(`/api/rtc/rooms/${encodeURIComponent(code)}/offer`, { headers });
          if (r.status === 200) offer = await r.json();
          else if (r.status !== 204) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`); }
          else setPhase("waiting");
        }
        if (!offer) throw new Error("The PC hasn't started sharing yet. Choose “Play on my phone or tablet” in the game's menu on the PC.");
        if (gone) return;
        setGame(offer.game ?? "");
        setPhase("connecting");
        await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await iceGathered(pc);
        const r = await fetch(`/api/rtc/rooms/${encodeURIComponent(code)}/answer`, { method: "PUT", headers, body: JSON.stringify({ sdp: pc.localDescription.sdp }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`); }
      } catch (e) {
        if (!gone) { setPhase("error"); setError(e.message); }
      }
    })();
    return () => { gone = true; try { pc.close(); } catch { /* closed */ } };
  }, [code]);

  // Controls: keyboard, controllers and touch, sent when they change.
  useEffect(() => {
    const S = st.current;
    const onKey = (down) => (e) => {
      const id = DEFAULT_KEYS[e.code];
      if (id === undefined) return;
      e.preventDefault();
      S.keys = down ? S.keys | (1 << id) : S.keys & ~(1 << id);
    };
    const kd = onKey(true), ku = onKey(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      let b = S.keys | S.touch;
      const a = [0, 0, 0, 0], g = [0, 0];
      for (const pad of navigator.getGamepads ? navigator.getGamepads() : []) {
        if (!pad || !pad.connected) continue;
        pad.buttons.forEach((btn, i) => { if (i < 16 && btn.pressed) b |= 1 << PAD_POSITION[i]; });
        for (let i = 0; i < 4; i++) { const v = pad.axes[i] ?? 0; if (Math.abs(v) >= 0.12) a[i] = Math.round(v * 32767); }
        g[0] = Math.max(g[0], Math.round((pad.buttons[6]?.value ?? 0) * 32767));
        g[1] = Math.max(g[1], Math.round((pad.buttons[7]?.value ?? 0) * 32767));
        break;
      }
      const key = `${b}|${a}|${g}`;
      if (S.dc?.readyState === "open" && key !== S.sent) { S.sent = key; S.dc.send(JSON.stringify({ t: "in", b, a, g })); }
    };
    raf = requestAnimationFrame(tick);
    // The controller is the game's while it plays: the app's menus behind it
    // stop following it (boot.js, controller navigation).
    window.__nxGameOpen = true;
    return () => { window.__nxGameOpen = false; cancelAnimationFrame(raf); window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, []);

  // A little connection information every 2 s.
  useEffect(() => {
    if (phase !== "playing") return undefined;
    const t = setInterval(async () => {
      const pc = st.current.pc;
      if (!pc) return;
      const report = await pc.getStats();
      let fps = null, rtt = null, size = null;
      report.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") { fps = r.framesPerSecond ?? fps; size = r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : size; }
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) rtt = Math.round(r.currentRoundTripTime * 1000);
      });
      setStat({ fps, rtt, size });
    }, 2000);
    return () => clearInterval(t);
  }, [phase]);

  const press = useCallback((id, down) => {
    const S = st.current;
    S.touch = down ? S.touch | (1 << id) : S.touch & ~(1 << id);
    setTouchBits(S.touch);
  }, []);

  const unmute = () => { const v = video.current; if (v) { v.muted = false; v.play().catch(() => {}); } setMuted(false); };

  return (
    <div className="nxr" role="application" aria-label={`Playing ${game || "a game"} from another device`}>
      <style>{CSS}</style>
      <video ref={video} playsInline autoPlay muted={muted} />
      {phase !== "playing" && (
        <div className="nxr-msg"><p>
          {phase === "error" ? error
            : phase === "ended" ? "The game on the PC stopped sharing."
            : phase === "waiting" ? "Waiting for the PC…"
            : <><Icon name="spinner" /> Connecting to the PC…</>}
        </p></div>
      )}
      <div className="nxr-top">
        <b>{game || "Playing from another PC"}</b>
        {muted && phase === "playing" && <button className="nxr-ib" onClick={unmute}>Tap for sound</button>}
        <button className="nxr-ib" onClick={() => setTouchOn(!touchOn)} title="On-screen buttons"><Icon name="game" /></button>
        <button className="nxr-ib" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})} title="Full screen"><Icon name="ext" /></button>
        <button className="nxr-ib" onClick={onClose} title="Leave"><Icon name="x" /></button>
      </div>
      {touchOn && phase === "playing" && (
        <div className="nxr-pad">
          {TOUCH.map((t) => (
            <button key={t.id} className={`${t.cls} ${touchBits & (1 << t.id) ? "on" : ""}`} style={t.style}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); press(t.id, true); }}
              onPointerUp={() => press(t.id, false)} onPointerCancel={() => press(t.id, false)} onLostPointerCapture={() => press(t.id, false)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {stat && <div className="nxr-stat">{stat.size ?? ""}{stat.fps ? ` · ${Math.round(stat.fps)} fps` : ""}{stat.rtt != null ? ` · ${stat.rtt} ms` : ""}</div>}
    </div>
  );
}
