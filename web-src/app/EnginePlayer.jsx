// A game running in SaveState Engine, drawn inside SaveState.
//
// The launcher started savestate-engine.exe for this game; it streams the
// picture and sound over a local WebSocket (ws://127.0.0.1:<port>), and this
// page sends back the controls. See SAVESTATE_ENGINE_SPEC.md section 4.
//
//   picture  WebGL2: the engine's frame as a texture (RGB565, XRGB8888 or
//            RGBA8), drawn once per display refresh with one of four looks
//            (sharp pixels, smooth, CRT, LCD)
//   sound    an AudioWorklet ring buffer at 48 kHz; it reports how full it is
//            and the engine adjusts its rate to keep it near 64 ms
//   controls keyboard and up to four gamepads (standard mapping), sent only
//            when they change; Esc or the Guide button opens the menu
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useStyles, Icon } from "./lib.jsx";

const CSS = `
.nxe{position:fixed;inset:0;z-index:5600;background:#000;color:#fff;display:block;user-select:none;-webkit-user-select:none}
.nxe canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.nxe.idle{cursor:none}
.nxe-top{position:absolute;top:0;left:0;right:0;display:flex;gap:8px;align-items:center;padding:10px 12px;background:linear-gradient(rgba(0,0,0,.65),transparent);opacity:0;transition:opacity .25s}
.nxe:not(.idle) .nxe-top,.nxe.menu .nxe-top{opacity:1}
.nxe-top b{font-size:14px;font-weight:800;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 3px #000}
.nxe-ib{border:0;background:rgba(255,255,255,.12);color:#fff;border-radius:10px;height:36px;min-width:36px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:600 13px system-ui,sans-serif;cursor:pointer}
.nxe-ib:hover{background:rgba(255,255,255,.22)}
.nxe-menu{position:absolute;inset:0;display:grid;place-items:center;background:rgba(4,6,14,.72);backdrop-filter:blur(6px)}
.nxe-card{width:min(440px,92vw);background:#121522;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:18px;display:grid;gap:12px;box-shadow:0 30px 90px rgba(0,0,0,.6)}
.nxe-card h3{margin:0;font-size:18px}
.nxe-card p{margin:0;color:#aab;font-size:13px;line-height:1.5}
.nxe-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.nxe-btn{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#fff;border-radius:12px;padding:11px 12px;font:600 14px system-ui,sans-serif;cursor:pointer;display:flex;gap:8px;align-items:center;justify-content:center}
.nxe-btn:hover,.nxe-btn:focus-visible{background:rgba(255,255,255,.14);outline:none}
.nxe-btn.primary{background:linear-gradient(90deg,#6d5dfc,#3fb6ff);border-color:transparent}
.nxe-btn.on{border-color:#7c8cff;background:rgba(124,140,255,.22)}
.nxe-row{display:flex;gap:6px;flex-wrap:wrap}
.nxe-row .nxe-btn{flex:1;padding:8px;font-size:13px}
.nxe-stats{font:12px ui-monospace,monospace;color:#9ab;display:grid;gap:2px}
.nxe-toast{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(0,0,0,.78);padding:9px 14px;border-radius:12px;font:600 13px system-ui,sans-serif;pointer-events:none}
.nxe-chip{position:absolute;right:14px;bottom:14px;background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.15);padding:8px 12px;border-radius:12px;font:600 13px system-ui,sans-serif;cursor:pointer}
.nxe-wait{position:absolute;inset:0;display:grid;place-items:center;color:#aab;font:600 14px system-ui,sans-serif}
`;

// libretro joypad ids: B Y Select Start Up Down Left Right A X L R L2 R2 L3 R3
const KEYS = {
  ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7,
  KeyZ: 0, KeyX: 8, KeyA: 1, KeyS: 9, KeyQ: 10, KeyW: 11, KeyE: 12, KeyR: 13,
  Enter: 3, ShiftRight: 2, Backspace: 2, KeyC: 14, KeyV: 15,
};
// Standard-mapping gamepad button -> libretro id (bottom = B, right = A, as on a SNES pad).
const PAD = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7];
const LOOKS = [["sharp", "Sharp pixels"], ["smooth", "Smooth"], ["crt", "CRT"], ["lcd", "LCD"]];
const LOOK_MODE = { smooth: 0, sharp: 1, crt: 2, lcd: 3 };
const TARGET_MS = 64;

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
uniform int rot;
uniform bool flip;
void main() {
  vec2 s = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);   // screen, top-left origin
  vec2 t = rot == 1 ? vec2(1.0 - s.y, s.x) : rot == 2 ? vec2(1.0 - s.x, 1.0 - s.y) : rot == 3 ? vec2(s.y, 1.0 - s.x) : s;
  if (flip) t.y = 1.0 - t.y;
  uv = t;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const FRAG = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform sampler2D tex;
