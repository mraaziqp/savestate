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
  style.textContent = 'html:not([data-nx-admin="1"]) .nx-admin-only{display:none!important}';
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
      if (r.ok) showAdmin(!!(await r.json()).isAdmin);
      else if (r.status === 401) showAdmin(false);
    } catch { /* offline: keep the last answer */ }
  }

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

  // ── Refusals ────────────────────────────────────────────────────────────
  // Wraps whatever fetch is current when the app starts calling it; the app's
  // own wrapper (which adds the token) is installed later and calls this one.
  const inner = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await inner(input, init);
    if (res.status !== 402 && res.status !== 401) return res;
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
      } else if (res.status === 401 && body?.code === "session_expired" && read()) {
        try { localStorage.removeItem(KEY); } catch { /* ignore */ }
        await mirror();
        location.reload();
      }
    } catch { /* never break the request over a notice */ }
    return res;
  };

  mirror();
  refresh();
  // Sign-in and sign-out happen inside the app (same tab), which fires no
  // storage event, so the token is compared on a slow timer as well.
  window.addEventListener("storage", (e) => { if (e.key === KEY) mirror(); });
  setInterval(mirror, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { mirror(); refresh(); } });
})();
