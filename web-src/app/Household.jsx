// Household profiles (server/household.ts).
//   Household     the Profiles tab: the account holder adds and manages
//                 profiles; inside a profile it shows whose it is and the time left.
//   ProfileLayer  mounted over the whole app: "Who's watching?" when the
//                 account has profiles, the profile chip with a switch button,
//                 the screen-time heartbeat and the "time's up" screen.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useStyles, api, token, store, Icon, Note, goTab } from "./lib.jsx";

const TABS_KEY = "nexus_profile_tabs";
const PICKED = "nexus_profile_picked";
const TAB_LABEL = { media: "Movies & TV", music: "Music", codex: "Books", library: "Games", gallery: "Photos", party: "Watch Party" };
const DAILY = [[null, "No limit"], [30, "30 minutes"], [60, "1 hour"], [90, "1½ hours"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"]];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const profileOfToken = () => {
  try { return JSON.parse(atob(token().split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).profileId ?? null; } catch { return null; }
};
const session = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};
const fmtMinutes = (m) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`);

/** Swap the session on this device and start the app fresh in it. */
async function switchSession(next, tabs) {
  store.set("nexus_token", next);
  if (tabs) store.set(TABS_KEY, JSON.stringify(tabs)); else store.del(TABS_KEY);
  session.set(PICKED, "1");
  // What the service worker cached for the previous session must not show in this one.
  try { await caches.delete("nexus-api"); } catch { /* no Cache API */ }
  const first = tabs ? (["media", "music", "codex", "library", "gallery"].find((t) => tabs.includes(t)) ?? "household") : "media";
  window.location.href = `/?tab=${first}`;
}

function Avatar({ p, size = 64 }) {
  return (
    <span className="nxa-who-av" style={{ width: size, height: size, fontSize: size * 0.5, background: `linear-gradient(135deg, ${p.color ?? "#22d3ee"}, #15172a)` }}>
      {p.avatar || (p.name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

function PinPad({ title, sub, onSubmit, onCancel }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e?.preventDefault();
    if (pin.length < 4) return;
    setBusy(true); setError("");
    try { await onSubmit(pin); } catch (err) { setError(err.message); setPin(""); setBusy(false); }
  }
  return (
    <form className="nxa-who-pin" onSubmit={go}>
      <h3>{title}</h3>
      {sub && <p className="nxa-dim">{sub}</p>}
      <input className="nxa-input" type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={8} value={pin} aria-label="PIN"
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="PIN" style={{ textAlign: "center", fontSize: 22, letterSpacing: 8, maxWidth: 220 }} />
      {error && <Note kind="bad">{error}</Note>}
      <div className="nxa-row" style={{ justifyContent: "center" }}>
        <button type="submit" className="nxa-btn primary" disabled={busy || pin.length < 4}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} Continue</button>
        <button type="button" className="nxa-btn" onClick={onCancel}>Back</button>
      </div>
    </form>
  );
}

// ── Over the whole app ────────────────────────────────────────────────────
export function ProfileLayer() {
  useStyles();
  const inProfile = !!profileOfToken();
  const [me, setMe] = useState(null);
  const [owner, setOwner] = useState(null);
  const [picking, setPicking] = useState(null);
  const [exiting, setExiting] = useState(false);
  const [timeUp, setTimeUp] = useState(null);
  const lastInput = useRef(Date.now());

  const load = useCallback(async () => {
    if (!token()) return;
    try {
      const r = await api("/api/household/me");
      setMe(r);
      if (r.profile) {
        store.set(TABS_KEY, JSON.stringify(r.profile.tabs));
        setTimeUp(r.timeUp ? r : null);
      } else if (r.profiles?.length && !session.get(PICKED)) {
        api("/api/auth/me").then((u) => setOwner(u.user)).catch(() => setOwner({}));
      }
    } catch { /* offline, or signed out: boot.js handles that */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Screen time: a minute counts when something is playing or someone touched the app lately.
  useEffect(() => {
    if (!inProfile) return;
    const touched = () => { lastInput.current = Date.now(); };
    const evs = ["pointerdown", "keydown", "touchstart", "wheel"];
    evs.forEach((e) => window.addEventListener(e, touched, { passive: true }));
    const beat = async () => {
      if (document.hidden) return;
      const playing = [...document.querySelectorAll("video,audio")].some((m) => !m.paused && !m.ended);
      try {
        const r = await api("/api/household/heartbeat", { method: "POST", body: { active: playing || Date.now() - lastInput.current < 120_000 } });
        setMe((old) => (old ? { ...old, minutesLeft: r.minutesLeft, minutesToday: r.minutesToday } : old));
        if (r.timeUp) setTimeUp(r);
      } catch { /* next minute */ }
    };
    const t = setInterval(beat, 60_000);
    const up = (e) => setTimeUp(e.detail ?? { message: "Time's up for today." });
    window.addEventListener("nexus:time-up", up);
    return () => { clearInterval(t); evs.forEach((e) => window.removeEventListener(e, touched)); window.removeEventListener("nexus:time-up", up); };
  }, [inProfile]);

  // Nothing plays behind the "time's up" screen.
  useEffect(() => {
    if (!timeUp?.timeUp && !timeUp?.message) return;
    document.querySelectorAll("video,audio").forEach((m) => { try { m.pause(); } catch { /* ignore */ } });
  }, [timeUp]);

  async function exit(pin) {
    const r = await api("/api/household/exit", { method: "POST", body: pin ? { pin } : {} });
    if (r.signOut) {
      store.del("nexus_token"); store.del(TABS_KEY);
      try { await caches.delete("nexus-api"); } catch { /* no Cache API */ }
      window.location.href = "/";
      return;
    }
    session.set(PICKED, "");
    try { sessionStorage.removeItem(PICKED); } catch { /* ignore */ }
    store.set("nexus_token", r.token); store.del(TABS_KEY);
    try { await caches.delete("nexus-api"); } catch { /* no Cache API */ }
    window.location.href = "/?tab=household";
  }
  async function startExit() {
    if (me?.profile?.via === "link") {
      if (window.confirm("Sign this device out of the profile?")) await exit().catch((e) => window.alert(e.message));
      return;
    }
    if (me?.exitNeedsPin) setExiting(true);
    else await exit().catch((e) => window.alert(e.message));
  }

  // Inside a profile: the chip, and the time's-up screen.
  if (me?.profile) {
    const p = me.profile;
    return (
      <>
        <div className="nxa nxa-who-chip" role="status">
          <Avatar p={p} size={28} />
          <span><b>{p.name}</b>{me.minutesLeft != null && <small>{fmtMinutes(me.minutesLeft)} left today</small>}</span>
          <button className="nxa-btn sm" onClick={startExit}>{p.via === "link" ? "Sign out" : "Switch"}</button>
        </div>
        {(timeUp || exiting) && (
          <div className="nxa nxa-who">
            {exiting ? (
              <PinPad title="Parent PIN" sub="Enter the parent PIN to leave this profile." onSubmit={exit} onCancel={() => setExiting(false)} />
            ) : (
              <div className="nxa-who-pin">
                <Avatar p={p} size={84} />
                <h2>Time's up</h2>
                <p className="nxa-dim">{timeUp.message || `That's all for ${p.name} for now.`}</p>
                <button className="nxa-btn" onClick={startExit}>{p.via === "link" ? "Sign out" : "Switch profile"}</button>
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  // The account itself, with profiles: "Who's watching?" once per visit.
  if (!me?.profiles?.length || session.get(PICKED) || !owner) return null;
  const ownerTile = { id: "", name: owner.display_name || owner.displayName || owner.username || "Me", avatar: "", color: "#4d7cff", hasPin: me.parentPin };
  async function choose(p, pin) {
    if (!p.id) {
      if (p.hasPin) await api("/api/household/parent-pin/check", { method: "POST", body: { pin } });
      session.set(PICKED, "1");
      setOwner(null);
      return;
    }
    const r = await api(`/api/household/${p.id}/enter`, { method: "POST", body: pin ? { pin } : {} });
    await switchSession(r.token, r.profile.tabs);
  }
  return (
    <div className="nxa nxa-who">
      {picking ? (
        <PinPad title={picking.id ? `${picking.name}'s PIN` : "Parent PIN"} onSubmit={(pin) => choose(picking, pin)} onCancel={() => setPicking(null)} />
      ) : (
        <div className="nxa-who-in">
          <h1>Who's watching?</h1>
          <div className="nxa-who-grid">
            {[ownerTile, ...me.profiles].map((p) => (
              <button key={p.id || "owner"} className="nxa-who-tile" onClick={() => (p.hasPin ? setPicking(p) : choose(p).catch((e) => window.alert(e.message)))}>
                <Avatar p={p} size={96} />
                <span className="nxa-who-name">{p.name}{p.hasPin && <Icon name="lock" size={12} />}</span>
              </button>
            ))}
          </div>
          <button className="nxa-btn" onClick={() => { session.set(PICKED, "1"); setOwner(null); goTab("household"); }}><Icon name="edit" /> Manage profiles</button>
        </div>
      )}
    </div>
  );
}

// ── The Profiles tab ──────────────────────────────────────────────────────
function Editor({ cfg, profile, onDone, onCancel }) {
  const isNew = !profile?.id;
  const [f, setF] = useState(() => ({
    name: profile?.name ?? "", avatar: profile?.avatar ?? cfg.avatars[0], color: profile?.color ?? cfg.colours[0],
    sections: profile?.sections ?? ["media", "music", "books", "games"], rating: profile?.rating ?? "all",
    allowUnrated: profile?.allowUnrated ?? false, dailyMinutes: profile?.dailyMinutes ?? null,
    allowedFrom: profile?.allowedFrom ?? null, allowedTo: profile?.allowedTo ?? null, pin: "", clearPin: false,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError("");
    const body = {
      name: f.name, avatar: f.avatar, color: f.color, sections: f.sections, rating: f.rating, allowUnrated: f.allowUnrated,
      dailyMinutes: f.dailyMinutes, allowedFrom: f.allowedFrom, allowedTo: f.allowedTo,
      ...(f.pin ? { pin: f.pin } : f.clearPin ? { pin: "" } : {}),
    };
    try {
      await api(isNew ? "/api/household" : `/api/household/${profile.id}`, { method: isNew ? "POST" : "PATCH", body });
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <form className="nxa-card" onSubmit={save} style={{ borderColor: f.color }}>
      <div className="nxa-card-head"><h3>{isNew ? "New profile" : `Edit ${profile.name}`}</h3></div>
      <div className="nxa-form">
        <div className="nxa-field"><label>Name</label>
          <input className="nxa-input sm" value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={24} placeholder="Sam" autoFocus={isNew} /></div>
        <div className="nxa-field"><label>PIN to open it <i>(optional, 4-8 digits)</i></label>
          <input className="nxa-input sm" type="password" inputMode="numeric" autoComplete="new-password" value={f.pin} maxLength={8}
            onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))} placeholder={profile?.hasPin ? "Leave blank to keep the PIN" : "No PIN"} />
          {profile?.hasPin && <label className="nxa-row" style={{ fontWeight: 500 }}><input type="checkbox" checked={f.clearPin} onChange={(e) => set("clearPin", e.target.checked)} /> Remove the PIN</label>}
        </div>
        <div className="nxa-field wide"><label>Picture</label>
          <div className="nxa-row nxa-wrap">
            {cfg.avatars.map((a) => <button type="button" key={a} className={`nxa-who-pick ${f.avatar === a ? "on" : ""}`} onClick={() => set("avatar", a)} aria-label={a}>{a}</button>)}
          </div>
          <div className="nxa-row nxa-wrap" style={{ marginTop: 6 }}>
            {cfg.colours.map((c) => <button type="button" key={c} className={`nxa-who-dot ${f.color === c ? "on" : ""}`} style={{ background: c }} onClick={() => set("color", c)} aria-label={`Colour ${c}`} />)}
          </div>
        </div>
        <div className="nxa-field wide"><label>What it can open</label>
          <div className="nxa-row nxa-wrap">
            {cfg.sections.map((s) => {
              const on = f.sections.includes(s.id);
              return <button type="button" key={s.id} className={`nxa-pill ${on ? "acc" : ""}`} style={{ cursor: "pointer", padding: "7px 12px", fontSize: 12.5 }} aria-pressed={on}
                onClick={() => set("sections", on ? f.sections.filter((x) => x !== s.id) : [...f.sections, s.id])}>{on && <Icon name="check" size={12} />}{s.label}</button>;
            })}
          </div>
          <p className="nxa-faint" style={{ fontSize: 12, margin: 0 }}>Downloads, files, settings and anything for admins are never available inside a profile.</p>
        </div>
        <div className="nxa-field"><label>Films and shows up to</label>
          <select className="nxa-input sm" value={f.rating} onChange={(e) => set("rating", e.target.value)}>
            {cfg.ratings.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          {f.rating !== "all" && <label className="nxa-row" style={{ fontWeight: 500, fontSize: 12.5 }}><input type="checkbox" checked={f.allowUnrated} onChange={(e) => set("allowUnrated", e.target.checked)} /> Also show titles with no official rating</label>}
        </div>
        <div className="nxa-field"><label>Screen time per day</label>
          <select className="nxa-input sm" value={f.dailyMinutes ?? ""} onChange={(e) => set("dailyMinutes", e.target.value === "" ? null : Number(e.target.value))}>
            {DAILY.map(([v, l]) => <option key={l} value={v ?? ""}>{l}</option>)}
          </select>
        </div>
        <div className="nxa-field wide"><label>Hours it can be used</label>
          <div className="nxa-row nxa-wrap">
            <select className="nxa-input sm" style={{ width: "auto" }} value={f.allowedFrom ?? ""} aria-label="From"
              onChange={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); setF((o) => ({ ...o, allowedFrom: v, allowedTo: v == null ? null : o.allowedTo ?? 20 })); }}>
              <option value="">Any time</option>
              {HOURS.map((h) => <option key={h} value={h}>From {String(h).padStart(2, "0")}:00</option>)}
            </select>
            {f.allowedFrom != null && (
              <select className="nxa-input sm" style={{ width: "auto" }} value={f.allowedTo ?? 20} aria-label="Until" onChange={(e) => set("allowedTo", Number(e.target.value))}>
                {HOURS.map((h) => <option key={h} value={h}>until {String(h).padStart(2, "0")}:00</option>)}
              </select>
            )}
          </div>
        </div>
      </div>
      {error && <div style={{ marginTop: 12 }}><Note kind="bad">{error}</Note></div>}
      <div className="nxa-row" style={{ marginTop: 16 }}>
        <button type="submit" className="nxa-btn primary" disabled={busy}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} {isNew ? "Add profile" : "Save"}</button>
        <button type="button" className="nxa-btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ParentPin({ on, onDone }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  async function save(value) {
    setError("");
    try { await api("/api/household/parent-pin", { method: "PUT", body: { pin: value } }); setOpen(false); setPin(""); onDone(); }
    catch (e) { setError(e.message); }
  }
  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <div><h3><Icon name="shield" /> Parent PIN {on ? <span className="nxa-pill ok">On</span> : <span className="nxa-pill warn">Not set</span>}</h3>
          <p className="nxa-sub">{on ? "Needed to leave a profile, and to choose your own account on \"Who's watching?\"." : "Without it, anyone using a profile on this device can switch back to your full account. Set one if children use SaveState."}</p></div>
        <div className="nxa-row">
          <button className="nxa-btn sm" onClick={() => setOpen((v) => !v)}>{on ? "Change" : "Set a PIN"}</button>
          {on && <button className="nxa-btn sm" onClick={() => window.confirm("Remove the parent PIN?") && save("")}>Remove</button>}
        </div>
      </div>
      {open && (
        <form className="nxa-row" onSubmit={(e) => { e.preventDefault(); save(pin); }} style={{ marginTop: 10 }}>
          <input className="nxa-input sm" type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} style={{ maxWidth: 180 }}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="4-8 digits" aria-label="New parent PIN" autoFocus />
          <button type="submit" className="nxa-btn primary sm" disabled={pin.length < 4}>Save</button>
        </form>
      )}
      {error && <Note kind="bad">{error}</Note>}
    </div>
  );
}

function ProfileCard({ cfg, p, onEdit, onChanged }) {
  const [link, setLink] = useState("");
  const [msg, setMsg] = useState(null);
  const ratingLabel = cfg.ratings.find((r) => r.id === p.rating)?.label ?? "Everything";
  const act = async (fn, done) => { setMsg(null); try { const r = await fn(); if (done) setMsg({ ok: done }); onChanged(); return r; } catch (e) { setMsg({ bad: e.message }); } };

  async function share() {
    if (p.shared && !window.confirm(`Make a new link for ${p.name}? The old link stops working and devices using it are signed out.`)) return;
    const r = await act(() => api(`/api/household/${p.id}/link`, { method: "POST" }));
    if (r?.url) { setLink(r.url); try { await navigator.clipboard.writeText(r.url); setMsg({ ok: "Link copied. Anyone with it can use this profile (only this profile) until you revoke it." }); } catch { /* shown below */ } }
  }
  async function enter() {
    if (p.hasPin) { const pin = window.prompt(`${p.name}'s PIN`); if (!pin) return; return act(async () => { const r = await api(`/api/household/${p.id}/enter`, { method: "POST", body: { pin } }); await switchSession(r.token, r.profile.tabs); }); }
    return act(async () => { const r = await api(`/api/household/${p.id}/enter`, { method: "POST", body: {} }); await switchSession(r.token, r.profile.tabs); });
  }

  return (
    <div className="nxa-card nxa-who-card" style={{ "--pc": p.color }}>
      <div className="nxa-row" style={{ alignItems: "flex-start", gap: 14 }}>
        <Avatar p={p} size={56} />
        <div className="nxa-grow">
          <h3 style={{ margin: 0 }}>{p.name} {p.hasPin && <Icon name="lock" size={13} />}</h3>
          <div className="nxa-row nxa-wrap" style={{ gap: 6, marginTop: 6 }}>
            <span className="nxa-pill">{ratingLabel}</span>
            {p.sections.map((s) => <span key={s} className="nxa-pill">{cfg.sections.find((x) => x.id === s)?.label ?? s}</span>)}
            {p.dailyMinutes != null && <span className={`nxa-pill ${p.minutesToday >= p.dailyMinutes ? "warn" : ""}`}>{fmtMinutes(p.minutesToday)} of {fmtMinutes(p.dailyMinutes)} today</span>}
            {p.allowedFrom != null && <span className="nxa-pill">{String(p.allowedFrom).padStart(2, "0")}:00-{String(p.allowedTo).padStart(2, "0")}:00</span>}
            {p.shared && <span className="nxa-pill acc"><Icon name="link" size={11} /> Shared link</span>}
          </div>
        </div>
      </div>
      <div className="nxa-row nxa-wrap" style={{ marginTop: 12 }}>
        <button className="nxa-btn sm primary" onClick={enter}><Icon name="user" /> Use this profile</button>
        <button className="nxa-btn sm" onClick={onEdit}><Icon name="edit" /> Edit</button>
        <button className="nxa-btn sm" onClick={share}><Icon name="link" /> {p.shared ? "New link" : "Share link"}</button>
        {p.shared && <button className="nxa-btn sm" onClick={() => window.confirm(`Revoke ${p.name}'s link? Devices using it are signed out.`) && act(() => api(`/api/household/${p.id}/link`, { method: "DELETE" }), "Link revoked.")}>Revoke link</button>}
        {p.dailyMinutes != null && p.minutesToday > 0 && <button className="nxa-btn sm" onClick={() => act(() => api(`/api/household/${p.id}/reset-time`, { method: "POST" }), "Today's time reset.")}>Reset today's time</button>}
        <button className="nxa-btn sm" onClick={() => window.confirm(`Sign ${p.name} out on every device?`) && act(() => api(`/api/household/${p.id}/signout`, { method: "POST" }), "Signed out everywhere.")}>Sign out everywhere</button>
        <button className="nxa-btn sm danger" onClick={() => window.confirm(`Delete ${p.name}'s profile and its watch history?`) && act(() => api(`/api/household/${p.id}`, { method: "DELETE" }))}><Icon name="trash" /></button>
      </div>
      {link && <div className="nxa-row" style={{ marginTop: 10 }}><input className="nxa-input sm nxa-grow" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Profile link" /></div>}
      {msg?.ok && <Note kind="ok">{msg.ok}</Note>}
      {msg?.bad && <Note kind="bad">{msg.bad}</Note>}
    </div>
  );
}

export function Household() {
  useStyles();
  const inProfile = !!profileOfToken();
  const [cfg, setCfg] = useState(null);
  const [me, setMe] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      if (inProfile) setMe(await api("/api/household/me"));
      else setCfg(await api("/api/household"));
    } catch (e) { setError(e.message); }
  }, [inProfile]);
  useEffect(() => { load(); }, [load]);

  if (inProfile) {
    const p = me?.profile;
    return (
      <div className="nxa nxa-page">
        <div className="nxa-card" style={{ textAlign: "center", display: "grid", justifyItems: "center", gap: 10 }}>
          {p ? <>
            <Avatar p={p} size={84} />
            <h2 style={{ margin: 0 }}>{p.name}'s profile</h2>
            {me.minutesLeft != null && <p className="nxa-dim">{fmtMinutes(me.minutesLeft)} left today</p>}
            <div className="nxa-row nxa-wrap" style={{ justifyContent: "center" }}>
              {p.tabs.filter((t) => TAB_LABEL[t]).map((t) => <button key={t} className="nxa-btn" onClick={() => goTab(t)}>{TAB_LABEL[t]}</button>)}
            </div>
            <p className="nxa-faint" style={{ fontSize: 12 }}>Use the button at the bottom right to switch profiles.</p>
          </> : error ? <Note kind="bad">{error}</Note> : <Icon name="spinner" />}
        </div>
      </div>
    );
  }

  const max = cfg?.maxProfiles;
  const full = cfg && max != null && cfg.profiles.length >= max;
  const capped = cfg?.profiles.some((p) => p.rating !== "all");
  return (
    <div className="nxa nxa-page">
      <div className="nxa-card">
        <div className="nxa-card-head">
          <div><h3><Icon name="users" /> Household profiles</h3>
            <p className="nxa-sub">One account for the whole home. Each profile has its own watch history, and you choose what it can open, the highest age rating, how long it can be used each day and whether it needs a PIN. Share a profile with a link to put it on another device without your password.</p></div>
          {cfg && !editing && <button className="nxa-btn primary" disabled={full} onClick={() => setEditing({})} title={full ? `Your plan includes ${max} profile${max === 1 ? "" : "s"}` : ""}><Icon name="plus" /> Add profile</button>}
        </div>
        {full && <Note>Your plan includes {max} profile{max === 1 ? "" : "s"}. <button className="nxa-link" onClick={() => goTab("plans")}>See plans</button></Note>}
        {capped && cfg.library.unrated > 0 && (
          <Note>{cfg.library.rating ? "Looking up age ratings for your library… " : ""}{cfg.library.unrated} of {cfg.library.titles} videos have no official rating{cfg.library.rating ? " yet" : ""}; they are hidden from profiles with an age limit unless you allow unrated titles.</Note>
        )}
        {error && <Note kind="bad">{error}</Note>}
      </div>
      {editing && cfg && <Editor cfg={cfg} profile={editing.id ? editing : null} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />}
      {cfg && <ParentPin on={cfg.parentPin} onDone={load} />}
      {cfg?.profiles.map((p) => <ProfileCard key={p.id} cfg={cfg} p={p} onEdit={() => setEditing(p)} onChanged={load} />)}
      {cfg && !cfg.profiles.length && !editing && <Note>No profiles yet. Add one for each person who uses SaveState with you.</Note>}
      {!cfg && !error && <p className="nxa-dim"><Icon name="spinner" /> Loading…</p>}
    </div>
  );
}
