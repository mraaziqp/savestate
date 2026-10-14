// Sits at the top of the app's content area and steps in when the open tab is
// not available to this member:
//   - its feature belongs to a tier they are not on  -> an upgrade screen;
//   - it shows the host's own media and they have no invite -> a "request
//     access" screen (the tab's own content used to show admin controls and a
//     half-empty library here);
//   - it is the games library and the host's games are private -> a short
//     pointer to the setup guide, above the tab (their own games still work).
// When it shows a full screen it hides the tab's content (.nxa-gate-on in
// styles.js) instead of unmounting it, so the shell needs no other change.
import React, { useState, useEffect, useCallback } from "react";
import { useStyles, api, token, Icon, Note, goTab } from "./lib.jsx";

const MEDIA_TABS = new Set(["media", "music", "codex", "torrent", "party", "playlists", "gallery", "photos", "matchmaker"]);
const GAMES_TABS = new Set(["library", "consoles"]);
const PROFILE_TABS = { media: "Movies & TV", music: "Music", codex: "Books", library: "Games", gallery: "Photos", party: "Watch Party", household: "Profiles" };
const TAB_NAMES = { media: "Movies & TV", music: "Music", codex: "eBooks", torrent: "Downloads", party: "Watch Party", playlists: "Playlists",
  gallery: "Photos", photos: "Photo Booklet", matchmaker: "What to Watch" };

// One copy of "what can I use" for every mounted gate, refreshed when the
// window regains focus (an admin may have just changed it) or a request is refused.
let current = null;
let loading = null;
let loadedAt = 0;
const subscribers = new Set();
function loadEntitlements(force = false) {
  if (!token()) { current = null; return Promise.resolve(null); }
  if (loading) return loading;
  if (!force && current && Date.now() - loadedAt < 60_000) return Promise.resolve(current);
  loading = api("/api/plans/me")
    .then((me) => { current = me; loadedAt = Date.now(); subscribers.forEach((fn) => fn(me)); return me; })
    .catch(() => current)
    .finally(() => { loading = null; });
  return loading;
}
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => { if (subscribers.size) loadEntitlements(); });
  window.addEventListener("nexus:entitlements-changed", () => { if (subscribers.size) loadEntitlements(true); });
}
function useEntitlements() {
  const [me, setMe] = useState(current);
  useEffect(() => {
    subscribers.add(setMe);
    loadEntitlements();
    return () => { subscribers.delete(setMe); };
  }, []);
  return me;
}

