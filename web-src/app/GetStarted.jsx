// Get started: shown once, right after someone creates an account (and from
// Help & guides any time). New people landed on a locked "Movies & TV is by
// invitation" page with nothing telling them what SaveState is for them.
// Here they set up their profile, then choose how they'll use it: join this
// host's library, connect to someone else's host, set up a host of their own
// (PC or NAS), or just look around. Then: put SaveState on their devices.
import React, { useState, useEffect } from "react";
import { useStyles, api, store, Icon, Note, goTab } from "./lib.jsx";

const COLORS = ["#4d7cff", "#22d3ee", "#a855f7", "#f472b6", "#f59e0b", "#34d399", "#ef4444", "#94a3b8"];
const FLAG = "nx_get_started";

/** Called by the sign-up form; the next app load shows Get started. */
export const markNewAccount = () => store.set(FLAG, "1");

const CSS = `
.nxgs{position:fixed;inset:0;z-index:5200;overflow:auto;background:radial-gradient(ellipse at top,#1b1f3b,#07080f 70%);display:grid;place-items:start center;padding:28px 16px}
.nxgs-box{width:100%;max-width:760px;display:grid;gap:16px;animation:nxaRise .25s ease}
.nxgs-steps{display:flex;gap:6px}.nxgs-steps i{flex:1;height:4px;border-radius:4px;background:rgba(255,255,255,.12)}.nxgs-steps i.on{background:linear-gradient(90deg,var(--acc),var(--acc2))}
.nxgs h1{font-size:clamp(24px,4vw,34px);font-weight:900;letter-spacing:-.02em;margin:0}
.nxgs .lead{color:var(--dim);margin:0;font-size:15px}
.nxgs-paths{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.nxgs-path{text-align:left;padding:16px;border-radius:16px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:inherit;display:grid;gap:6px;cursor:pointer;transition:border-color .15s,transform .15s}
.nxgs-path:hover,.nxgs-path.on{border-color:var(--acc);transform:translateY(-2px)}
.nxgs-path b{font-size:15.5px;display:flex;gap:8px;align-items:center}
.nxgs-path span{font-size:13px;color:var(--dim)}
.nxgs-colors{display:flex;gap:8px;flex-wrap:wrap}.nxgs-colors button{width:34px;height:34px;border-radius:50%;border:2px solid transparent;cursor:pointer}.nxgs-colors button.on{border-color:#fff}
.nxgs-code{font:13px ui-monospace,Consolas,monospace;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow-wrap:anywhere}
@media (max-width:640px){.nxgs-paths{grid-template-columns:1fr}}
`;

