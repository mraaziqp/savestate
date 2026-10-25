// Get started & Setup Guide: shown once after someone creates an account,
// or whenever opened from menu, settings, or via window.nxOpenSetup().
// Enables users to either:
//   1. Host their own library (like Plex Media Server) with custom "savestate" link
//   2. Connect to an existing host via link or address with live ping
//   3. Install SaveState on all their devices (Windows, Android, Linux, Vita, iOS, TV)
import React, { useState, useEffect } from "react";
import { useStyles, api, store, Icon, Note, goTab } from "./lib.jsx";

const COLORS = ["#4d7cff", "#22d3ee", "#a855f7", "#f472b6", "#f59e0b", "#34d399", "#ef4444", "#94a3b8"];
const FLAG = "nx_get_started";

/** Called by the sign-up form; the next app load shows Get started. */
export const markNewAccount = () => store.set(FLAG, "1");

const CSS = `
.nxgs{position:fixed;inset:0;z-index:5200;overflow:auto;background:radial-gradient(ellipse at top,#1b1f3b,#07080f 70%);display:grid;place-items:start center;padding:28px 16px}
.nxgs-box{width:100%;max-width:840px;display:grid;gap:16px;animation:nxaRise .25s ease}
.nxgs-steps{display:flex;gap:6px}.nxgs-steps i{flex:1;height:4px;border-radius:4px;background:rgba(255,255,255,.12)}.nxgs-steps i.on{background:linear-gradient(90deg,var(--acc),var(--acc2))}
.nxgs h1{font-size:clamp(24px,4vw,34px);font-weight:900;letter-spacing:-.02em;margin:0}
.nxgs .lead{color:var(--dim);margin:0;font-size:15px}
.nxgs-paths{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.nxgs-path{text-align:left;padding:16px;border-radius:16px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:inherit;display:grid;gap:6px;cursor:pointer;transition:border-color .15s,transform .15s}
.nxgs-path:hover,.nxgs-path.on{border-color:var(--acc);transform:translateY(-2px);background:rgba(255,255,255,.07)}
.nxgs-path b{font-size:15.5px;display:flex;gap:8px;align-items:center}
.nxgs-path span{font-size:13px;color:var(--dim)}
.nxgs-colors{display:flex;gap:8px;flex-wrap:wrap}.nxgs-colors button{width:34px;height:34px;border-radius:50%;border:2px solid transparent;cursor:pointer}.nxgs-colors button.on{border-color:#fff}
.nxgs-code{font:13px ui-monospace,Consolas,monospace;background:rgba(0,0,0,.5);border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow-wrap:anywhere}
.nxgs-grid-dev{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:8px}
.nxgs-dev-card{padding:14px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.03);display:grid;gap:8px;transition:all .15s}
.nxgs-dev-card:hover{border-color:rgba(255,255,255,.2);background:rgba(255,255,255,.06)}
.nxgs-dev-head{display:flex;justify-content:space-between;align-items:center}
.nxgs-dev-title{font-weight:800;font-size:15px;display:flex;align-items:center;gap:7px}
.nxgs-dev-badge{font-size:11px;font-weight:800;padding:2px 7px;border-radius:99px;background:rgba(34,211,238,.15);color:#22d3ee;border:1px solid rgba(34,211,238,.3)}
.nxgs-preview-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:99px;background:rgba(34,211,238,.12);border:1px solid rgba(34,211,238,.3);font-family:ui-monospace,monospace;font-size:12.5px;color:#a5f3fc}
@media (max-width:640px){.nxgs-paths{grid-template-columns:1fr}.nxgs-grid-dev{grid-template-columns:1fr}}
`;

