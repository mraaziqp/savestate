// Sign in, create an account, ask for a password reset, set a new password.
//
// Replaces the compiled AuthForm chunk, so it keeps that component's props:
// the app shell hands it onLogin(username, password) and expects onSuccess()
// once the session exists. Sign-up talks to the API itself (the shell's own
// register call cannot carry an email) and then signs in through onLogin, so
// the shell's session state is set the same way in both cases.
import React, { useState, useEffect, useRef } from "react";
import { useStyles, api, store, Icon, Note } from "./lib.jsx";

const LAST_USER = "nexus_last_user";
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 0-4, plus the one thing that would improve it most. */
export function passwordStrength(pw, min = 8) {
  if (!pw) return { score: 0, label: "", tip: `At least ${min} characters.` };
  if (pw.length < min) return { score: 1, label: "Too short", tip: `${min - pw.length} more character${min - pw.length === 1 ? "" : "s"} to go.` };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const repeats = /^(.)\1+$/.test(pw) || /^(0123|1234|2345|abcd|qwer)/i.test(pw);
  let score = 2;
  if (pw.length >= 10 && kinds >= 2) score = 3;
  if (pw.length >= 14 || (pw.length >= 11 && kinds >= 3)) score = 4;
  if (repeats || kinds === 1 && pw.length < 12) score = 2;
  const label = ["", "Too short", "Okay", "Good", "Strong"][score];
  const tip = score >= 4 ? "" : pw.length < 12 ? "Longer is stronger: a few random words work well." : "Mix in a number or symbol.";
  return { score, label, tip };
}
const METER = ["", "#fb7185", "#fbbf24", "#22d3ee", "#34d399"];

function PasswordField({ id, label, value, onChange, autoComplete, placeholder, bad, autoFocus, children }) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const onKey = (e) => setCaps(!!e.getModifierState?.("CapsLock"));
  return (
    <div className="nxa-field">
      <label htmlFor={id}>{label}</label>
      <div className="nxa-inwrap">
        <input id={id} className={`nxa-input ${bad ? "bad" : ""}`} type={show ? "text" : "password"} value={value}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onKeyUp={onKey} onBlur={() => setCaps(false)}
          autoComplete={autoComplete} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} autoCapitalize="none" />
        <button type="button" className="nxa-eye" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} title={show ? "Hide password" : "Show password"}>
          <Icon name={show ? "eyeOff" : "eye"} size={18} />
        </button>
      </div>
      {caps && <div className="nxa-hint warn"><Icon name="alert" size={13} /> Caps Lock is on</div>}
      {children}
    </div>
  );
}

