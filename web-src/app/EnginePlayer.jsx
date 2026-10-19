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
//            and the engine adjusts its rate to keep it at a target that
//            starts at 64 ms, comes down towards 32 ms while the sound is
//            steady and goes back up after a gap
//   controls Xbox-type controllers are read by the engine itself (XInput);
//            the keyboard (remappable) and other controllers (Gamepad API) are
//            read here and sent when they change. Guide or Back with RB save,
//            LB load, Start menu, RT fast-forward, LT rewind; Esc menu, Tab
//            fast-forward, ` rewind, F2 save, F4 load
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
.nxe-menu{position:absolute;inset:0;display:grid;place-items:center;background:rgba(4,6,14,.72);backdrop-filter:blur(6px);overflow:auto;padding:16px}
.nxe-card{width:min(520px,94vw);background:#121522;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:18px;display:grid;gap:12px;box-shadow:0 30px 90px rgba(0,0,0,.6)}
.nxe-card h3{margin:0;font-size:18px}
.nxe-card h4{margin:4px 0 0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8f97b8}
.nxe-card p{margin:0;color:#aab;font-size:13px;line-height:1.5}
.nxe-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.nxe-btn{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#fff;border-radius:12px;padding:11px 12px;font:600 14px system-ui,sans-serif;cursor:pointer;display:flex;gap:8px;align-items:center;justify-content:center}
.nxe-btn:hover,.nxe-btn:focus-visible{background:rgba(255,255,255,.14);outline:none}
.nxe-btn:disabled{opacity:.4;cursor:default}
.nxe-btn.primary{background:linear-gradient(90deg,#6d5dfc,#3fb6ff);border-color:transparent}
.nxe-btn.on{border-color:#7c8cff;background:rgba(124,140,255,.22)}
.nxe-row{display:flex;gap:6px;flex-wrap:wrap}
.nxe-row .nxe-btn{flex:1;padding:8px;font-size:13px}
.nxe-slots{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.nxe-slot{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:12px;padding:6px;cursor:pointer;color:#fff;display:grid;gap:4px;font:600 12px system-ui,sans-serif;text-align:center}
.nxe-slot.on{border-color:#7c8cff;background:rgba(124,140,255,.18)}
.nxe-slot div{aspect-ratio:4/3;border-radius:8px;background:#0a0c14 center/cover no-repeat;display:grid;place-items:center;color:#667;font-size:11px;image-rendering:pixelated}
.nxe-slot small{color:#8f97b8;font-weight:500}
.nxe-keys{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.nxe-key{display:flex;justify-content:space-between;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:6px 8px;font:13px system-ui,sans-serif;background:rgba(255,255,255,.03);cursor:pointer;color:#fff}
.nxe-key kbd{font:600 12px ui-monospace,monospace;background:rgba(255,255,255,.1);border-radius:6px;padding:2px 6px}
.nxe-key.wait kbd{background:#6d5dfc}
.nxe-stats{font:12px ui-monospace,monospace;color:#9ab;display:grid;gap:2px}
.nxe-toast{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(0,0,0,.78);padding:9px 14px;border-radius:12px;font:600 13px system-ui,sans-serif;pointer-events:none}
.nxe-chip{position:absolute;right:14px;bottom:14px;background:rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.15);padding:8px 12px;border-radius:12px;font:600 13px system-ui,sans-serif;cursor:pointer}
.nxe-wait{position:absolute;inset:0;display:grid;place-items:center;color:#aab;font:600 14px system-ui,sans-serif}
.nxe-rw{position:absolute;top:14px;right:14px;background:rgba(0,0,0,.65);padding:6px 10px;border-radius:10px;font:700 13px system-ui,sans-serif}
`;

// libretro joypad ids, in order: B Y Select Start Up Down Left Right A X L R L2 R2 L3 R3
const BUTTONS = ["B", "Y", "Select", "Start", "Up", "Down", "Left", "Right", "A", "X", "L", "R", "L2", "R2", "L3", "R3"];
const DEFAULT_KEYS = {
  ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7,
  KeyZ: 0, KeyX: 8, KeyA: 1, KeyS: 9, KeyQ: 10, KeyW: 11, KeyE: 12, KeyR: 13,
  Enter: 3, ShiftRight: 2, Backspace: 2, KeyC: 14, KeyV: 15,
};
// Standard-mapping gamepad button -> libretro id. By position, the bottom
// button is the console's bottom button (B on a SNES pad); by label, the
// button marked A is the console's A.
const PAD_POSITION = [0, 8, 1, 9, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7];
const PAD_LABELS = [8, 0, 9, 1, 10, 11, 12, 13, 2, 3, 14, 15, 4, 5, 6, 7];
const LOOKS = [["sharp", "Sharp pixels"], ["smooth", "Smooth"], ["crt", "CRT"], ["lcd", "LCD"]];
const LOOK_MODE = { smooth: 0, sharp: 1, crt: 2, lcd: 3 };
// Controllers the engine reads itself (XInput): left out here so they don't count twice.
const ENGINE_PAD = /xinput|xbox|045e/i;

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

// Sound ring buffer. It starts (and restarts after a gap) once it holds
// `pre` frames, half the current target, and reports its fill and gaps.
const WORKLET = `
class NxSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000; this.L = new Float32Array(this.size); this.R = new Float32Array(this.size);
    this.r = 0; this.n = 0; this.cap = 48000 * 0.35 | 0; this.pre = 1536; this.started = false; this.under = 0; this.tick = 0;
    this.port.onmessage = (e) => {
      const s = e.data;
      if (s.pre) { this.pre = s.pre; return; }
      const frames = s.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.n >= this.cap) { this.r = (this.r + 1) % this.size; this.n--; }
        const w = (this.r + this.n) % this.size;
        this.L[w] = s[2 * i] / 32768; this.R[w] = s[2 * i + 1] / 32768; this.n++;
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    if (!this.started && this.n >= this.pre) this.started = true;
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
const loadKeys = () => { try { const k = JSON.parse(localStorage.getItem("nx_engine_keys") ?? "null"); return k && typeof k === "object" ? k : { ...DEFAULT_KEYS }; } catch { return { ...DEFAULT_KEYS }; } };
const keyName = (code) => code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "").replace("Right", " R").replace("Left", " L").replace("Shift R", "R-Shift").trim();
const ago = (secs) => {
  const d = Date.now() / 1000 - secs;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(secs * 1000).toLocaleDateString();
};

export function EnginePlayer({ engine, game, onExit, onUseRetroArch }) {
  useStyles();
  const plat = String(game.platform ?? "").toLowerCase();
  const box = useRef(null);
  const canvas = useRef(null);
  const sock = useRef(null);
  const st = useRef({
    info: engine.ready ?? null, frame: null, fresh: false, exited: false, keys: 0, ff: false, rw: false, menuOpen: false,
    nativeCount: 0, pads: [], rumble: [], keymap: loadKeys(), listen: null, labels: load("nx_engine_layout", "position") === "labels",
    target: 64, calmSince: performance.now(), under: 0, worklet: null,
  });
  const [info, setInfo] = useState(engine.ready ?? null);
  const [menu, setMenu] = useState(false);
  const [status, setStatus] = useState(null);
  const [toast, setToast] = useState(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [connected, setConnected] = useState(false);
  const [idle, setIdle] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [slots, setSlots] = useState(null);
  const [slot, setSlot] = useState(Number(load("nx_engine_slot", "1")) || 1);
  const [look, setLook] = useState(() => load(`nx_engine_look_${plat}`, engine.ready?.gpu ? "smooth" : "sharp"));
  const [stats, setStats] = useState(load("nx_engine_stats", "0") === "1");
  const [runahead, setRunahead] = useState(Number(load(`nx_engine_runahead_${plat}`, "0")) || 0);
  const [rewindOn, setRewindOn] = useState(load("nx_engine_rewind", "1") === "1");
  const [ffSpeed, setFfSpeed] = useState(Number(load("nx_engine_ffspeed", "4")));
  const [labels, setLabels] = useState(st.current.labels);
  const [keysPanel, setKeysPanel] = useState(false);
  const [keymap, setKeymap] = useState(st.current.keymap);
  const [listening, setListening] = useState(null);
  const lookRef = useRef(look);
  lookRef.current = look;
  const prefs = useRef({});
  prefs.current = { runahead, rewindOn, ffSpeed, labels, slot };

  const send = useCallback((m) => { const s = sock.current; if (s && s.readyState === 1) s.send(JSON.stringify(m)); }, []);
  const flash = useCallback((text) => { setToast(text); clearTimeout(flash.t); flash.t = setTimeout(() => setToast(null), 2200); }, []);

  // ── Socket, picture, sound and controls ───────────────────────────────
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

    // Sound, with the target buffer adapting: down 8 ms after 20 s without a
    // gap (to 32 ms), up 16 ms after a gap (to 128 ms).
    let ctx = null, node = null, lastFill = 0;
    const setPre = () => S.worklet?.port.postMessage({ pre: Math.round((S.target / 2) * 48) });
    (async () => {
      try {
        ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        node = new AudioWorkletNode(ctx, "nx-sound", { outputChannelCount: [2] });
        node.connect(ctx.destination);
        S.worklet = node;
        setPre();
        node.port.onmessage = (e) => {
          const now = performance.now();
          if (e.data.under > S.under) {
            S.under = e.data.under;
            S.target = Math.min(S.target + 16, 128);
            S.calmSince = now;
            setPre();
          } else if (now - S.calmSince > 20000 && S.target > 32) {
            S.target -= 8;
            S.calmSince = now;
            setPre();
          }
          if (now - lastFill >= 100) { lastFill = now; send({ t: "audio", fill: e.data.fill, target: S.target }); }
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
    ws.onopen = () => {
      setConnected(true);
      const p = prefs.current;
      send({ t: "runahead", frames: p.runahead });
      send({ t: "rewinding", enabled: p.rewindOn });
      send({ t: "ffspeed", x: p.ffSpeed });
      send({ t: "layout", labels: p.labels });
      send({ t: "slot", n: p.slot });
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "ready") { S.info = m.info; setInfo(m.info); }
        else if (m.type === "geometry") { S.info = { ...S.info, ...m }; setInfo((i) => ({ ...i, ...m })); }
        else if (m.type === "status") { setStatus(m); S.nativeCount = m.pads ?? 0; }
        else if (m.type === "pads") { if (m.native > S.nativeCount) flash("Controller connected"); else if (m.native < S.nativeCount) flash("Controller disconnected"); S.nativeCount = m.native; }
        else if (m.type === "saved") { flash(`Saved to slot ${m.slot}`); send({ t: "slots" }); }
        else if (m.type === "loaded") flash(`Loaded slot ${m.slot}`);
        else if (m.type === "slots") setSlots(m.slots);
        else if (m.type === "menu") setMenu((x) => !x);
        else if (m.type === "ff") { if (m.on) flash(`Fast-forward${prefs.current.ffSpeed ? ` ${prefs.current.ffSpeed}×` : ""}`); }
        else if (m.type === "rumble") S.rumble[m.port] = { strong: m.strong / 65535, weak: m.weak / 65535, at: 0 };
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
      pollPads(now);
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
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(cv.clientWidth * dpr), ch = Math.round(cv.clientHeight * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
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

    const setRw = (on) => { if (S.rw !== on) { S.rw = on; setRewinding(on); send({ t: "rewind", on }); } };
    const setFf = (on) => { if (S.ff !== on) { S.ff = on; send({ t: "ff", on }); if (on) flash(`Fast-forward${prefs.current.ffSpeed ? ` ${prefs.current.ffSpeed}×` : ""}`); } };
    const hotkey = (name) => {
      if (name === "save") send({ t: "save", slot: prefs.current.slot });
      else if (name === "load") send({ t: "load", slot: prefs.current.slot });
      else if (name === "menu") setMenu((m) => !m);
    };

    // The page's controllers: those the engine doesn't read itself, on the
    // ports after the engine's. Guide or Back + RB/LB/Start/RT/LT are hotkeys
    // (Back alone stays Select); the game doesn't see a controller in a hotkey.
    const sent = [];
    const pollPads = (now) => {
      const all = navigator.getGamepads ? [...navigator.getGamepads()] : [];
      const engineReads = !!S.info?.nativeControllers;
      const mine = all.filter((g) => g && g.connected && !(engineReads && ENGINE_PAD.test(g.id)));
      const map = S.labels ? PAD_LABELS : PAD_POSITION;
      const ports = new Map();
      mine.forEach((g, i) => {
        const port = Math.min(S.nativeCount + i, 7);
        const P = (S.pads[g.index] ??= { prev: 0, used: false, combo: false, hkLt: false, hkRt: false, rawLt: false, rawRt: false });
        let bits = 0;
        g.buttons.forEach((btn, k) => { if (btn.pressed && k < 17) bits |= 1 << k; });
        const pressed = bits & ~P.prev;
        const guide = !!(bits & (1 << 16)), back = !!(bits & (1 << 8));
        const lt = !!(bits & (1 << 6)), rt = !!(bits & (1 << 7));
        if (guide && pressed & (1 << 16)) P.used = false;
        if (guide || back) {
          const fire = (fn) => { fn(); P.used = true; if (!guide) P.combo = true; };
          if (pressed & (1 << 5)) fire(() => hotkey("save"));
          if (pressed & (1 << 4)) fire(() => hotkey("load"));
          if (pressed & (1 << 9)) fire(() => hotkey("menu"));
          if (rt && !P.rawRt && !P.hkRt) fire(() => { P.hkRt = true; setFf(true); });
          if (lt && !P.rawLt && !P.hkLt) fire(() => { P.hkLt = true; setRw(true); });
        }
        if (P.hkRt && (!rt || !(guide || back))) { P.hkRt = false; setFf(false); }
        if (P.hkLt && (!lt || !(guide || back))) { P.hkLt = false; setRw(false); }
        if ((P.prev & (1 << 16)) && !guide && !P.used) hotkey("menu");
        if (!back) P.combo = false;
        P.prev = bits; P.rawLt = lt; P.rawRt = rt;
        const hidden = guide || P.combo;
        let b = 0;
        const a = [0, 0, 0, 0], tr = [0, 0];
        if (!hidden) {
          for (let k = 0; k < 16; k++) if (bits & (1 << k)) b |= 1 << map[k];
          for (let k = 0; k < 4; k++) { const v = g.axes[k] ?? 0; a[k] = Math.abs(v) < 0.12 ? 0 : Math.round(v * 32767); }
          tr[0] = Math.round((g.buttons[6]?.value ?? 0) * 32767);
          tr[1] = Math.round((g.buttons[7]?.value ?? 0) * 32767);
        }
        ports.set(port, { b, a, tr });
        // Rumble the game asked for, renewed while it lasts.
        const r = S.rumble[port];
        if (r && g.vibrationActuator) {
          if (r.strong + r.weak > 0 && now - r.at > 120) {
            r.at = now;
            g.vibrationActuator.playEffect("dual-rumble", { duration: 160, strongMagnitude: Math.min(1, r.strong), weakMagnitude: Math.min(1, r.weak) }).catch(() => {});
          } else if (r.strong + r.weak === 0 && r.at) { r.at = 0; g.vibrationActuator.reset?.().catch?.(() => {}); }
        }
      });
      for (let port = 0; port < 8; port++) {
        const p = ports.get(port) ?? { b: 0, a: [0, 0, 0, 0], tr: [0, 0] };
        let b = p.b;
        if (port === 0) b |= S.keys;
        if (S.menuOpen) b = 0;
        const key = `${b}|${p.a}|${p.tr}`;
        if (sent[port] !== key) { sent[port] = key; send({ t: "in", p: port, b, a: p.a, g: p.tr }); }
      }
    };
    const onConnect = (e) => { if (!(S.info?.nativeControllers && ENGINE_PAD.test(e.gamepad.id))) flash(`Controller connected: ${e.gamepad.id.split("(")[0].trim().slice(0, 40)}`); };
    window.addEventListener("gamepadconnected", onConnect);

    // Keys belong to the game while it's open: caught first (capture) and kept
    // from the app underneath, whose library would otherwise start the focused
    // game on Enter. Browser keys (reload, full screen, dev tools) still work.
    const onKey = (down) => (e) => {
      if (/^F(5|11|12)$/.test(e.key)) return;
      if (S.listen != null) {
        // Choosing a key for a button (the Keyboard panel).
        e.preventDefault(); e.stopImmediatePropagation();
        if (!down) return;
        if (e.code !== "Escape") {
          const km = { ...S.keymap };
          for (const [c, id] of Object.entries(km)) if (c === e.code || id === S.listen) delete km[c];
          km[e.code] = S.listen;
          S.keymap = km;
          setKeymap(km);
          save("nx_engine_keys", JSON.stringify(km));
        }
        S.listen = null;
        setListening(null);
        return;
      }
      const inMenu = S.menuOpen && e.target instanceof Element && e.target.closest(".nxe-card");
      if (!inMenu) e.stopImmediatePropagation();
      if (e.code === "Escape" && down) { e.preventDefault(); setMenu((m) => !m); return; }
      if (e.code === "Tab") { e.preventDefault(); setFf(down); return; }
      if (e.code === "Backquote") { e.preventDefault(); setRw(down); return; }
      if (down && !e.repeat && (e.code === "F2" || e.code === "F4")) { e.preventDefault(); hotkey(e.code === "F2" ? "save" : "load"); return; }
      const id = S.keymap[e.code];
      if (id === undefined || S.menuOpen) return;
      e.preventDefault();
      S.keys = down ? S.keys | (1 << id) : S.keys & ~(1 << id);
    };
    const kd = onKey(true), ku = onKey(false);
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);
    window.__nxGameOpen = true;
    const blur = () => { S.keys = 0; setFf(false); setRw(false); };
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
      window.removeEventListener("gamepadconnected", onConnect);
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

  // The menu pauses the game and shows the save slots as they are now.
  useEffect(() => {
    st.current.menuOpen = menu;
    send({ t: menu ? "pause" : "resume" });
    if (menu) send({ t: "slots" });
    else { setKeysPanel(false); st.current.listen = null; setListening(null); }
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
  const chooseLook = (k) => { setLook(k); save(`nx_engine_look_${plat}`, k); };
  const chooseSlot = (n) => { setSlot(n); save("nx_engine_slot", String(n)); send({ t: "slot", n }); };
  const chooseRunahead = (n) => { setRunahead(n); save(`nx_engine_runahead_${plat}`, String(n)); send({ t: "runahead", frames: n }); };
  const chooseRewind = (on) => { setRewindOn(on); save("nx_engine_rewind", on ? "1" : "0"); send({ t: "rewinding", enabled: on }); };
  const chooseFf = (x) => { setFfSpeed(x); save("nx_engine_ffspeed", String(x)); send({ t: "ffspeed", x }); };
  const chooseLabels = (on) => { setLabels(on); st.current.labels = on; save("nx_engine_layout", on ? "labels" : "position"); send({ t: "layout", labels: on }); };
  const listenFor = (id) => { st.current.listen = id; setListening(id); };
  const resetKeys = () => { const km = { ...DEFAULT_KEYS }; st.current.keymap = km; setKeymap(km); save("nx_engine_keys", JSON.stringify(km)); };
  const keysFor = (id) => Object.entries(keymap).filter(([, v]) => v === id).map(([c]) => keyName(c));
  const raMax = status?.runahead?.max ?? 0;
  const rw = status?.rewind;

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
      {rewinding && !menu && <div className="nxe-rw">◀◀ Rewinding</div>}
      {stats && status && !menu && (
        <div className="nxe-stats" style={{ position: "absolute", left: 12, bottom: 12, background: "rgba(0,0,0,.6)", padding: "6px 9px", borderRadius: 10 }}>
          <span>{status.fps} fps · {status.frameMs} ms/frame{status.runahead?.frames ? ` · run-ahead ${status.runahead.frames}` : ""}</span>
          <span>sound {status.audioFillMs} / {status.audioTargetMs} ms{status.dropped ? ` · ${status.dropped} skipped` : ""}</span>
          {rw?.on && <span>rewind {rw.seconds} s kept ({rw.megabytes} MB)</span>}
        </div>
      )}
      {soundBlocked && <button className="nxe-chip" onClick={() => setSoundBlocked(false)}>Click or press a key for sound</button>}
      {toast && <div className="nxe-toast">{toast}</div>}
      {menu && (
        <div className="nxe-menu" onClick={(e) => { if (e.target === e.currentTarget) setMenu(false); }}>
          {!keysPanel ? (
            <div className="nxe-card">
              <h3>{game.title}</h3>
              <p>{info?.core ?? "SaveState Engine"}{info?.gpu ? ` · ${info.gpu.replace(/\/PCIe\/SSE2/, "")}` : ""}</p>
              <button className="nxe-btn primary" onClick={() => setMenu(false)} autoFocus>Resume</button>
              <h4>Save slots</h4>
              <div className="nxe-slots" role="group" aria-label="Save slot">
                {[1, 2, 3, 4].map((n) => {
                  const s = slots?.find((x) => x.slot === n);
                  return (
                    <button key={n} className={`nxe-slot ${slot === n ? "on" : ""}`} onClick={() => chooseSlot(n)} aria-pressed={slot === n}>
                      <div style={s?.thumb ? { backgroundImage: `url(data:image/png;base64,${s.thumb})` } : undefined}>{s?.thumb ? "" : "Empty"}</div>
                      <span>Slot {n}</span>
                      <small>{s?.saved ? ago(s.saved) : "—"}</small>
                    </button>
                  );
                })}
              </div>
              <div className="nxe-grid">
                <button className="nxe-btn" disabled={status?.canSave === false} onClick={() => { send({ t: "save", slot }); setMenu(false); }}><Icon name="down" /> Save to slot {slot}</button>
                <button className="nxe-btn" disabled={status?.canSave === false || !slots?.find((x) => x.slot === slot)?.saved} onClick={() => { send({ t: "load", slot }); setMenu(false); }}><Icon name="refresh" /> Load slot {slot}</button>
                <button className="nxe-btn" onClick={() => { send({ t: "reset" }); setMenu(false); }}><Icon name="bolt" /> Restart</button>
                <button className="nxe-btn" onClick={fullscreen}><Icon name="ext" /> Full screen</button>
              </div>
              <h4>Look</h4>
              <div className="nxe-row" role="group" aria-label="Look">
                {LOOKS.map(([k, label]) => <button key={k} className={`nxe-btn ${look === k ? "on" : ""}`} onClick={() => chooseLook(k)}>{label}</button>)}
              </div>
              <h4>Play</h4>
              <div className="nxe-row" role="group" aria-label="Rewind">
                <button className={`nxe-btn ${rewindOn ? "on" : ""}`} disabled={rw && !rw.available} onClick={() => chooseRewind(!rewindOn)}>
                  ◀◀ Rewind {rw && !rw.available ? "(not for this game)" : rewindOn ? `on${rw?.seconds ? ` · ${Math.floor(rw.seconds)} s kept` : ""}` : "off"}
                </button>
              </div>
              <div className="nxe-row" role="group" aria-label="Run-ahead">
                {[0, 1, 2].map((n) => (
                  <button key={n} className={`nxe-btn ${runahead === n ? "on" : ""}`} disabled={n > 0 && n > raMax && status != null} onClick={() => chooseRunahead(n)}>
                    {n === 0 ? "Run-ahead off" : `${n} frame${n > 1 ? "s" : ""} ahead`}
                  </button>
                ))}
              </div>
              <div className="nxe-row" role="group" aria-label="Fast-forward speed">
                {[[2, "2×"], [4, "4×"], [0, "As fast as it goes"]].map(([x, label]) => <button key={x} className={`nxe-btn ${ffSpeed === x ? "on" : ""}`} onClick={() => chooseFf(x)}>Fast-forward {label}</button>)}
              </div>
              <p>Run-ahead removes frames of the game's own input lag (it shows what your button does a frame or two sooner); it's offered when this PC can afford it. Rewind keeps the last minutes of play in memory.</p>
              <h4>Controls</h4>
              <div className="nxe-row" role="group" aria-label="Button layout">
                <button className={`nxe-btn ${!labels ? "on" : ""}`} onClick={() => chooseLabels(false)}>Buttons by position</button>
                <button className={`nxe-btn ${labels ? "on" : ""}`} onClick={() => chooseLabels(true)}>Buttons by label</button>
              </div>
              <p>
                {status?.pads ? `${status.pads} controller${status.pads > 1 ? "s" : ""} read directly. ` : ""}
                Controllers: Guide or Back with RB save, LB load, Start menu, hold RT fast-forward, hold LT rewind. Keyboard: Esc menu, F2 save, F4 load, hold Tab fast-forward, hold ` rewind.
              </p>
              <div className="nxe-grid">
                <button className="nxe-btn" onClick={() => setKeysPanel(true)}><Icon name="key" /> Keyboard keys</button>
                <button className={`nxe-btn ${stats ? "on" : ""}`} onClick={() => { setStats(!stats); save("nx_engine_stats", stats ? "0" : "1"); }}><Icon name="chip" /> Stats</button>
              </div>
              <button className="nxe-btn" onClick={quit}><Icon name="x" /> Close game</button>
              {onUseRetroArch && <button className="nxe-btn" onClick={() => { save("nx_engine", "off"); quit(); setTimeout(onUseRetroArch, 300); }}>Open games in RetroArch instead</button>}
            </div>
          ) : (
            <div className="nxe-card">
              <h3>Keyboard keys</h3>
              <p>Choose a button, then press the key you want for it (Esc keeps the old one).</p>
              <div className="nxe-keys">
                {BUTTONS.map((name, id) => (
                  <button key={name} className={`nxe-key ${listening === id ? "wait" : ""}`} onClick={() => listenFor(id)}>
                    <span>{name}</span>
                    <kbd>{listening === id ? "press a key" : keysFor(id).join(" / ") || "none"}</kbd>
                  </button>
                ))}
              </div>
              <div className="nxe-grid">
                <button className="nxe-btn" onClick={resetKeys}><Icon name="refresh" /> Defaults</button>
                <button className="nxe-btn primary" onClick={() => { setKeysPanel(false); st.current.listen = null; setListening(null); }}>Done</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