function RequestAccess({ tab }) {
  const [state, setState] = useState({ status: "loading", host: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");

  async function redeem(e) {
    e.preventDefault();
    // Accepts the code or the whole invite link.
    const c = code.trim().replace(/^.*\/invite\//, "").replace(/[?#].*$/, "");
    if (!c) return;
    setBusy(true); setError("");
    try {
      await api(`/api/invite/${encodeURIComponent(c)}/redeem`, { method: "POST", body: {} });
      window.location.reload();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const load = useCallback(async () => {
    try {
      const host = await fetch("/api/host/public-profile").then((r) => (r.ok ? r.json() : null));
      if (!host?.id) return setState({ status: "closed", host: null });
      const mine = await api("/api/hosts/my-requests").catch(() => []);
      const req = Array.isArray(mine) ? mine.find((r) => r.host_id === host.id) : null;
      setState({ status: req?.status ?? (host.allow_requests ? "none" : "closed"), host });
    } catch { setState({ status: "closed", host: null }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function ask() {
    setBusy(true); setError("");
    try {
      const r = await api(`/api/hosts/${state.host.id}/request-access`, { method: "POST", body: {} });
      setState((s) => ({ ...s, status: r.status ?? "pending" }));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const hostName = state.host?.name || state.host?.host_display_name || "the host";
  return (
    <div className="nxa nxa-locked nxa-gate-on">
      <span><Icon name="lock" size={28} /></span>
      <h2>{TAB_NAMES[tab] ?? "This library"} is by invitation</h2>
      <p className="nxa-dim">This is {hostName}'s own library. It is shared with people the host has invited, so it is not part of any plan.</p>
      {state.status === "loading" && <p className="nxa-dim"><Icon name="spinner" /> Checking your access…</p>}
      {state.status === "none" && <button className="nxa-btn primary" disabled={busy} onClick={ask}>{busy ? <Icon name="spinner" /> : <Icon name="mail" />} Ask {hostName} for access</button>}
      {state.status === "pending" && <Note kind="ok">Your request is with {hostName}. This page unlocks as soon as it is approved.</Note>}
      {state.status === "denied" && <Note kind="warn">{hostName} declined your request. If you think that was a mistake, contact them directly.</Note>}
      {state.status === "approved" && <Note kind="ok">You're approved. <button className="nxa-link" onClick={() => window.location.reload()}>Reload to open the library</button></Note>}
      {state.status !== "loading" && state.status !== "approved" && (
        <form className="nxa-row" onSubmit={redeem} style={{ width: "100%", maxWidth: 360 }}>
          <input className="nxa-input sm nxa-grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Have an invite code? Paste it here" aria-label="Invite code" autoCapitalize="none" spellCheck={false} />
          <button type="submit" className="nxa-btn sm" disabled={busy || !code.trim()}>Redeem</button>
        </form>
      )}
      {error && <Note kind="bad">{error}</Note>}
      <div className="nxa-row nxa-wrap" style={{ justifyContent: "center" }}>
        <button className="nxa-btn" onClick={() => goTab("discover")}>Browse Discover</button>
        <button className="nxa-btn" onClick={() => goTab("myfiles")}>Your own files</button>
      </div>
    </div>
  );
}

export function TabGate({ tab }) {
  useStyles();
  const me = useEntitlements();
  if (!me || me.isAdmin) return null;

  // Inside a household profile: only the tabs the account holder allowed.
  if (me.profile && !me.profile.tabs.includes(tab)) {
    const open = me.profile.tabs.filter((t) => PROFILE_TABS[t]);
    return (
      <div className="nxa nxa-locked nxa-gate-on">
        <span><Icon name="lock" size={28} /></span>
        <h2>Not on {me.profile.name}'s profile</h2>
        <p className="nxa-dim">This part of SaveState isn't switched on for this profile.</p>
        <div className="nxa-row nxa-wrap" style={{ justifyContent: "center" }}>
          {open.map((t) => <button key={t} className="nxa-btn" onClick={() => goTab(t)}>{PROFILE_TABS[t]}</button>)}
        </div>
      </div>
    );
  }

  const locked = me.lockedTabs?.[tab];
  if (locked) {
    return (
      <div className="nxa nxa-locked nxa-gate-on">
        <span><Icon name="lock" size={28} /></span>
        <h2>{locked.label} isn't in your plan</h2>
        <p className="nxa-dim">
          You're on <b style={{ color: "#fff" }}>{me.tier?.name ?? "the free plan"}</b>.{" "}
          {locked.tiers.length ? <>{locked.label} comes with {locked.tiers.join(" or ")}.</> : <>It isn't available on any plan right now.</>}
        </p>
        <button className="nxa-btn primary" onClick={() => goTab("plans")}><Icon name="star" /> See plans</button>
      </div>
    );
  }
  if (MEDIA_TABS.has(tab) && !me.access?.media) return <RequestAccess tab={tab} />;
  if (GAMES_TABS.has(tab) && !me.access?.games) {
    return (
      <div className="nxa">
        <Note>
          This host's game library is private, so it shows as empty for you. You can still play your own games here.{" "}
          <button className="nxa-link" onClick={() => goTab("emulation")}>See exactly what you need <Icon name="arrow" size={12} /></button>
        </Note>
      </div>
    );
  }
  return null;
}
