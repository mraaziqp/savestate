// What a signed-out visitor to the website sees: what this is, and one form
// to sign in or join.
//
// Before, a new visitor landed on "Choose how you want to use Nexus: HOST or
// CLIENT" with the whole app loading behind it and firing requests that all
// came back 401. On the web the answer is always "client", so that question
// is answered here and the visitor only has to sign in.
import React, { useState, useEffect } from "react";
import { useStyles, api, store, Icon, Note, money, PERIOD } from "./lib.jsx";
import { AuthForm } from "./AuthForm.jsx";

const POINTS = [
  { icon: "film", title: "Movies and shows", text: "Stream in the browser on any device. Pick up where you left off, with subtitles and adaptive quality." },
  { icon: "music", title: "Music, books and photos", text: "One library for everything you own, not five different apps." },
  { icon: "game", title: "Games, when you want them", text: "Bring your own game library and play with cloud saves, or join a friend's host." },
];

function inviteFromUrl() {
  try {
    const path = window.location.pathname.match(/^\/invite\/([a-zA-Z0-9_-]+)$/);
    return path ? { kind: "host", code: path[1] } : (new URLSearchParams(window.location.search).get("invite") ? { kind: "friend" } : null);
  } catch { return null; }
}

export function Welcome() {
  useStyles();
  const [resetToken, setResetToken] = useState(() => { try { return new URLSearchParams(window.location.search).get("reset") ?? ""; } catch { return ""; } });
  const [host, setHost] = useState(null);
  const [plans, setPlans] = useState(null);
  const [showPlans, setShowPlans] = useState(false);
  const invite = inviteFromUrl();

  useEffect(() => {
    let live = true;
    fetch("/api/host/info").then((r) => (r.ok ? r.json() : null)).then((h) => { if (live) setHost(h); }).catch(() => {});
    fetch("/api/plans").then((r) => (r.ok ? r.json() : null)).then((p) => { if (live) setPlans(p); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const dropResetParam = () => {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("reset");
      window.history.replaceState(null, "", u.toString());
    } catch { /* keep the URL */ }
    setResetToken("");
  };

  async function login(username, password) {
    const r = await api("/api/auth/login", { method: "POST", anon: true, body: { username, password } });
    store.set("nexus_token", r.token);
    // A browser is always a client of the host it is looking at.
    if (!store.get("nexus_setup_role")) store.set("nexus_setup_role", "client");
  }
  // Invite links stay in the address bar so the app can redeem them once it loads.
  const enter = () => { dropResetParam(); window.location.reload(); };

  const paid = (plans?.tiers ?? []).filter((t) => t.priceCents > 0);

  return (
    <div className="nxa nxa-welcome">
      <div className="nxa-welcome-in">
        <div>
          <div className="nxa-brand"><span><Icon name="game" size={20} /></span> SaveState</div>
          <h1>Your movies, music and games. One place, any screen.</h1>
          <p className="nxa-welcome-lede">
            A private media and games hub{host?.name ? <>, hosted by <b style={{ color: "#fff" }}>{host.name}</b></> : null}. Sign in to start watching, or create an account and ask the host for access.
          </p>
          <div className="nxa-points">
            {POINTS.map((p) => (
              <div className="nxa-point" key={p.title}>
                <span><Icon name={p.icon} size={18} /></span>
                <div><b>{p.title}</b><p>{p.text}</p></div>
              </div>
            ))}
          </div>
        </div>

        <div className="nxa-welcome-side">
          {invite && !resetToken && (
            <div style={{ marginBottom: 14 }}>
              <Note kind="ok">You've been invited. Sign in or create an account and the invite is applied automatically.</Note>
            </div>
          )}
          <AuthForm onLogin={login} onSuccess={enter} resetToken={resetToken}
            defaultMode={invite ? "register" : "login"} />
          {paid.length > 0 && (
            <div className="nxa-welcome-links">
              <button type="button" className="nxa-link" onClick={() => setShowPlans((s) => !s)}>{showPlans ? "Hide plans" : "See plans and pricing"}</button>
            </div>
          )}
          {showPlans && (
            <div className="nxa-card" style={{ marginTop: 14 }}>
              <ul className="nxa-list">
                {(plans?.tiers ?? []).map((t) => (
                  <li key={t.id}>
                    <Icon name="check" />
                    <span><b>{t.name}</b> <span className="nxa-dim">{t.priceCents > 0 ? `${money(t.priceCents, t.currency)}${PERIOD[t.period] ?? ""}` : "Free"}</span>
                      {t.tagline && <span className="nxa-dim"> · {t.tagline}</span>}</span>
                  </li>
                ))}
              </ul>
              <p className="nxa-sub" style={{ marginTop: 10 }}>You can start free and upgrade from the Plans page once you're signed in.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