uniform vec2 ts;
uniform vec2 os;
uniform int mode;
uniform bool swapRB;
vec3 fetch(vec2 c) { vec3 v = texture(tex, c).rgb; return swapRB ? v.bgr : v; }
void main() {
  vec3 c;
  vec2 texel = uv * ts;
  if (mode == 1) {
    // Sharp bilinear: whole-pixel blocks with a one-pixel smooth edge.
    vec2 scale = max(floor(os / ts), vec2(1.0));
    vec2 cd = fract(texel) - 0.5;
    vec2 rr = 0.5 - 0.5 / scale;
    vec2 f = (cd - clamp(cd, -rr, rr)) * scale + 0.5;
    c = fetch((floor(texel) + f) / ts);
  } else if (mode == 2) {
    // CRT: scanlines and an aperture-grille mask, brightened back up.
    c = fetch(uv);
    float d = abs(fract(texel.y) - 0.5) * 2.0;
    float scan = 1.0 - 0.5 * d * d;
    float m = mod(gl_FragCoord.x, 3.0);
    vec3 mask = m < 1.0 ? vec3(1.0, 0.72, 0.72) : m < 2.0 ? vec3(0.72, 1.0, 0.72) : vec3(0.72, 0.72, 1.0);
    c = pow(c, vec3(1.1)) * scan * mask * 1.32;
  } else if (mode == 3) {
    // LCD: each pixel a cell with a faint grid between.
    vec2 f = fract(texel);
    c = fetch((floor(texel) + 0.5) / ts);
    float e = 0.12;
    float g = smoothstep(0.0, e, f.x) * smoothstep(0.0, e, 1.0 - f.x) * smoothstep(0.0, e, f.y) * smoothstep(0.0, e, 1.0 - f.y);
    c *= mix(0.72, 1.0, g);
  } else {
    c = fetch(uv);
  }
  o = vec4(c, 1.0);
}`;

const WORKLET = `
class NxSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000; this.L = new Float32Array(this.size); this.R = new Float32Array(this.size);
    this.r = 0; this.n = 0; this.cap = 48000 * 0.35 | 0; this.started = false; this.under = 0; this.tick = 0;
    this.port.onmessage = (e) => {
      const s = e.data, frames = s.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.n >= this.cap) { this.r = (this.r + 1) % this.size; this.n--; }
        const w = (this.r + this.n) % this.size;
        this.L[w] = s[2 * i] / 32768; this.R[w] = s[2 * i + 1] / 32768; this.n++;
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    if (!this.started && this.n >= 1920) this.started = true;
    for (let i = 0; i < L.length; i++) {
      if (this.started && this.n > 0) {
        L[i] = this.L[this.r]; R[i] = this.R[this.r]; this.r = (this.r + 1) % this.size; this.n--;
      } else {
        L[i] = 0; R[i] = 0;
        if (this.started) { this.under++; this.started = false; }
      }
    }
    if (++this.tick % 12 === 0) this.port.postMessage({ fill: this.n / 48, under: this.under });
    return true;
  }
}
registerProcessor("nx-sound", NxSound);`;

const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

export function EnginePlayer({ engine, game, onExit, onUseRetroArch }) {
  useStyles();
  const box = useRef(null);
  const canvas = useRef(null);
  const sock = useRef(null);
  const st = useRef({ info: engine.ready ?? null, frame: null, fresh: false, exited: false, padPrev: [], keys: 0, ff: false });
  const [info, setInfo] = useState(engine.ready ?? null);
  const [menu, setMenu] = useState(false);
  const [status, setStatus] = useState(null);
  const [toast, setToast] = useState(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [connected, setConnected] = useState(false);
  const [idle, setIdle] = useState(false);
  const [slot, setSlot] = useState(Number(load("nx_engine_slot", "1")) || 1);
  const [look, setLook] = useState(() => load(`nx_engine_look_${game.platform}`, engine.ready?.gpu ? "smooth" : "sharp"));
  const [stats, setStats] = useState(load("nx_engine_stats", "0") === "1");
  const lookRef = useRef(look);
  lookRef.current = look;

  const send = useCallback((m) => { const s = sock.current; if (s && s.readyState === 1) s.send(JSON.stringify(m)); }, []);
  const flash = useCallback((text) => { setToast(text); clearTimeout(flash.t); flash.t = setTimeout(() => setToast(null), 2200); }, []);

  // ── Socket, picture and sound ─────────────────────────────────────────
  useEffect(() => {
    const S = st.current;
    // Held here: the ref is cleared on unmount before this effect's cleanup runs.
    const cv = canvas.current;
    const gl = cv.getContext("webgl2", { antialias: false, alpha: false, desynchronized: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) { onExit({ error: "This browser can't draw the game (WebGL 2 is off). Try Chrome or Edge, or play in RetroArch." }); return undefined; }
    const compile = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const u = { rot: U("rot"), flip: U("flip"), ts: U("ts"), os: U("os"), mode: U("mode"), swapRB: U("swapRB") };
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let texShape = "";

    // Sound.
    let ctx = null, node = null, lastFill = 0;
    (async () => {
      try {
        ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        node = new AudioWorkletNode(ctx, "nx-sound", { outputChannelCount: [2] });
        node.connect(ctx.destination);
        node.port.onmessage = (e) => {
          const now = performance.now();
          if (now - lastFill >= 100) { lastFill = now; send({ t: "audio", fill: e.data.fill, target: TARGET_MS }); }
        };
        if (ctx.state !== "running") setSoundBlocked(true);
      } catch { setSoundBlocked(false); }
    })();
    const unlock = () => { if (ctx && ctx.state !== "running") ctx.resume().then(() => setSoundBlocked(false)).catch(() => {}); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    // Socket.
    const ws = new WebSocket(`ws://127.0.0.1:${engine.port}/session?key=${encodeURIComponent(engine.key)}`);
    ws.binaryType = "arraybuffer";
    sock.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "ready") { S.info = m.info; setInfo(m.info); }
        else if (m.type === "geometry") { S.info = { ...S.info, ...m }; setInfo((i) => ({ ...i, ...m })); }
        else if (m.type === "status") setStatus(m);
        else if (m.type === "saved") flash(`Saved to slot ${m.slot}`);
        else if (m.type === "loaded") flash(`Loaded slot ${m.slot}`);
        else if (m.type === "error") flash(m.message);
        else if (m.type === "exit") { S.exited = true; }
        return;
      }
      const d = e.data;
      const kind = new Uint8Array(d, 0, 1)[0];
      if (kind === 0x56) { S.frame = d; S.fresh = true; }
      else if (kind === 0x41 && node) {
        const frames = new DataView(d).getUint32(4, true);
        const samples = new Int16Array(d.slice(8, 8 + frames * 4));
        node.port.postMessage(samples, [samples.buffer]);
      }
    };
    ws.onclose = () => { setConnected(false); onExit(S.exited ? {} : { crashed: true }); };

    // Display refresh: measured from animation frames, sent once.
    let raf = 0, last = 0, deltas = [], told = false;
    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      if (!told && last) { deltas.push(now - last); if (deltas.length === 90) { deltas.sort((a, b) => a - b); send({ t: "display", hz: 1000 / deltas[45] }); told = true; } }
      last = now;
      pollPads();
      if (!S.fresh || !S.frame) return;
      S.fresh = false;
      const dv = new DataView(S.frame);
      const fmt = dv.getUint8(1), flags = dv.getUint8(2), w = dv.getUint32(4, true), h = dv.getUint32(8, true);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const shape = `${fmt}:${w}x${h}`;
      if (fmt === 0) {
        const px = new Uint16Array(S.frame, 24, w * h);
        if (shape !== texShape) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB565, w, h, 0, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, px);
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, px);
      } else {
        const px = new Uint8Array(S.frame, 24, w * h * 4);
        if (shape !== texShape) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      texShape = shape;
      // Letterbox to the game's aspect (turned for rotated arcade screens).
      const c = cv;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(c.clientWidth * dpr), ch = Math.round(c.clientHeight * dpr);
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const rot = (S.info?.rotation ?? 0) & 3;
      let aspect = S.info?.aspect > 0 ? S.info.aspect : w / h;
      if (rot & 1) aspect = 1 / aspect;
      let vw = cw, vh = Math.round(cw / aspect);
      if (vh > ch) { vh = ch; vw = Math.round(ch * aspect); }
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(Math.floor((cw - vw) / 2), Math.floor((ch - vh) / 2), vw, vh);
      gl.uniform1i(u.rot, rot);
      gl.uniform1i(u.flip, flags & 1 ? 1 : 0);
      gl.uniform2f(u.ts, w, h);
      gl.uniform2f(u.os, rot & 1 ? vh : vw, rot & 1 ? vw : vh);
      gl.uniform1i(u.mode, LOOK_MODE[lookRef.current] ?? 0);
      gl.uniform1i(u.swapRB, fmt === 1 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    // Controls: keyboard on port 0 together with the first pad.
    const sent = [];
    const pollPads = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let port = 0; port < 4; port++) {
        const g = pads[port];
        let b = port === 0 ? S.keys : 0;
        const a = [0, 0, 0, 0], tr = [0, 0];
        if (g && g.connected) {
          g.buttons.forEach((btn, i) => { if (i < 16 && btn.pressed) b |= 1 << PAD[i]; });
          for (let i = 0; i < 4; i++) { const v = g.axes[i] ?? 0; a[i] = Math.abs(v) < 0.12 ? 0 : Math.round(v * 32767); }
          tr[0] = Math.round((g.buttons[6]?.value ?? 0) * 32767);
          tr[1] = Math.round((g.buttons[7]?.value ?? 0) * 32767);
          const guide = g.buttons[16]?.pressed || (g.buttons[8]?.pressed && g.buttons[9]?.pressed);
          if (guide && !S.padPrev[port]) setMenu((m) => !m);
          S.padPrev[port] = guide;
        }
        if (S.menuOpen) b = 0;
        const key = `${b}|${a}|${tr}`;
        if (sent[port] !== key) { sent[port] = key; send({ t: "in", p: port, b, a, g: tr }); }
      }
    };
    // Keys belong to the game while it's open: caught first (capture) and kept
    // from the app underneath, whose library would otherwise start the focused
    // game on Enter. Browser keys (reload, full screen, dev tools) still work.
    const onKey = (down) => (e) => {
      if (/^F(5|11|12)$/.test(e.key)) return;
      const inMenu = S.menuOpen && e.target instanceof Element && e.target.closest(".nxe-card");
      if (!inMenu) e.stopImmediatePropagation();
      if (e.code === "Escape" && down) { e.preventDefault(); setMenu((m) => !m); return; }
      if (e.code === "Tab") { e.preventDefault(); if (S.ff !== down) { S.ff = down; send({ t: "ff", on: down }); } return; }
      const id = KEYS[e.code];
      if (id === undefined || S.menuOpen) return;
      e.preventDefault();
      S.keys = down ? S.keys | (1 << id) : S.keys & ~(1 << id);
    };
    const kd = onKey(true), ku = onKey(false);
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);
    window.__nxGameOpen = true;
    const blur = () => { S.keys = 0; if (S.ff) { S.ff = false; send({ t: "ff", on: false }); } };
    window.addEventListener("blur", blur);
    const vis = () => send({ t: document.hidden || S.menuOpen ? "pause" : "resume" });
    document.addEventListener("visibilitychange", vis);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("keyup", ku, true);
      window.__nxGameOpen = false;
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", vis);
      ws.onclose = null;
      try { ws.close(); } catch { /* closed */ }
      if (ctx) ctx.close().catch(() => {});
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // The session is fixed for this player's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The menu pauses the game.
  useEffect(() => {
    st.current.menuOpen = menu;
    send({ t: menu ? "pause" : "resume" });
  }, [menu, send]);

  // The pointer hides while playing.
  useEffect(() => {
    let t = setTimeout(() => setIdle(true), 2500);
    const move = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); };
    window.addEventListener("pointermove", move);
    return () => { clearTimeout(t); window.removeEventListener("pointermove", move); };
  }, []);

  // Full screen as the game opens (browsers allow it right after the Play click).
  useEffect(() => { box.current?.requestFullscreen?.().catch(() => {}); }, []);

  const quit = useCallback(() => {
    st.current.exited = true;
    send({ t: "quit" });
    // The engine saves and closes; the socket closing ends the player. If it
    // hasn't within 5 s (a very busy PC), the launcher stops it.
    setTimeout(() => onExit({ timedOut: true }), 5000);
  }, [send, onExit]);
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : box.current?.requestFullscreen())?.catch?.(() => {});
  const chooseLook = (k) => { setLook(k); save(`nx_engine_look_${game.platform}`, k); };
  const chooseSlot = (n) => { setSlot(n); save("nx_engine_slot", String(n)); };

  return (
    <div ref={box} className={`nxe ${idle && !menu ? "idle" : ""} ${menu ? "menu" : ""}`} role="application" aria-label={`${game.title}, playing in SaveState`}>
      <style>{CSS}</style>
      <canvas ref={canvas} />
      {!connected && <div className="nxe-wait"><span><Icon name="spinner" /> Connecting to the game…</span></div>}
      <div className="nxe-top">
        <b>{game.title}</b>
        <button className="nxe-ib" onClick={() => setMenu(true)} title="Menu (Esc)"><Icon name="game" /> Menu</button>
        <button className="nxe-ib" onClick={fullscreen} title="Full screen"><Icon name="ext" /></button>
        <button className="nxe-ib" onClick={quit} title="Close the game"><Icon name="x" /></button>
      </div>
      {stats && status && !menu && (
        <div className="nxe-stats" style={{ position: "absolute", left: 12, bottom: 12, background: "rgba(0,0,0,.6)", padding: "6px 9px", borderRadius: 10 }}>
          <span>{status.fps} fps · {status.frameMs} ms/frame</span>
          <span>sound buffer {status.audioFillMs} ms{status.dropped ? ` · ${status.dropped} skipped` : ""}</span>
        </div>
      )}
      {soundBlocked && <button className="nxe-chip" onClick={() => setSoundBlocked(false)}>Click or press a key for sound</button>}
      {toast && <div className="nxe-toast">{toast}</div>}
      {menu && (
        <div className="nxe-menu" onClick={(e) => { if (e.target === e.currentTarget) setMenu(false); }}>
          <div className="nxe-card">
            <h3>{game.title}</h3>
            <p>{info?.core ?? "SaveState Engine"}{info?.gpu ? ` · ${info.gpu.replace(/\/PCIe\/SSE2/, "")}` : ""}</p>
            <button className="nxe-btn primary" onClick={() => setMenu(false)} autoFocus>Resume</button>
            <div className="nxe-row" role="group" aria-label="Save slot">
              {[1, 2, 3, 4].map((n) => <button key={n} className={`nxe-btn ${slot === n ? "on" : ""}`} onClick={() => chooseSlot(n)}>Slot {n}</button>)}
            </div>
            <div className="nxe-grid">
              <button className="nxe-btn" disabled={status?.canSave === false} onClick={() => { send({ t: "save", slot }); setMenu(false); }}><Icon name="down" /> Save</button>
              <button className="nxe-btn" disabled={status?.canSave === false} onClick={() => { send({ t: "load", slot }); setMenu(false); }}><Icon name="refresh" /> Load</button>
              <button className="nxe-btn" onClick={() => { send({ t: "reset" }); setMenu(false); }}><Icon name="bolt" /> Restart</button>
              <button className="nxe-btn" onClick={fullscreen}><Icon name="ext" /> Full screen</button>
            </div>
            <div className="nxe-row" role="group" aria-label="Look">
              {LOOKS.map(([k, label]) => <button key={k} className={`nxe-btn ${look === k ? "on" : ""}`} onClick={() => chooseLook(k)}>{label}</button>)}
            </div>
            <p>Keyboard: arrows move, Z/X/A/S face buttons, Q/W shoulders, Enter Start, right Shift Select, hold Tab to fast-forward, Esc menu. Controllers work as they are; the Guide button opens this menu.</p>
            <div className="nxe-grid">
              <button className={`nxe-btn ${stats ? "on" : ""}`} onClick={() => { setStats(!stats); save("nx_engine_stats", stats ? "0" : "1"); }}><Icon name="chip" /> Stats</button>
              <button className="nxe-btn" onClick={quit}><Icon name="x" /> Close game</button>
            </div>
            {onUseRetroArch && <button className="nxe-btn" onClick={() => { save("nx_engine", "off"); quit(); setTimeout(onUseRetroArch, 300); }}>Open games in RetroArch instead</button>}
          </div>
        </div>
      )}
    </div>
  );
}