export function GetStarted() {
  useStyles();
  const [show, setShow] = useState(() => store.get(FLAG) === "1" || new URLSearchParams(location.search).has("getstarted"));
  const [step, setStep] = useState(0);
  const [me, setMe] = useState(null);
  const [host, setHost] = useState(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [path, setPath] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!show) return;
    api("/api/auth/me").then((r) => { setMe(r.user); setName(r.user.display_name || r.user.username); if (r.user.avatar_color) setColor(r.user.avatar_color); }).catch(() => {});
    fetch("/api/host/public-profile").then((r) => (r.ok ? r.json() : null)).then(setHost).catch(() => {});
  }, [show]);
  if (!show) return null;

  const hostName = host?.name || host?.host_display_name || "this host";
  const hasLibrary = !!(me?.media_access || me?.games_access);
  const finish = (tab) => { store.del(FLAG); setShow(false); if (tab) goTab(tab); };
  const saveProfile = async () => {
    setBusy(true); setMsg(null);
    try { await api(`/api/profiles/${me.id}`, { method: "PATCH", body: { displayName: name.trim() || me.username, avatarColor: color } }); setStep(1); }
    catch { setStep(1); } finally { setBusy(false); }
  };
  const redeem = async () => {
    const c = code.trim().replace(/^.*\/invite\//, "").replace(/[?#].*$/, "");
    if (!c) return setMsg({ kind: "bad", text: "Paste the invite code or link you were sent." });
    setBusy(true); setMsg(null);
    try { await api(`/api/invite/${encodeURIComponent(c)}/redeem`, { method: "POST", body: {} }); store.del(FLAG); window.location.reload(); }
    catch (e) { setMsg({ kind: "bad", text: e.status === 404 ? "That invite code wasn't found. Check it with the person who sent it." : e.message }); setBusy(false); }
  };
  const ask = async () => {
    if (!host?.id) return setMsg({ kind: "bad", text: `${hostName} isn't taking requests right now. Ask them for an invite code.` });
    setBusy(true); setMsg(null);
    try { await api(`/api/hosts/${host.id}/request-access`, { method: "POST", body: {} }); setMsg({ kind: "ok", text: `Request sent. ${hostName} will be asked to approve it; the library opens for you as soon as they do. Meanwhile, look around.` }); }
    catch (e) { setMsg({ kind: /already/i.test(e.message) ? "ok" : "bad", text: /already/i.test(e.message) ? "You've already asked; it's waiting for approval." : e.message }); }
    finally { setBusy(false); }
  };
  const connect = () => {
    let u = address.trim();
    if (!u) return setMsg({ kind: "bad", text: "Type the address of their SaveState, for example friends-house.example.com" });
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try { const url = new URL(u); store.del(FLAG); window.location.href = url.origin; }
    catch { setMsg({ kind: "bad", text: "That doesn't look like a web address. It looks like friends-house.example.com" }); }
  };

  const PATHS = [
    { id: "join", icon: "film", title: `Watch and play ${hostName}'s library`, text: hasLibrary ? "You already have access. Jump straight in." : "Films, shows, music and games shared by the host. Use an invite code, or ask for access." },
    { id: "connect", icon: "link", title: "Connect to another host", text: "Someone runs SaveState at home and gave you their address." },
    { id: "host", icon: "chip", title: "Host my own library", text: "Turn your PC or NAS into your own SaveState for your films, music and games." },
    { id: "explore", icon: "star", title: "Just look around", text: "Mini Games, Discover, your own files and drives. You can choose later." },
  ];

  return (
    <div className="nxa nxgs" role="dialog" aria-label="Get started">
      <style>{CSS}</style>
      <div className="nxgs-box">
        <div className="nxa-brand"><span><Icon name="game" /></span> SaveState</div>
        <div className="nxgs-steps" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={i <= step ? "on" : ""} />)}</div>

        {step === 0 && (
          <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
            <h1>Welcome{me ? `, ${me.display_name || me.username}` : ""}!</h1>
            <p className="lead">Your account is ready. First, how should you look to others?</p>
            <div className="nxa-field"><label>Your name</label><input className="nxa-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></div>
            <div className="nxa-field"><label>Your colour</label>
              <div className="nxgs-colors">{COLORS.map((c) => <button key={c} className={c === color ? "on" : ""} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />)}</div></div>
            <div className="nxa-row nxa-wrap">
              <button className="nxa-btn primary" disabled={busy || !me} onClick={saveProfile}>{busy ? <Icon name="spinner" /> : null} Continue</button>
              <button className="nxa-link" onClick={() => setStep(1)}>Skip</button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: "grid", gap: 14 }}>
            <h1>How will you use SaveState?</h1>
            <p className="lead">Pick one; you can do the others later from the menu.</p>
            <div className="nxgs-paths">
              {PATHS.map((p) => <button key={p.id} className={`nxgs-path${path === p.id ? " on" : ""}`} onClick={() => { setPath(p.id); setMsg(null); }}><b><Icon name={p.icon} /> {p.title}</b><span>{p.text}</span></button>)}
            </div>

            {path === "join" && (
              <div className="nxa-card" style={{ display: "grid", gap: 10 }}>
                {hasLibrary ? (
                  <><Note kind="ok">You have access to {hostName}'s library.</Note>
                    <button className="nxa-btn primary" onClick={() => setStep(2)}>Continue</button></>
                ) : (
                  <>
                    <div className="nxa-field"><label>Invite code or link <i>(if you were sent one)</i></label>
                      <div className="nxa-row"><input className="nxa-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste it here" /><button className="nxa-btn primary" disabled={busy} onClick={redeem}>Use code</button></div></div>
                    <div className="nxa-row nxa-wrap"><span className="nxa-dim" style={{ fontSize: 13 }}>No code?</span><button className="nxa-btn" disabled={busy} onClick={ask}><Icon name="mail" size={14} /> Ask {hostName} for access</button></div>
                    <button className="nxa-link" style={{ justifySelf: "start" }} onClick={() => setStep(2)}>Continue</button>
                  </>
                )}
              </div>
            )}
            {path === "connect" && (
              <div className="nxa-card" style={{ display: "grid", gap: 10 }}>
                <div className="nxa-field"><label>Their SaveState address</label>
                  <div className="nxa-row"><input className="nxa-input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="friends-house.example.com" /><button className="nxa-btn primary" onClick={connect}>Go</button></div></div>
                <p className="nxa-faint" style={{ fontSize: 13, margin: 0 }}>Each host has its own address and accounts: create an account there, or use the invite link they sent you.</p>
              </div>
            )}
            {path === "host" && (
              <div className="nxa-card" style={{ display: "grid", gap: 10 }}>
                <p style={{ margin: 0 }}>Your own SaveState runs on a computer that stays on: a PC, a Mac, or a NAS.</p>
                <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6, fontSize: 14 }}>
                  <li><b>Any machine with Docker</b> (Synology, QNAP, Unraid, TrueNAS, a Linux PC, or Windows/Mac with Docker Desktop): one command sets up SaveState and its database, asks where your films, music and games are, and prints the address to open.
                    <div className="nxgs-code" style={{ marginTop: 6 }}>curl -fsSL {location.origin}/install.sh | bash</div>
                    <span className="nxa-faint" style={{ fontSize: 12.5 }}>On Windows run it in WSL (Ubuntu); on a Mac, in Terminal. The first account you create there owns it.</span></li>
                  <li><b>Then</b> the <b>Become a Host</b> page lists your host and makes invite links for people.</li>
                </ul>
                <div className="nxa-row nxa-wrap"><button className="nxa-btn primary" onClick={() => finish("become-host")}>Open Become a Host</button><button className="nxa-link" onClick={() => setStep(2)}>Later</button></div>
              </div>
            )}
            {path === "explore" && <button className="nxa-btn primary" style={{ justifySelf: "start" }} onClick={() => setStep(2)}>Continue</button>}
            {msg && <Note kind={msg.kind}>{msg.text}</Note>}
          </div>
        )}

        {step === 2 && (
          <div className="nxa-card" style={{ display: "grid", gap: 12 }}>
            <h1>Put SaveState on your devices</h1>
            <p className="lead">The site works in any browser. The apps add a home-screen icon and, on Windows, full-speed games.</p>
            <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8, fontSize: 14 }}>
              <li><b>Android:</b> <a href="/api/downloads/apk">download the app</a>, open it and allow the install.</li>
              <li><b>iPhone or iPad:</b> in Safari tap Share, then <b>Add to Home Screen</b>.</li>
              <li><b>Windows:</b> <a href="/api/downloads/desktop?platform=windows">get SaveState for Windows</a>; it sets up games on your PC.</li>
              <li><b>TV:</b> open the site in the TV's browser, or use Moonlight for games.</li>
            </ul>
            <div className="nxa-row nxa-wrap" style={{ alignItems: "center" }}>
              <button className="nxa-btn" onClick={() => window.dispatchEvent(new CustomEvent("nexus:game-setup"))}><Icon name="game" /> Set up games now</button>
              <span className="nxa-dim" style={{ fontSize: 13 }}>Pick your consoles; it installs what they need, step by step.</span>
            </div>
            <div className="nxa-row nxa-wrap">
              <button className="nxa-btn primary" onClick={() => finish(path === "explore" ? "minigames" : hasLibrary ? "media" : path === "join" ? "minigames" : null)}>Start using SaveState</button>
              <button className="nxa-btn" onClick={() => finish("help")}>Read the guides</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