export function GetStarted() {
  useStyles();
  const [show, setShow] = useState(() => store.get(FLAG) === "1" || /[\?&](getstarted|setup)=/i.test(location.search));
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

  // Host setup custom branding
  const [myHostName, setMyHostName] = useState("");
  const [customWording, setCustomWording] = useState("");
  const [customLinkResult, setCustomLinkResult] = useState(null);
  const [copiedLink, setCopiedLink] = useState(false);

  // Connect flow ping
  const [peerHost, setPeerHost] = useState(null);
  const [testedUrl, setTestedUrl] = useState("");

  useEffect(() => {
    const onOpen = () => setShow(true);
    window.addEventListener("nexus:setup-wizard", onOpen);
    window.nxOpenSetup = () => setShow(true);
    return () => {
      window.removeEventListener("nexus:setup-wizard", onOpen);
      delete window.nxOpenSetup;
    };
  }, []);

  useEffect(() => {
    if (!show) return;
    api("/api/auth/me").then((r) => {
      setMe(r.user);
      setName(r.user.display_name || r.user.username);
      setMyHostName(`${r.user.display_name || r.user.username}'s SaveState`);
      setCustomWording(r.user.username ? `${r.user.username}` : "home");
      if (r.user.avatar_color) setColor(r.user.avatar_color);
    }).catch(() => {});
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

  const redeem = async (customCodeToUse) => {
    const c = (customCodeToUse || code).trim().replace(/^.*\/invite\//, "").replace(/[?#].*$/, "");
    if (!c) return setMsg({ kind: "bad", text: "Paste the invite code or link you were sent." });
    setBusy(true); setMsg(null);
    try {
      await api(`/api/invite/${encodeURIComponent(c)}/redeem`, { method: "POST", body: {} });
      store.del(FLAG);
      setMsg({ kind: "ok", text: "Invite redeemed! Refreshing to load the library…" });
      setTimeout(() => window.location.reload(), 1000);
    } catch (e) {
      setMsg({ kind: "bad", text: e.status === 404 ? "That invite code wasn't found. Check it with the host." : e.message });
      setBusy(false);
    }
  };

  const ask = async () => {
    if (!host?.id) return setMsg({ kind: "bad", text: `${hostName} isn't taking requests right now. Ask them for an invite code.` });
    setBusy(true); setMsg(null);
    try {
      await api(`/api/hosts/${host.id}/request-access`, { method: "POST", body: {} });
      setMsg({ kind: "ok", text: `Request sent. ${hostName} will be asked to approve it; the library opens for you as soon as they do.` });
    } catch (e) {
      setMsg({ kind: /already/i.test(e.message) ? "ok" : "bad", text: /already/i.test(e.message) ? "You've already asked; it's waiting for approval." : e.message });
    } finally { setBusy(false); }
  };

  // Test invite or remote host
  const testConnection = async () => {
    let u = address.trim();
    if (!u) return setMsg({ kind: "bad", text: "Enter an invite link, code, or SaveState server address." });
    setBusy(true); setMsg(null); setPeerHost(null);

    // If it's an invite code or invite link:
    const inviteMatch = u.match(/(?:^|\/invite\/)([a-zA-Z0-9_-]+)/);
    if (inviteMatch && !u.startsWith("http")) {
      try {
        const inv = await api(`/api/invite/${encodeURIComponent(inviteMatch[1])}`);
        setPeerHost({ kind: "invite", invite: inv });
        setMsg({ kind: "ok", text: `Found invite from ${inv.host_display_name || inv.host_username}! Access tier: ${inv.tier}.` });
        setBusy(false);
        return;
      } catch {}
    }

    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try {
      const url = new URL(u);
      const res = await fetch(`${url.origin}/api/host/info`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json()).catch(() => null);
      if (res && res.name) {
        setPeerHost({ kind: "host", url: url.origin, info: res });
        setTestedUrl(url.origin);
        setMsg({ kind: "ok", text: `Connected! Reached ${res.name} successfully.` });
      } else {
        setMsg({ kind: "bad", text: `Could reach ${url.origin}, but it did not answer as a SaveState server.` });
      }
    } catch (e) {
      setMsg({ kind: "bad", text: `Couldn't connect to ${u}: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  const createCustomHostLink = async () => {
    const wording = customWording.trim() || me?.username || "family";
    setBusy(true); setMsg(null);
    try {
      const res = await api("/api/hosts/invites", {
        method: "POST",
        body: {
          wording,
          label: `${myHostName || "My SaveState"} Link`,
          tier: "free",
        },
      });
      const link = res.invite_url || `${location.origin}/invite/${res.code}`;
      setCustomLinkResult(link);
      setMsg({ kind: "ok", text: `Link created! Friends and family can use it to connect directly to your library.` });
    } catch (e) {
      setMsg({ kind: "bad", text: e.message || "Failed to create custom link." });
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    });
  };

  const previewSlug = () => {
    const w = (customWording.trim() || me?.username || "myhost").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
    return w.includes("savestate") ? w : `savestate-${w}`;
  };

  const PATHS = [
    { id: "join", icon: "film", title: `Watch and play ${hostName}'s library`, text: hasLibrary ? "You already have access. Jump straight in." : "Films, shows, music and games shared by the host. Use an invite code, or ask for access." },
    { id: "connect", icon: "link", title: "Connect to another host", text: "Someone runs SaveState at home and gave you their address or custom link." },
    { id: "host", icon: "chip", title: "Host my own library (Like Plex Server)", text: "Turn your PC, Mac, or NAS into your own SaveState. Share games and films with your custom link." },
    { id: "explore", icon: "star", title: "Just look around", text: "Mini Games, Discover, your own files and drives. You can set up hosting or connect later." },
  ];

  return (
    <div className="nxa nxgs" role="dialog" aria-label="Get started">
      <style>{CSS}</style>
      <div className="nxgs-box">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="nxa-brand" style={{ margin: 0 }}><span><Icon name="game" /></span> SaveState</div>
          <button className="nxa-btn sm" onClick={() => finish()} style={{ border: 0, opacity: .7 }}><Icon name="x" /> Close</button>
        </div>
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
            <p className="lead">Choose whether you want to run your own host (like Plex Media Server) or connect to an existing one.</p>
            <div className="nxgs-paths">
              {PATHS.map((p) => <button key={p.id} className={`nxgs-path${path === p.id ? " on" : ""}`} onClick={() => { setPath(p.id); setMsg(null); }}><b><Icon name={p.icon} /> {p.title}</b><span>{p.text}</span></button>)}
            </div>

            {path === "join" && (
              <div className="nxa-card" style={{ display: "grid", gap: 12 }}>
                {hasLibrary ? (
                  <><Note kind="ok">You have full access to {hostName}'s library.</Note>
                    <button className="nxa-btn primary" onClick={() => setStep(2)}>Continue to device setup</button></>
                ) : (
                  <>
                    <div className="nxa-field"><label>Invite link or code</label>
                      <div className="nxa-row"><input className="nxa-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. savestate-family or paste full link" /><button className="nxa-btn primary" disabled={busy} onClick={() => redeem()}>{busy ? <Icon name="spinner" /> : "Use code"}</button></div></div>
                    <div className="nxa-row nxa-wrap" style={{ alignItems: "center" }}><span className="nxa-dim" style={{ fontSize: 13 }}>No invite code?</span><button className="nxa-btn sm" disabled={busy} onClick={ask}><Icon name="mail" size={14} /> Ask {hostName} for access</button></div>
                    <button className="nxa-link" style={{ justifySelf: "start" }} onClick={() => setStep(2)}>Skip for now</button>
                  </>
                )}
              </div>
            )}

            {path === "connect" && (
              <div className="nxa-card" style={{ display: "grid", gap: 12 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>Connect to another host</h3>
                <p className="nxa-dim" style={{ margin: 0, fontSize: 13 }}>Enter your host's invite code, custom link, or web address:</p>
                <div className="nxa-field">
                  <div className="nxa-row">
                    <input className="nxa-input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. savestate-livingroom, or friends-house.com" />
                    <button className="nxa-btn primary" disabled={busy} onClick={testConnection}>{busy ? <Icon name="spinner" /> : "Test & Connect"}</button>
                  </div>
                </div>

                {peerHost?.kind === "invite" && (
                  <div className="nxa-card" style={{ background: "rgba(34,211,238,0.06)", borderColor: "rgba(34,211,238,0.3)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div><b>{peerHost.invite.host_display_name || peerHost.invite.host_username}</b><p className="nxa-dim" style={{ margin: 0, fontSize: 12 }}>{peerHost.invite.label || "SaveState Invite"}</p></div>
                      <button className="nxa-btn primary sm" onClick={() => redeem(peerHost.invite.code)}>Join Host</button>
                    </div>
                  </div>
                )}

                {peerHost?.kind === "host" && (
                  <div className="nxa-card" style={{ background: "rgba(34,211,238,0.06)", borderColor: "rgba(34,211,238,0.3)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div><b>{peerHost.info.name}</b><p className="nxa-dim" style={{ margin: 0, fontSize: 12 }}>{testedUrl}</p></div>
                      <a className="nxa-btn primary sm" href={testedUrl}>Open Host Server</a>
                    </div>
                  </div>
                )}

                <button className="nxa-link" style={{ justifySelf: "start" }} onClick={() => setStep(2)}>Continue</button>
              </div>
            )}

            {path === "host" && (
              <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Set Up Your SaveState Host</h3>
                    <p className="nxa-dim" style={{ margin: "4px 0 0", fontSize: 13.5 }}>Runs on your PC, Mac, or NAS like a Plex server. Manage your games, films, and invite users.</p>
                  </div>
                  <span className="nxgs-dev-badge">Host Server</span>
                </div>

                <div className="nxa-field">
                  <label>Host Name</label>
                  <input className="nxa-input" value={myHostName} onChange={(e) => setMyHostName(e.target.value)} placeholder="e.g. My SaveState, Living Room PC" />
                </div>

                <div className="nxa-field">
                  <label>Your Link with "SaveState" &amp; Custom Wording</label>
                  <div className="nxa-row">
                    <input className="nxa-input" value={customWording} onChange={(e) => setCustomWording(e.target.value)} placeholder="e.g. family, gaming, moh" />
                    <button className="nxa-btn primary" disabled={busy} onClick={createCustomHostLink}>{busy ? <Icon name="spinner" /> : "Create Custom Link"}</button>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <span className="nxa-dim" style={{ fontSize: 12 }}>Link preview: </span>
                    <span className="nxgs-preview-pill">{location.origin}/invite/{previewSlug()}</span>
                  </div>
                </div>

                {customLinkResult && (
                  <div className="nxa-card" style={{ background: "rgba(34,211,238,0.08)", borderColor: "rgba(34,211,238,0.4)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div style={{ overflow: "hidden" }}>
                      <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", color: "#22d3ee" }}>Your Ready-to-Share Link</span>
                      <div style={{ fontFamily: "monospace", fontSize: 13, color: "#fff", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{customLinkResult}</div>
                    </div>
                    <button className="nxa-btn sm primary" onClick={() => copyToClipboard(customLinkResult)}>
                      <Icon name={copiedLink ? "check" : "copy"} /> {copiedLink ? "Copied!" : "Copy Link"}
                    </button>
                  </div>
                )}

                <div style={{ display: "grid", gap: 8, fontSize: 13.5, background: "rgba(0,0,0,.25)", padding: 12, borderRadius: 12, border: "1px solid var(--line)" }}>
                  <b>How to run your host:</b>
                  <div><b>Windows Host:</b> Runs natively on your PC. Launch the host via desktop service or terminal (<span className="nxa-code">npm run dev</span>).</div>
                  <div><b>Linux, NAS &amp; Docker</b> (Synology, TrueNAS, Unraid, Linux PC):
                    <div className="nxgs-code" style={{ marginTop: 5 }}>curl -fsSL {location.origin}/install.sh | bash</div>
                  </div>
                </div>

                <div className="nxa-row nxa-wrap" style={{ marginTop: 4 }}>
                  <button className="nxa-btn primary" onClick={() => finish("become-host")}>Open Host Dashboard &amp; Users</button>
                  <button className="nxa-btn" onClick={() => setStep(2)}>Continue to Devices</button>
                </div>
              </div>
            )}

            {path === "explore" && (
              <div className="nxa-card" style={{ display: "grid", gap: 10 }}>
                <p style={{ margin: 0 }}>Explore Mini Games, Discover feeds, and your own personal Google Drive files without joining a shared host.</p>
                <button className="nxa-btn primary" style={{ justifySelf: "start" }} onClick={() => setStep(2)}>Continue to device setup</button>
              </div>
            )}

            {msg && <Note kind={msg.kind}>{msg.text}</Note>}
          </div>
        )}

        {step === 2 && (
          <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
            <div>
              <h1>Put SaveState on all your devices</h1>
              <p className="lead">Native apps and Web access for every screen in your home. All installers are live, updated, and ready to download.</p>
            </div>

            <div className="nxgs-grid-dev">
              {/* Windows App */}
              <div className="nxgs-dev-card">
                <div className="nxgs-dev-head">
                  <div className="nxgs-dev-title"><Icon name="chip" /> Windows PC</div>
                  <span className="nxgs-dev-badge">Native Engine</span>
                </div>
                <p className="nxa-dim" style={{ fontSize: 12.5, margin: 0 }}>Full-speed in-app emulation (GameCube, PS2, PSP, RetroArch) without external windows.</p>
                <a className="nxa-btn primary sm" href="/api/downloads/desktop?platform=windows" download>
                  <Icon name="down" /> Download for Windows
                </a>
              </div>

              {/* Android APK */}
              <div className="nxgs-dev-card">
                <div className="nxgs-dev-head">
                  <div className="nxgs-dev-title"><Icon name="bolt" /> Android Phone &amp; Tablet</div>
                  <span className="nxgs-dev-badge">APK v1.0.70</span>
                </div>
                <p className="nxa-dim" style={{ fontSize: 12.5, margin: 0 }}>Offline play, background downloads with DownloadManager, and full controller support.</p>
                <a className="nxa-btn primary sm" href="/api/downloads/apk" download>
                  <Icon name="down" /> Download Android APK
                </a>
              </div>

              {/* PS Vita */}
              <div className="nxgs-dev-card">
                <div className="nxgs-dev-head">
                  <div className="nxgs-dev-title"><Icon name="game" /> PlayStation Vita</div>
                  <span className="nxgs-dev-badge">VPK &amp; Portal</span>
                </div>
                <p className="nxa-dim" style={{ fontSize: 12.5, margin: 0 }}>Native VPK app or direct browser portal compatible with Vita NetFront WebKit.</p>
                <div className="nxa-row" style={{ gap: 6 }}>
                  <a className="nxa-btn sm primary" href="/api/downloads/vita" download><Icon name="down" /> VPK</a>
                  <a className="nxa-btn sm" href="/vita" target="_blank">Vita Portal</a>
                </div>
              </div>

              {/* Linux / Mac */}
              <div className="nxgs-dev-card">
                <div className="nxgs-dev-head">
                  <div className="nxgs-dev-title"><Icon name="folder" /> Linux &amp; Steam Deck</div>
                  <span className="nxgs-dev-badge">Debian / Script</span>
                </div>
                <p className="nxa-dim" style={{ fontSize: 12.5, margin: 0 }}>Native .deb package for Ubuntu/Zorin/Debian or standalone one-line install.</p>
                <a className="nxa-btn sm" href="/api/downloads/desktop?platform=linux" download>
                  <Icon name="down" /> Download Linux (.deb)
                </a>
              </div>

              {/* iOS / iPad */}
              <div className="nxgs-dev-card">
                <div className="nxgs-dev-head">
                  <div className="nxgs-dev-title"><Icon name="cloud" /> iPhone, iPad &amp; Mac</div>
                  <span className="nxgs-dev-badge">PWA</span>
                </div>
                <p className="nxa-dim" style={{ fontSize: 12.5, margin: 0 }}>In Safari tap Share, then tap <b>Add to Home Screen</b> for fullscreen play and offline saves.</p>
                <button className="nxa-btn sm" onClick={() => alert("In Safari: tap the Share button (square with arrow), then select 'Add to Home Screen'.")}>
                  Show iOS Instructions
                </button>
              </div>

              {/* Android TV */}
              <div className="nxgs-dev-card">
                <div className="nxgs-dev-head">
                  <div className="nxgs-dev-title"><Icon name="film" /> TV &amp; Fire TV</div>
                  <span className="nxgs-dev-badge">Leanback</span>
                </div>
                <p className="nxa-dim" style={{ fontSize: 12.5, margin: 0 }}>Sideload the APK onto Android TV / Fire TV or use TV browser for big-screen play.</p>
                <a className="nxa-btn sm" href="/api/downloads/apk" download><Icon name="down" /> TV APK</a>
              </div>
            </div>

            <div className="nxa-row nxa-wrap" style={{ alignItems: "center", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <button className="nxa-btn" onClick={() => window.dispatchEvent(new CustomEvent("nexus:game-setup"))}>
                <Icon name="game" /> Set up consoles &amp; games
              </button>
              <span className="nxa-dim" style={{ fontSize: 13 }}>Configure BIOS, folders, and controllers step by step.</span>
            </div>

            <div className="nxa-row nxa-wrap">
              <button className="nxa-btn primary" onClick={() => finish(path === "explore" ? "minigames" : hasLibrary ? "media" : path === "host" ? "become-host" : null)}>
                Start Using SaveState
              </button>
              <button className="nxa-btn" onClick={() => finish("help")}>Help &amp; Guides</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
