// Runs before the app (a <script type="module"> in index.html), without React.
//
//  - Mirrors the sign-in token into a session cookie, so <img>, <audio> and
//    <video> requests (which cannot carry an Authorization header) are still
//    signed in. Music streams need this.
//  - Swaps a token past its first week for a fresh one, so someone who uses
//    the app is never signed out mid-use.
//  - Turns two refusals the app itself does not understand into something a
//    person can act on: 402 "that is on another plan" becomes a notice with a
//    link to Plans, and 401 "your password was changed" signs this device out.
import "./devices.js";
import "./savesync.js";

(() => {
  if (window.__nexusBoot) return;
  window.__nexusBoot = true;

  const KEY = "nexus_token";
  const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
  const sameOrigin = /^https?:$/.test(location.protocol);

  // ── Admin-only controls ─────────────────────────────────────────────────
  // Parts of the compiled app that only an admin can use are tagged
  // .nx-admin-only (see build.mjs) and hidden for everyone else. This is
  // tidiness, not security: the server refuses those calls regardless.
  const ADMIN_FLAG = "nexus_is_admin";
  const style = document.createElement("style");
  style.textContent = 'html:not([data-nx-admin="1"]) .nx-admin-only{display:none!important}'
    // Playing in the browser on a touch screen (EmulatorJS): the player
    // filled the screen minus a 16 px border and its game area didn't shrink,
    // so in landscape Start/Select sat below the screen edge, and the
    // on-screen buttons were 50 px (L/R 50x31). The player now fills the
    // screen and the pad is scaled up, layout kept, so nothing overlaps.
    + '@media (pointer:coarse),(max-width:767px){'
    + '.fixed.z-\\[200\\]:has(#ejs-game-container){inset:0!important;border-radius:0!important}'
    + '.fixed.z-\\[200\\]:has(#ejs-game-container)>.flex-1{min-height:0!important}'
    + '#ejs-game-container,#ejs-game-container .ejs_parent{height:100%!important;max-height:100%!important}'
    + '.ejs_virtualGamepad_left{transform:scale(1.35);transform-origin:left bottom}'
    + '.ejs_virtualGamepad_right{transform:scale(1.35);transform-origin:right bottom}'
    + '.ejs_virtualGamepad_bottom{transform:scale(1.25);transform-origin:center bottom}'
    + '.ejs_virtualGamepad_button{font-weight:800!important}'
    + '}'
    // Films' delete buttons were a faint icon that only lit up on hover:
    // touch screens have no hover, so they were all but invisible there.
    + '@media (hover:none){button[title="Delete"],button[title="Delete series"]{opacity:1!important;padding:8px!important}}'
    // Short landscape screens: a slimmer header, so the game gets the height.
    + '@media (pointer:coarse) and (max-height:500px),(max-height:500px) and (max-width:950px){'
    + '.fixed.z-\\[200\\]:has(#ejs-game-container)>:first-child:not(.flex-1){padding-top:2px!important;padding-bottom:2px!important;min-height:0!important}'
    + '.ejs_virtualGamepad_left{transform:scale(1.25)}.ejs_virtualGamepad_right{transform:scale(1.25)}.ejs_virtualGamepad_bottom{transform:scale(1.15)}'
    // Scaled from the bottom, L and R rose under the header: bring them down.
    + '.ejs_virtualGamepad_button.b_l,.ejs_virtualGamepad_button.b_r,.ejs_virtualGamepad_button.b_l2,.ejs_virtualGamepad_button.b_r2{margin-top:30px}'
    + '}'
    // Game details on phones and short landscape screens: one scrolling column (build.mjs 3f).
    + '@media (max-width:767px),(max-height:560px){'
    + '.nx-detail-wrap{padding:6px!important;align-items:stretch!important}'
    + '.nx-detail{max-height:none!important;height:auto!important;max-width:none!important;flex-direction:column!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}'
    + '.nx-detail-side{width:100%!important;padding:16px!important;overflow:visible!important;flex:none!important}'
    + '.nx-detail-side img{max-height:38vh;width:auto;max-width:100%;margin:0 auto;object-fit:contain}'
    + '.nx-detail-main{padding:16px!important;overflow:visible!important;flex:none!important}'
    + '.nx-detail-main .overflow-y-auto{overflow:visible!important}'
    + '.nx-detail-title{font-size:26px!important;line-height:1.15!important}'
    + '}'
    // Phones: flex items in the content area may shrink below their content
    // (long BIOS paths, status lines pushed pages 20-130px wider than the
    // screen), and words too long for the line break instead of overflowing.
    + 'main{overflow-wrap:break-word}main .flex-1{min-width:0}'
    // A grid with no columns set sizes its one column to the widest content
    // (Remote Bridge: 430px on a 390px phone); let it shrink to the screen.
    + '@media (max-width:639px){main .grid:not([class*=" grid-cols-"]):not([class^="grid-cols-"]){grid-template-columns:minmax(0,1fr)}}'
    // Big Picture: fills the screen (a parent's spacing gave it a bottom margin), and the selected game's cover large beside its title.
    + '.nx-bp{margin:0!important}'
    // Game details: the option that works on this device first; the cover leaves room for it.
    + '.nx-playopts{display:flex;flex-direction:column;gap:.5rem}.nx-playopts>*{margin:0!important}.nx-playopts>p{order:-2}.nx-playopts>.nx-first{order:-1;border-width:2px}'
    + '@media (min-width:768px) and (max-height:900px){.nx-detail-cover{max-height:40vh;width:auto!important;margin:0 auto 1rem!important;display:block}}'
    + '.nx-bp-cover{position:absolute;right:6vw;top:13vh;height:50vh;aspect-ratio:3/4;object-fit:cover;border-radius:18px;box-shadow:0 30px 90px rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.08);z-index:1;pointer-events:none;animation:nxbpIn .45s ease}'
    + '@keyframes nxbpIn{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}'
    + '@media (max-width:1100px),(max-height:620px){.nx-bp-cover{display:none}}'
    // eBooks: covers look like books (spine shading, page edges) and lift on hover.
    + '.nx-book{border-radius:4px 10px 10px 4px!important;transition:transform .25s ease,box-shadow .25s ease;box-shadow:0 10px 28px rgba(0,0,0,.55),0 2px 0 rgba(255,255,255,.04)!important}'
    + '.nx-book::before{content:"";position:absolute;inset:0 auto 0 0;width:9%;max-width:16px;z-index:3;pointer-events:none;background:linear-gradient(90deg,rgba(0,0,0,.55),rgba(255,255,255,.14) 45%,rgba(0,0,0,.25) 70%,transparent)}'
    + '.nx-book::after{content:"";position:absolute;inset:3% -1px 3% auto;width:4px;z-index:3;pointer-events:none;background:repeating-linear-gradient(180deg,rgba(255,255,255,.55) 0 1px,rgba(220,214,200,.35) 1px 2px);border-radius:0 3px 3px 0;opacity:.55}'
    + '.group:hover .nx-book,.nx-book:hover{transform:translateY(-6px) rotate(-.8deg);box-shadow:0 22px 44px rgba(0,0,0,.65),0 0 0 1px rgba(245,158,11,.25)!important}'
    + '@media (prefers-reduced-motion:reduce){.group:hover .nx-book,.nx-book:hover{transform:none}}'
    // Music away from its tab: the page collapses, its fixed bar stays (build.mjs).
    + '.nx-music-away{height:0;overflow:hidden}'
    // Phones: the music bar sits above the bottom navigation instead of over it.
    + '@media (max-width:1023px){.nx-music-bar{bottom:calc(60px + env(safe-area-inset-bottom,0px))!important}}'
    // Phones: the title had 22px because shuffle, repeat and like stayed; they
    // hide below 640px (the lock-screen controls remain). A slim seek bar.
    + '@media (max-width:639px){.nx-music-bar .flex-shrink-0>button:first-child,.nx-music-bar .flex-shrink-0>button:last-child,.nx-music-bar .flex-1.min-w-0>button{display:none!important}}'
    // Touch rules give inputs a 44px minimum height (kept, for fingers); the
    // track is drawn as a centred 4px line inside it.
    + '.nx-music-bar input[type=range]{-webkit-appearance:none;appearance:none;background:linear-gradient(rgba(255,255,255,.16),rgba(255,255,255,.16)) center/100% 4px no-repeat!important;border-radius:0}'
    + '.nx-music-bar input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#c084fc;border:0}'
    + '.nx-music-bar input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#c084fc;border:0}'
    + '.nx-controller-focus,button.nx-controller-focus,a.nx-controller-focus,[role="button"].nx-controller-focus,[data-gameid].nx-controller-focus{outline:3px solid #22d3ee!important;outline-offset:3px!important;box-shadow:0 0 24px rgba(34,211,238,.75),inset 0 0 10px rgba(34,211,238,.3)!important;transform:scale(1.03)!important;transition:outline .12s ease,box-shadow .12s ease,transform .15s ease!important;scroll-margin:72px 24px}'
    + '.nx-controller-pressed{transform:scale(.97)!important;filter:brightness(1.25)!important}';
  document.head.appendChild(style);
  const showAdmin = (yes) => {
    if (yes) document.documentElement.dataset.nxAdmin = "1"; else delete document.documentElement.dataset.nxAdmin;
    try { if (yes) localStorage.setItem(ADMIN_FLAG, "1"); else localStorage.removeItem(ADMIN_FLAG); } catch { /* private mode */ }
  };
  // Last known answer first, so an admin's controls do not blink in.
  try { if (read() && localStorage.getItem(ADMIN_FLAG) === "1") document.documentElement.dataset.nxAdmin = "1"; } catch { /* private mode */ }
  async function checkAdmin() {
    const t = read();
    if (!t) return showAdmin(false);
    try {
      const r = await fetch("/api/plans/me", { headers: { Authorization: `Bearer ${t}` } });
      if (r.ok) {
        const me = await r.json();
        showAdmin(!!me.isAdmin);
        // What this plan includes, for screens that check before they start
        // something (Big Picture won't download a PS2 game a plan can't play).
        window.__nxPlanFeatures = me.features ?? null;
        try { localStorage.setItem("nx_plan_features", JSON.stringify(me.features ?? {})); } catch { /* private mode */ }
      }
      else if (r.status === 401) showAdmin(false);
    } catch { /* offline: keep the last answer */ }
  }

  try { window.__nxPlanFeatures = JSON.parse(localStorage.getItem("nx_plan_features") || "null"); } catch { /* private mode */ }

  // ── Household profiles ──────────────────────────────────────────────────
  // Inside a profile the menu offers only the tabs it may open (the shell
  // reads window.__nxAllow; the server refuses the rest regardless).
  const profileId = () => { try { return JSON.parse(atob(read().split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).profileId ?? null; } catch { return null; } };
  try {
    const tabs = JSON.parse(localStorage.getItem("nexus_profile_tabs") || "null");
    if (profileId() && Array.isArray(tabs)) window.__nxAllow = new Set(tabs);
    else localStorage.removeItem("nexus_profile_tabs");
  } catch { /* private mode */ }
  // A shared profile link (?profile=...) signs this device in as that profile.
  (async () => {
    const q = new URLSearchParams(location.search);
    const link = q.get("profile");
    if (!link) return;
    q.delete("profile");
    const clean = location.pathname + (q.toString() ? "?" + q : "") + location.hash;
    try {
      const r = await fetch("/api/household/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: link }) });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.token) {
        localStorage.setItem(KEY, body.token);
        localStorage.removeItem("nexus_profile_tabs");
        try { await caches.delete("nexus-api"); } catch { /* no Cache API */ }
        location.replace(clean);
        return;
      }
      history.replaceState(null, "", clean);
      alert(body.error || "This profile link isn't valid any more.");
    } catch { history.replaceState(null, "", clean); }
  })();

  // ── Harmless device refusals ────────────────────────────────────────────
  // Phones and TVs that cannot lock screen rotation or keep the screen awake
  // reject those calls; the player carries on fine without them, but each one
  // surfaced as an unhandled error (100+ reports a month). Registered before
  // the app's own reporter, so these stop here.
  const BENIGN = /screen\.orientation\.lock|orientation\.lock\(\)|WakeLock|Wake Lock|exitFullscreen.*Document not active|ResizeObserver loop|The play\(\) request was interrupted/i;
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (BENIGN.test(String(r?.message ?? r ?? ""))) { e.preventDefault(); e.stopImmediatePropagation(); }
  });
  window.addEventListener("error", (e) => {
    if (BENIGN.test(String(e.message ?? ""))) { e.preventDefault(); e.stopImmediatePropagation(); }
  });

  // ── Session cookie ──────────────────────────────────────────────────────
  let mirrored = null;
  let lastSeen;
  async function mirror() {
    const t = read();
    if (t !== lastSeen) {
      // A different account (or none) on this browser: what the service
      // worker cached for the previous one (the games list) must not be
      // shown to this one, and admin controls follow the new account.
      if (lastSeen !== undefined) { try { await caches.delete("nexus-api"); } catch { /* no Cache API */ } }
      lastSeen = t;
      checkAdmin();
    }
    if (!sameOrigin) return;
    if (t === mirrored) return;
    mirrored = t;
    try {
      await fetch(t ? "/api/auth/session" : "/api/auth/logout", { method: "POST", headers: t ? { Authorization: `Bearer ${t}` } : {} });
    } catch { mirrored = null; }
  }

  // ── Sliding session ─────────────────────────────────────────────────────
  async function refresh() {
    const t = read();
    if (!t) return;
    try {
      const payload = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (!payload.userId || !payload.iat || Date.now() / 1000 - payload.iat < 7 * 86400) return;
      const r = await fetch("/api/auth/refresh", { method: "POST", headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) return;
      const next = (await r.json()).token;
      // Only if nobody signed out or switched account while this was in flight.
      if (next && read() === t) { localStorage.setItem(KEY, next); mirrored = next; }
    } catch { /* not a JWT, or offline */ }
  }

  // ── Notices ─────────────────────────────────────────────────────────────
  const shown = new Map();
  function notice(id, text, action) {
    if (Date.now() - (shown.get(id) ?? 0) < 120_000) return;
    // The tab itself already says so (see TabGate).
    if (document.querySelector(".nxa-gate-on")) return;
    shown.set(id, Date.now());
    const box = document.createElement("div");
    box.setAttribute("role", "status");
    box.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:6000;display:flex;align-items:center;gap:12px;" +
      "max-width:min(520px,calc(100vw - 24px));padding:12px 14px 12px 16px;border-radius:14px;background:#15172a;color:#f4f5fb;" +
      "border:1px solid rgba(251,191,36,.4);box-shadow:0 18px 50px rgba(0,0,0,.55);font:600 13px/1.4 system-ui,sans-serif";
    const span = document.createElement("span");
    span.textContent = text;
    span.style.flex = "1";
    box.appendChild(span);
    const button = (label, primary, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = `border:0;border-radius:9px;padding:8px 12px;font:700 12px system-ui,sans-serif;cursor:pointer;white-space:nowrap;` +
        (primary ? "background:linear-gradient(135deg,#22d3ee,#4d7cff);color:#03121a" : "background:rgba(255,255,255,.1);color:#f4f5fb");
      b.onclick = () => { box.remove(); fn?.(); };
      box.appendChild(b);
    };
    if (action) button(action.label, true, action.run);
    button("Dismiss", false);
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 12_000);
  }

  // Other parts of the app (the music player) show notices the same way.
  window.__nxNotice = (id, text) => notice(id, text);
  // Plain words for an HTTP status. Screens used to show "HTTP 403" or
  // "Server returned 500"; build.mjs swaps those for this.
  window.__nxHttpText = (s) => (s === 0 ? "Can't reach the server. Check your connection and try again."
    : s === 401 ? "Your sign-in has expired. Please sign in again."
    : s === 402 ? "That's part of a paid plan. See Plans & Pricing."
    : s === 403 ? "You don't have access to that yet. Ask the host, or check your plan."
    : s === 404 ? "That isn't available any more. Refresh the page and try again."
    : s === 409 ? "That changed while you were working. Refresh and try again."
    : s === 413 ? "That file is too big to send."
    : s === 429 ? "Too many tries in a row. Wait a moment and try again."
    : s >= 500 ? "The server had a problem. Please try again in a moment."
    : `That didn't work (code ${s}). Please try again.`);

  // ── The same list, asked for twice at once ──────────────────────────────
  // Opening Games asked the server for the game list five times (the hub,
  // the grid, Play Offline...), on a phone's connection too. Identical GETs
  // of these lists that are in flight together, or within 3 s, now share one
  // answer. If the shared request is cancelled by the caller that started
  // it, the others ask again for themselves.
  const SHARED = /^\/api\/(games|media\/library|media\/progress|plans\/me|plans\/features)$/;
  const shared = new Map();
  const network = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : null;
      const method = String(init?.method ?? "GET").toUpperCase();
      if (href && method === "GET" && !init?.body) {
        const u = new URL(href, location.href);
        if (u.origin === location.origin && SHARED.test(u.pathname)) {
          const key = `${u.pathname}${u.search}|${new Headers(init?.headers ?? {}).get("authorization") ?? ""}`;
          const hit = shared.get(key);
          if (hit && Date.now() - hit.at < 3000) return hit.p.then((r) => r.clone(), (e) => (init?.signal?.aborted ? Promise.reject(e) : network(input, init)));
          const p = network(input, init);
          shared.set(key, { at: Date.now(), p });
          p.then((r) => { if (!r.ok) shared.delete(key); }, () => shared.delete(key));
          setTimeout(() => { if (shared.get(key)?.p === p) shared.delete(key); }, 3000);
          return p.then((r) => r.clone());
        }
      }
    } catch { /* fall through to a plain request */ }
    return network(input, init);
  };

  // ── Small covers on phones ──────────────────────────────────────────────
  // Card covers were full size (60-75 KB each, 200+ on Games). On a phone
  // the cards ask for /api/art/<id>?w=360 (about 12 KB); the server makes it.
  const smallScreen = (() => { try { return matchMedia("(max-width: 767px)").matches; } catch { return false; } })();
  window.nxThumb = (src) => (smallScreen && typeof src === "string" && /\/api\/art\/[\w-]+$/.test(src) ? `${src}?w=360` : src);

  // ── Refusals ────────────────────────────────────────────────────────────
  // Wraps whatever fetch is current when the app starts calling it; the app's
  // own wrapper (which adds the token) is installed later and calls this one.
  const inner = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await inner(input, init);
    if (res.status !== 402 && res.status !== 401 && res.status !== 403 && res.status !== 409) return res;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url || !url.includes("/api/")) return res;
      const body = await res.clone().json().catch(() => null);
      if (res.status === 402 && body?.error === "upgrade_required") {
        window.dispatchEvent(new CustomEvent("nexus:entitlements-changed"));
        notice(`plan:${body.feature}`, body.message || "That isn't included in your plan.", {
          label: "See plans",
          run: () => window.dispatchEvent(new CustomEvent("nexus:navigate-tab", { detail: { tab: "plans" } })),
        });
      } else if (res.status === 409 && body?.code === "stream_limit") {
        screensTaken(body);
      } else if (res.status === 403 && body?.error === "time_up") {
        window.dispatchEvent(new CustomEvent("nexus:time-up", { detail: { timeUp: true, message: body.message } }));
      } else if (res.status === 401 && body?.code === "session_expired" && read()) {
        try { localStorage.removeItem(KEY); } catch { /* ignore */ }
        await mirror();
        location.reload();
      }
    } catch { /* never break the request over a notice */ }
    return res;
  };

  // ── Screens in use ──────────────────────────────────────────────────────
  // A film that won't start because the plan's screens are taken: the server
  // answers 409 stream_limit. The player asks through hls.js (XHR) or a plain
  // <video> (which only reports "error"), so both are watched here and the
  // app's "All your screens are in use" panel (ScreensInUse.jsx) opens.
  let screensAt = 0;
  function screensTaken(body) {
    if (Date.now() - screensAt < 4000) return;
    screensAt = Date.now();
    window.dispatchEvent(new CustomEvent("nexus:stream-limit", { detail: body ?? {} }));
  }
  const VIDEO = /\/api\/(media\/(stream|file|hls\/)|stream\/(gdrive|media)\/)/;
  try {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__nxUrl = String(url ?? ""); return open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      if (this.__nxUrl && VIDEO.test(this.__nxUrl)) {
        this.addEventListener("loadend", () => {
          // The NAS is still preparing this film (server/videoprep.ts): the
          // player's error panel shows why, not "stopped responding".
          if (this.status === 503) {
            try { const b = JSON.parse(this.responseText); if (b?.code === "preparing") window.__nxPrepMsg = b.error; } catch { /* not JSON */ }
            return;
          }
          if (this.status !== 409) return;
          let body = null;
          try { if (!this.responseType || this.responseType === "text") body = JSON.parse(this.responseText); } catch { /* binary */ }
          screensTaken(body);
        });
      }
      return send.apply(this, arguments);
    };
  } catch { /* no XHR */ }
  // A <video> that fails: ask whether this device was refused a screen.
  document.addEventListener("error", async (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !VIDEO.test(v.currentSrc || v.src || "")) return;
    const t = read();
    if (!t) return;
    try {
      const r = await fetch("/api/plans/streams", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) return;
      const s = await r.json();
      const others = (s.active ?? []).filter((x) => !x.thisDevice);
      if (s.limit != null && others.length >= s.limit && !(s.active ?? []).some((x) => x.thisDevice)) screensTaken({ limit: s.limit });
    } catch { /* offline */ }
  }, true);

  // ── Games kept for offline play & Storage Quota Allocation ───────────────
  // Unless the site's storage is marked persistent, the browser / WebView
  // allocates only a tiny best-effort temporary quota (often 1-2 GB). Requesting
  // persistence unlocks the device's full available storage pool (e.g. 20-30+ GB).
  const requestPersistence = async () => {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted?.())) {
        const granted = await navigator.storage.persist();
        if (granted) console.info("[storage] Storage persistence granted; full quota available.");
      }
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        const quotaMB = Math.round((est.quota || 0) / (1024 * 1024));
        const usageMB = Math.round((est.usage || 0) / (1024 * 1024));
        console.info(`[storage] Quota: ${quotaMB} MB, Used: ${usageMB} MB`);
      }
    } catch { /* storage API not supported */ }
  };
  // Asked when someone presses Play on a phone (PhonePlay), or once games are
  // kept in this browser: asking on every page load showed Firefox's storage
  // prompt to people who never keep a game.
  window.__nxRequestStoragePersistence = requestPersistence;
  setTimeout(async () => {
    try {
      if (!navigator.storage?.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      const roms = await root.getDirectoryHandle("nexus-roms").catch(() => null);
      if (!roms) return;
      for await (const _ of roms.keys()) { await requestPersistence(); break; }
    } catch { /* no OPFS */ }
  }, 15_000);

  // ── Games turn the phone sideways ───────────────────────────────────────
  // window.nxLandscape(true) when a game starts on a phone, (false) when it
  // ends. The Android app (NxAndroid 2+) turns the screen itself, even with
  // auto-rotate off. A browser can only lock the orientation in full screen,
  // so it goes full screen first (and leaves it again only if it went in).
  let nxLandscapeFs = false;
  window.nxLandscape = async (on) => {
    try {
      if (window.Capacitor?.isNativePlatform?.()) {
        await window.Capacitor.nativePromise("NxAndroid", "orientation", { mode: on ? "landscape" : "auto" });
        return;
      }
    } catch { /* an older app: do it the browser's way */ }
    try {
      if (on) {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen({ navigationUI: "hide" });
          nxLandscapeFs = true;
        }
        await screen.orientation?.lock?.("landscape");
      } else {
        screen.orientation?.unlock?.();
        if (nxLandscapeFs && document.fullscreenElement) await document.exitFullscreen();
        nxLandscapeFs = false;
      }
    } catch { /* not allowed here (no gesture, a desktop browser): leave it */ }
  };

  // ── Controller navigation ───────────────────────────────────────────────
  // The shell's gamepad loop hands every press here first (build.mjs,
  // "controller navigation hook"); false leaves it to the shell (LB/RB switch
  // tabs in menu order, Menu opens the sidebar).
  //
  // Rewritten 2026-10-27; the first version was "very messy" to use:
  //   - every press measured every element twice (getComputedStyle), slow
  //     with thousands of cards; now only the few in the right direction are
  //     checked, nearest first;
  //   - held directions scrolled smoothly, so the next press measured the page
  //     mid-scroll and skipped items; repeats now scroll at once;
  //   - inputs, selects, tabs and role="button" items couldn't be reached;
  //   - a card's own buttons were stops of their own; a card is one stop;
  //   - a list re-rendering lost the focus and it restarted at the top; it now
  //     carries on from the same spot on screen;
  //   - B jumped to the sidebar; it now goes back: closes the dialog or
  //     detail open, leaves a text box, and only then goes to the menu.
  const FOCUS_CLS = "nx-controller-focus";
  const PRESS_CLS = "nx-controller-pressed";
  const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="link"], [role="option"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"]), [data-gameid], [data-card], [data-gpnav="1"]';
  const CARD = "[data-gameid], [data-card], .nx-game-card";
  const MODALS = '.nxplay, .nx-playmode-modal, .nx-detail, [role="dialog"], [aria-modal="true"], .nx-modal';
  let lastFocused = null, lastPoint = null, lastMoveAt = 0;

  function clearFocus() {
    document.querySelectorAll("." + FOCUS_CLS).forEach((el) => el.classList.remove(FOCUS_CLS));
  }
  window.addEventListener("pointerdown", () => { clearFocus(); lastFocused = null; }, { passive: true });

  // The part of the page the controller works in: the newest dialog, else all of it.
  function scope() {
    const marked = document.querySelectorAll("[data-gpnav-scope]");
    if (marked.length) return marked[marked.length - 1];
    const open = Array.from(document.querySelectorAll(MODALS)).filter((m) => m.getBoundingClientRect().width > 0);
    return open[open.length - 1] || document.body;
  }
  const navShown = (el) => {
    if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.closest('[aria-hidden="true"], [inert]')) return false;
    try { return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true }) : true; } catch { return true; }
  };
  // Every stop with its box; sizes only (cheap), visibility is checked later
  // for the few that matter.
  function stops(root) {
    const out = [];
    for (const el of root.querySelectorAll(FOCUSABLE)) {
      // A card is one stop: its own buttons are reached through it.
      if (el.parentElement && el.parentElement.closest(CARD) && root.contains(el.parentElement.closest(CARD))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      out.push({ el, r });
    }
    return out;
  }
  function inDirection(r1, r2, dir) {
    const c1x = r1.left + r1.width / 2, c1y = r1.top + r1.height / 2;
    const c2x = r2.left + r2.width / 2, c2y = r2.top + r2.height / 2;
    if (dir === "right") return c2x > c1x + 4 && r2.left >= r1.left + 2;
    if (dir === "left") return c2x < c1x - 4 && r2.right <= r1.right - 2;
    if (dir === "down") return c2y > c1y + 4 && r2.top >= r1.top + 2;
    return c2y < c1y - 4 && r2.bottom <= r1.bottom - 2;
  }
  // Gap along the direction, plus twice the sideways gap (none when the two
  // share a row or column), plus a little for off-centre: the item straight
  // ahead wins, then the nearest in the same row or column.
  function score(r1, r2, dir) {
    const h = dir === "left" || dir === "right";
    const along = dir === "right" ? r2.left - r1.right : dir === "left" ? r1.left - r2.right : dir === "down" ? r2.top - r1.bottom : r1.top - r2.bottom;
    const side = h ? Math.max(0, Math.max(r1.top, r2.top) - Math.min(r1.bottom, r2.bottom)) : Math.max(0, Math.max(r1.left, r2.left) - Math.min(r1.right, r2.right));
    const off = h ? Math.abs((r1.top + r1.bottom) / 2 - (r2.top + r2.bottom) / 2) : Math.abs((r1.left + r1.right) / 2 - (r2.left + r2.right) / 2);
    return Math.max(0, along) + side * 2 + off * 0.15;
  }
  function nearest(fromRect, list, dir, skip) {
    const ranked = list.filter((s) => s.el !== skip && inDirection(fromRect, s.r, dir)).map((s) => ({ el: s.el, d: score(fromRect, s.r, dir) })).sort((a, b) => a.d - b.d);
    for (const c of ranked.slice(0, 40)) if (navShown(c.el)) return c.el;
    return null;
  }
  // Where to start: the item nearest the last spot (after a re-render), else
  // the first thing in the page's content, top left.
  function startPoint(list) {
    if (lastPoint) {
      let best = null, bd = Infinity;
      for (const s of list) {
        const d = Math.hypot(s.r.left + s.r.width / 2 - lastPoint.x, s.r.top + s.r.height / 2 - lastPoint.y);
        if (d < bd && navShown(s.el)) { bd = d; best = s.el; }
      }
      if (best && bd < 400) return best;
    }
    const content = list.filter((s) => !s.el.closest("aside, nav") && s.r.bottom > 0 && s.r.top < innerHeight);
    content.sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
    return (content.find((s) => navShown(s.el)) || list.find((s) => navShown(s.el)))?.el ?? null;
  }
  function focusEl(el, quick) {
    clearFocus();
    el.classList.add(FOCUS_CLS);
    try { el.focus({ preventScroll: true, focusVisible: true }); } catch { /* not focusable: the outline still shows */ }
    try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: quick ? "instant" : "smooth" }); } catch { /* old browser */ }
    lastFocused = el;
    const r = el.getBoundingClientRect();
    lastPoint = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function current(root) {
    const a = document.activeElement;
    if (a && a !== document.body && root.contains(a) && a.matches(FOCUSABLE)) return a;
    if (lastFocused && document.body.contains(lastFocused) && root.contains(lastFocused)) return lastFocused;
    return null;
  }
  const typing = (el) => !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(button|submit|checkbox|radio|range|color|file|reset|image)$/i.test(el.type || "")));
  function press(el) {
    // A card: its own play/open control, else the card.
    const target = el.matches(CARD) && !el.matches('button, a, [role="button"]') ? (el.querySelector('button, a[href], [role="button"]') || el.firstElementChild || el) : el;
    el.classList.add(PRESS_CLS);
    setTimeout(() => el.classList.remove(PRESS_CLS), 150);
    if (typing(el) || el.tagName === "SELECT") { try { el.focus(); } catch { /* ignore */ } if (el.tagName === "SELECT") { try { el.showPicker?.(); } catch { /* needs a gesture */ } } return; }
    target.click();
  }
  function back(root, ctx, curr) {
    if (typing(document.activeElement)) { const el = document.activeElement; el.blur(); focusEl(el, true); return true; }
    if (ctx?.te) { ctx.ce(null); return true; }
    if (root !== document.body) {
      const close = root.querySelector('[aria-label="Close" i], [aria-label^="Close" i], [data-close], .nxplay-close, [aria-label="Back" i]');
      if (close && navShown(close)) { close.click(); return true; }
      window.dispatchEvent(new CustomEvent("nexus:play-close"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      return true;
    }
    if (curr && !curr.closest("aside, nav")) {
      const side = document.querySelector('aside [aria-current="page"], aside [data-active="true"], nav [aria-current="page"]') || document.querySelector("aside button, nav button");
      if (side && navShown(side)) { focusEl(side, false); return true; }
    }
    return false;
  }

  window.__nxGamepadNav = function (action, ctx) {
    // A game has the controller.
    if (document.getElementById("ejs-game-container") || window.__nxGameOpen) return true;
    // Tabs and the menu: the shell knows their order.
    if (action === "lb" || action === "rb") {
      if (document.querySelector("[data-gpnav-scope]")) return true;
      lastFocused = null; lastPoint = null; clearFocus();
      setTimeout(() => { const list = stops(scope()); const first = startPoint(list); if (first) focusEl(first, true); }, 400);
      return false;
    }
    if (action === "menu") return false;

    const root = scope();
    let curr = current(root);
    if (action === "cancel") return back(root, ctx, curr);

    const list = stops(root);
    if (!list.length) return false;
    if (!curr) {
      // Nothing chosen yet (or it went away in a re-render): start here, and
      // for a direction carry on from it.
      curr = startPoint(list);
      if (!curr) return false;
      focusEl(curr, true);
      if (action === "confirm") return true;
    }
    if (action === "confirm") { press(curr); return true; }

    if (action === "up" || action === "down" || action === "left" || action === "right") {
      // In a text box, left and right move the cursor until it reaches an end.
      if (typing(curr) && (action === "left" || action === "right")) {
        try {
          const atStart = curr.selectionStart === 0 && curr.selectionEnd === 0;
          const atEnd = curr.selectionStart === curr.value.length;
          if ((action === "left" && !atStart) || (action === "right" && !atEnd)) return true;
        } catch { /* number inputs have no cursor */ }
      }
      const now = Date.now();
      const quick = now - lastMoveAt < 320; // a held direction
      lastMoveAt = now;
      const best = nearest(curr.getBoundingClientRect(), list, action, curr);
      if (best) { focusEl(best, quick); return true; }
      // The end of a list that loads more as it scrolls: scroll a little.
      if (action === "down" || action === "up") {
        const box = curr.closest("main") || document.scrollingElement;
        try { (box.scrollHeight > box.clientHeight ? box : document.scrollingElement).scrollBy({ top: action === "down" ? 240 : -240, behavior: "instant" }); } catch { /* ignore */ }
      }
      return true;
    }
    return false;
  };

  mirror();
  refresh();
  // Sign-in and sign-out happen inside the app (same tab), which fires no
  // storage event, so the token is compared on a slow timer as well.
  window.addEventListener("storage", (e) => { if (e.key === KEY) mirror(); });
  setInterval(mirror, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { mirror(); refresh(); } });
})();
