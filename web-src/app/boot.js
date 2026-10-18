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
    + '.nx-music-bar input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#c084fc;border:0}';
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

  // ── Games kept for offline play ─────────────────────────────────────────
  // Big Picture keeps downloaded games in this browser's private storage
  // (OPFS "nexus-roms"). Unless the site's storage is marked persistent the
  // browser may delete it when the disk runs low, and a game that played
  // offline yesterday would download again. Asked only once games are kept,
  // so nobody is asked for storage they don't use.
  setTimeout(async () => {
    try {
      if (!navigator.storage?.persist || !navigator.storage.getDirectory || await navigator.storage.persisted()) return;
      const root = await navigator.storage.getDirectory();
      const roms = await root.getDirectoryHandle("nexus-roms").catch(() => null);
      if (!roms) return;
      for await (const _ of roms.keys()) { await navigator.storage.persist(); break; }
    } catch { /* no OPFS */ }
  }, 15_000);

  mirror();
  refresh();
  // Sign-in and sign-out happen inside the app (same tab), which fires no
  // storage event, so the token is compared on a slow timer as well.
  window.addEventListener("storage", (e) => { if (e.key === KEY) mirror(); });
  setInterval(mirror, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { mirror(); refresh(); } });
})();