export function AuthForm({ onLogin, onSuccess, defaultMode = "login", variant = "full", resetToken = "", onResetDone }) {
  useStyles();
  const [mode, setMode] = useState(resetToken ? "reset" : defaultMode === "register" ? "register" : "login");
  const [identifier, setIdentifier] = useState(() => store.get(LAST_USER, "") ?? "");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);       // { text, field }
  const [notice, setNotice] = useState("");
  const [config, setConfig] = useState({ emailReset: false, minPassword: 8, signUpOpen: true });
  const [nameCheck, setNameCheck] = useState(null); // { state: checking|ok|taken|bad, text, suggestion }
  const checkSeq = useRef(0);

  useEffect(() => {
    let live = true;
    api("/api/auth/config").then((c) => { if (live && c) setConfig((old) => ({ ...old, ...c })); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // "Is this name free?" while typing, so nobody fills the whole form to find out.
  useEffect(() => {
    if (mode !== "register") return;
    const name = username.trim().toLowerCase();
    if (!name) { setNameCheck(null); return; }
    if (name.length < 3) { setNameCheck({ state: "bad", text: "At least 3 characters." }); return; }
    if (!USERNAME_RE.test(name)) { setNameCheck({ state: "bad", text: "Letters, numbers, dots, dashes and underscores only." }); return; }
    setNameCheck({ state: "checking", text: "Checking…" });
    const seq = ++checkSeq.current;
    const timer = setTimeout(() => {
      api(`/api/auth/check-username?u=${encodeURIComponent(name)}`).then((r) => {
        if (seq !== checkSeq.current) return;
        if (r.available === true) setNameCheck({ state: "ok", text: `${name} is available.` });
        else if (r.available === false) setNameCheck({ state: "taken", text: r.reason ?? "That username is taken.", suggestion: r.suggestion });
        else setNameCheck(null);
      }).catch(() => { if (seq === checkSeq.current) setNameCheck(null); });
    }, 350);
    return () => clearTimeout(timer);
  }, [username, mode]);

  // Re-selecting the current tab must not wipe what has been typed.
  const go = (next) => { if (next === mode) return; setMode(next); setError(null); setNotice(""); setPassword(""); };
  const strength = passwordStrength(password, config.minPassword);
  const compact = variant === "compact";

  async function signIn(name, pw) {
    await onLogin(name, pw);
    store.set(LAST_USER, name);
    onSuccess?.();
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice("");
    try {
      if (mode === "login") {
        const name = identifier.trim();
        if (!name) return setError({ text: "Enter your username or email.", field: "identifier" });
        if (!password) return setError({ text: "Enter your password.", field: "password" });
        setBusy(true);
        await signIn(name.toLowerCase(), password);
      } else if (mode === "register") {
        const name = username.trim().toLowerCase();
        const mail = email.trim().toLowerCase();
        if (!USERNAME_RE.test(name)) return setError({ text: "Pick a username of 3 to 32 letters, numbers, dots, dashes or underscores.", field: "username" });
        if (nameCheck?.state === "taken") return setError({ text: "That username is taken. Try another.", field: "username" });
        if (mail && !EMAIL_RE.test(mail)) return setError({ text: "That email address doesn't look right.", field: "email" });
        if (password.length < config.minPassword) return setError({ text: `Use a password of at least ${config.minPassword} characters.`, field: "password" });
        setBusy(true);
        await api("/api/auth/register", { method: "POST", anon: true, body: { username: name, password, display_name: displayName.trim() || undefined, email: mail || undefined } });
        // The app opens on Get started (GetStarted.jsx) for a new account.
        store.set("nx_get_started", "1");
        await signIn(name, password);
      } else if (mode === "forgot") {
        const name = identifier.trim();
        if (!name) return setError({ text: "Enter your username or email.", field: "identifier" });
        setBusy(true);
        const r = await api("/api/auth/forgot", { method: "POST", anon: true, body: { identifier: name } });
        setNotice(r?.message ?? "If that account exists, a reset link is on its way.");
      } else {
        if (password.length < config.minPassword) return setError({ text: `Use a password of at least ${config.minPassword} characters.`, field: "password" });
        setBusy(true);
        const r = await api("/api/auth/reset", { method: "POST", anon: true, body: { token: resetToken, password } });
        onResetDone?.();
        if (r?.username) await signIn(r.username, password);
        else { setNotice("Password changed. Sign in with your new password."); setMode("login"); }
      }
    } catch (err) {
      setError({ text: String(err?.message ?? "Something went wrong. Please try again."), field: err?.field });
    } finally {
      setBusy(false);
    }
  }

  const title = { login: "Welcome back", register: "Create your account", forgot: "Reset your password", reset: "Choose a new password" }[mode];
  const cta = { login: "Sign in", register: "Create account", forgot: "Send reset link", reset: "Save and sign in" }[mode];
  const bad = (f) => error?.field === f;

  return (
    <div className={`nxa nxa-auth ${compact ? "" : "card"}`}>
      {(mode === "login" || mode === "register") && config.signUpOpen && (
        <div className="nxa-tabs" role="tablist" aria-label="Sign in or create an account">
          <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "on" : ""} onClick={() => go("login")}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "on" : ""} onClick={() => go("register")}>Create account</button>
        </div>
      )}
      {!compact && (
        <div>
          <h2>{title}</h2>
          {mode === "forgot" && <p className="nxa-sub">{config.emailReset
            ? "Enter your username or email and we'll send a link to the email on your account."
            : "Enter your username or email. The host will be asked to send you a reset link."}</p>}
          {mode === "reset" && <p className="nxa-sub">You'll be signed in on this device, and signed out everywhere else.</p>}
        </div>
      )}

      <form onSubmit={submit} noValidate>
        {(mode === "login" || mode === "forgot") && (
          <div className="nxa-field">
            <label htmlFor="nxa-id">Username or email</label>
            <input id="nxa-id" className={`nxa-input ${bad("identifier") ? "bad" : ""}`} type="text" value={identifier} onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!identifier} placeholder="you@example.com" />
          </div>
        )}

        {mode === "register" && (
          <>
            <div className="nxa-field">
              <label htmlFor="nxa-user">Username</label>
              <input id="nxa-user" className={`nxa-input ${bad("username") || nameCheck?.state === "taken" || nameCheck?.state === "bad" ? "bad" : ""}`} type="text" value={username}
                onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus maxLength={32} placeholder="How you'll sign in" />
              {nameCheck && (
                <div className={`nxa-hint ${nameCheck.state === "ok" ? "ok" : nameCheck.state === "checking" ? "" : "bad"}`}>
                  <Icon name={nameCheck.state === "ok" ? "check" : nameCheck.state === "checking" ? "spinner" : "x"} size={13} />
                  <span>{nameCheck.text}{nameCheck.suggestion && <> Try <button type="button" className="nxa-link" onClick={() => setUsername(nameCheck.suggestion)}>{nameCheck.suggestion}</button></>}</span>
                </div>
              )}
            </div>
            <div className="nxa-field">
              <label htmlFor="nxa-name">Display name <i>(optional)</i></label>
              <input id="nxa-name" className="nxa-input" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="nickname" maxLength={48} placeholder="What others see" />
            </div>
            <div className="nxa-field">
              <label htmlFor="nxa-email">Email <i>(optional, for password resets)</i></label>
              <input id="nxa-email" className={`nxa-input ${bad("email") ? "bad" : ""}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" />
            </div>
          </>
        )}

        {mode !== "forgot" && (
          <PasswordField id="nxa-pw" label={mode === "reset" ? "New password" : "Password"} value={password} onChange={setPassword} bad={bad("password")}
            autoComplete={mode === "login" ? "current-password" : "new-password"} autoFocus={mode === "reset" || (mode === "login" && !!identifier)}
            placeholder={mode === "login" ? "Your password" : `At least ${config.minPassword} characters`}>
            {mode !== "login" && password && (
              <>
                <div className="nxa-meter" aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} style={{ background: i <= strength.score ? METER[strength.score] : undefined }} />)}</div>
                <div className="nxa-hint"><b style={{ color: METER[strength.score] }}>{strength.label}</b> {strength.tip}</div>
              </>
            )}
          </PasswordField>
        )}

        {error && <Note kind="bad">{error.text}</Note>}
        {notice && <Note kind="ok">{notice}</Note>}

        <button type="submit" className="nxa-btn primary big" disabled={busy}>
          {busy ? <><Icon name="spinner" /> One moment…</> : <>{cta} <Icon name="arrow" /></>}
        </button>
      </form>

      <div className="nxa-auth-foot">
        {mode === "login" && <button type="button" className="nxa-link" onClick={() => go("forgot")}>Forgot your password?</button>}
        {mode === "login" && config.signUpOpen && <span className="nxa-dim">New here? <button type="button" className="nxa-link" onClick={() => go("register")}>Create an account</button></span>}
        {mode === "register" && <span className="nxa-dim">Already have an account? <button type="button" className="nxa-link" onClick={() => go("login")}>Sign in</button></span>}
        {(mode === "forgot" || mode === "reset") && <button type="button" className="nxa-link" onClick={() => go("login")}>Back to sign in</button>}
      </div>
    </div>
  );
}
