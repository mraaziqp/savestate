// Shared pieces for the screens in this module: styles, API access, icons.
import React, { useEffect } from "react";
import { CSS } from "./styles.js";

export function injectStyles() {
  if (typeof document === "undefined" || document.getElementById("nxa-css")) return;
  const s = document.createElement("style");
  s.id = "nxa-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
export function useStyles() { useEffect(injectStyles, []); }

export const token = () => { try { return localStorage.getItem("nexus_token") ?? ""; } catch { return ""; } };
export const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

/** JSON request. Throws an Error carrying the server's message, plus .status, .field and .data. */
export async function api(url, opts = {}) {
  // Signing in never sends the previous session's token along.
  const t = opts.anon ? "" : token();
  let r;
  try {
    r = await fetch(url, {
      ...opts,
      body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(opts.headers ?? {}) },
    });
  } catch {
    throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 });
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const fallback = r.status === 429 ? "Too many attempts. Wait a few minutes and try again."
      : r.status >= 500 ? "The server had a problem. Please try again."
      : `Request failed (${r.status})`;
    throw Object.assign(new Error(data?.message ?? data?.error ?? fallback), { status: r.status, field: data?.field, data });
  }
  return data;
}

export const goTab = (tab) => window.dispatchEvent(new CustomEvent("nexus:navigate-tab", { detail: { tab } }));

// ── Icons (inline so this module carries no icon dependency) ─────────────
const P = {
  check: "M5 12.5l4.5 4.5L19 7",
  x: "M6 6l12 12M18 6L6 18",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.3 4.2M6.3 6.3A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.2-.9M9.9 9.9a3 3 0 0 0 4.2 4.2",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
  alert: "M12 9v4M12 17h.01M10.3 3.9L2.5 17.5A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  spinner: "M12 3a9 9 0 1 0 9 9",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  game: "M6 12h4M8 10v4M15 13h.01M18 11h.01M7 6h10a5 5 0 0 1 5 5v2a5 5 0 0 1-9 3h-2a5 5 0 0 1-9-3v-2a5 5 0 0 1 5-5z",
  cloud: "M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.6a4.2 4.2 0 0 1-.5 8.4z",
  users: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.500V20M10 11a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7zM20 20v-1.500a3.500 3.500 0 0 0-2.500-3.300M15.500 4.200a3.500 3.500 0 0 1 0 6.600",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  star: "M12 3.5l2.600 5.600 6.100.700-4.500 4.200 1.200 6-5.400-3.100-5.400 3.100 1.200-6L3.300 9.800l6.100-.700z",
  key: "M15 7a4 4 0 1 1-3.900 5H8v3H5v3H2v-3l7.100-7.100A4 4 0 0 1 15 7z",
  link: "M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1",
  copy: "M9 9h10v11H9zM5 15V4h10",
  down: "M12 4v12M6 11l6 6 6-6M5 20h14",
  ext: "M14 5h5v5M19 5l-8 8M11 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5",
  shield: "M12 3l8 3v6c0 5-3.400 8.400-8 9.500C7.400 20.400 4 17 4 12V6z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  chip: "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  folder: "M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  refresh: "M4 12a8 8 0 0 1 13.700-5.700L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.700 5.700L4 16M4 20v-4h4",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0",
  arrow: "M5 12h14M13 6l6 6-6 6",
};
export function Icon({ name, size = 16, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" className={name === "spinner" ? `nxa-spin ${className ?? ""}` : className}>
      <path d={P[name] ?? P.info} />
    </svg>
  );
}

export function Note({ kind = "info", children }) {
  return (
    <div className={`nxa-note ${kind === "info" ? "" : kind}`} role={kind === "bad" ? "alert" : "status"}>
      <Icon name={kind === "ok" ? "check" : kind === "info" ? "info" : "alert"} />
      <div>{children}</div>
    </div>
  );
}

export const money = (cents, currency = "ZAR") => {
  const n = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
  } catch { return `${currency} ${n.toFixed(2)}`; }
};
export const PERIOD = { free: "", month: "/month", year: "/year", once: " once-off" };

export const when = (d) => {
  if (!d) return "never";
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return "never";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
