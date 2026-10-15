// The Plans tab.
//
// Members see their plan, what each plan includes and how to upgrade. Admins
// get the console next to it: create and price tiers, choose which features
// sit behind which tiers, set each member's tier and library access, and deal
// with upgrade and password-reset requests.
//
// Tiers gate features of the app. Access to the host's own films, shows and
// games is a separate, per-person switch on the Members tab: that library is
// shared with people the host trusts, not sold.
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useStyles, api, Icon, Note, money, PERIOD, when } from "./lib.jsx";

const CATEGORIES = ["Media", "Games", "Cloud", "Extras"];
const priceOf = (t) => (t.priceCents > 0 ? money(t.priceCents, t.currency) : "Free");

function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const run = useCallback(async () => {
    try { setState({ data: await fn(), error: null, loading: false }); }
    catch (e) { setState((s) => ({ data: s.data, error: e.message, loading: false })); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, set: (data) => setState({ data, error: null, loading: false }) };
}

// ── Member view ─────────────────────────────────────────────────────────
function TierCard({ tier, features, current, pending, onChoose, busy, payable, recurring }) {
  const includes = features.filter((f) => f.gated && f.tiers.includes(tier.id));
  return (
    <div className={`nxa-tier ${current ? "current" : ""}`} style={{ "--tc": tier.color }}>
      <div>
        <div className="nxa-tier-name"><i />{tier.name}
          {tier.badge && <span className="nxa-pill acc">{tier.badge}</span>}
          {current && <span className="nxa-pill ok">Your plan</span>}
        </div>
        {tier.tagline && <p className="nxa-sub">{tier.tagline}</p>}
      </div>
      <div className="nxa-price">{priceOf(tier)}{tier.priceCents > 0 && <small>{PERIOD[tier.period] ?? ""}</small>}</div>
      <ul className="nxa-list nxa-grow">
        {includes.map((f) => <li key={f.key}><Icon name="check" /><span>{f.label}</span></li>)}
        {tier.perks.map((p) => <li key={p}><Icon name="star" /><span>{p}</span></li>)}
        {!includes.length && !tier.perks.length && <li><Icon name="check" /><span>Everything in the free features list below</span></li>}
      </ul>
      {current ? <button className="nxa-btn" disabled>Current plan</button>
        : pending ? <button className="nxa-btn ok" disabled><Icon name="check" /> Requested</button>
        : <button className="nxa-btn primary" disabled={busy} onClick={() => onChoose(tier)}>{busy ? <Icon name="spinner" /> : null}{tier.priceCents > 0 ? `Get ${tier.name}` : `Switch to ${tier.name}`}</button>}
      {!current && payable && (
        <p className="nxa-faint" style={{ fontSize: 11.5, textAlign: "center" }}>
          Secure payment by PayFast: card, Instant EFT and more.{tier.period === "once" ? " Pay once, keep it." : recurring ? ` Renews every ${tier.period === "year" ? "year" : "month"}; cancel any time from PayFast.` : ` Covers one ${tier.period === "year" ? "year" : "month"}.`}
        </p>
      )}
    </div>
  );
}

// PayFast takes a plain form POST; the server signs the fields.
function submitToPayfast(url, fields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.style.display = "none";
  for (const [k, v] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = k;
    input.value = String(v);
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

// Coming back from PayFast: ?payment=done or ?payment=cancelled.
function paymentReturn() {
  try { return new URLSearchParams(window.location.search).get("payment"); } catch { return null; }
}
function clearPaymentReturn() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete("payment");
    window.history.replaceState(null, "", u.toString());
  } catch { /* keep the URL */ }
}

function MemberPlans({ plans, me, reloadMe, payments }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [returned] = useState(paymentReturn);
  const [waiting, setWaiting] = useState(returned === "done");
  const free = plans.features.filter((f) => !f.gated);
  const startTier = React.useRef(me?.tier?.id ?? null);
  const startExpiry = React.useRef(me?.expiresAt ?? null);

  // PayFast confirms a payment to the host a few seconds after the member is
  // sent back, so look for the plan change for a little while.
  useEffect(() => {
    if (returned) clearPaymentReturn();
    if (returned !== "done") return;
    let n = 0;
    const t = setInterval(() => { n++; reloadMe(); if (n >= 20) { clearInterval(t); setWaiting(false); } }, 3000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const activated = waiting && me && (me.tier?.id !== startTier.current || me.expiresAt !== startExpiry.current);
  useEffect(() => { if (activated) setWaiting(false); }, [activated]);

  const payable = (tier) => !!payments?.payfast && tier.priceCents >= 500 && tier.currency === "ZAR";

  async function choose(tier) {
    setBusy(true); setError(""); setResult(null);
    try {
      if (payable(tier)) {
        const r = await api("/api/payments/payfast/checkout", { method: "POST", body: { tierId: tier.id } });
        submitToPayfast(r.url, r.fields);
        return; // leaving for PayFast; keep the button busy
      }
      const r = await api("/api/plans/request", { method: "POST", body: { tierId: tier.id } });
      setResult({ tier, checkoutUrl: r.checkoutUrl });
      reloadMe();
      setBusy(false);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <>
      {me && (
        <div className="nxa-card">
          <div className="nxa-row nxa-wrap" style={{ justifyContent: "space-between" }}>
            <div>
              <p className="nxa-label">YOUR PLAN</p>
              <h3 style={{ fontSize: 22, marginTop: 2 }}>{me.isAdmin ? "Admin: everything is unlocked" : me.tier.name}</h3>
              {me.expiresAt && <p className="nxa-sub">Runs until {new Date(me.expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p>}
            </div>
            <div className="nxa-row nxa-wrap">
              <span className={`nxa-pill ${me.access.media ? "ok" : ""}`}><Icon name={me.access.media ? "check" : "lock"} size={12} /> Host's media library</span>
              <span className={`nxa-pill ${me.access.games ? "ok" : ""}`}><Icon name={me.access.games ? "check" : "lock"} size={12} /> Host's game library</span>
            </div>
          </div>
          {!me.isAdmin && (!me.access.media || !me.access.games) && (
            <p className="nxa-sub" style={{ marginTop: 10 }}>
              The host's own library is shared by invitation, separately from plans. Ask the host for an invite, or request access from the Hosts page.
            </p>
          )}
        </div>
      )}

      {returned === "done" && (waiting
        ? <Note kind="ok"><Icon name="spinner" /> Payment received by PayFast. Your plan switches on as soon as PayFast confirms it, usually within a minute.</Note>
        : activated || me?.tier?.id !== startTier.current
          ? <Note kind="ok"><b>You're on {me?.tier?.name}.</b> Thanks for your payment{me?.expiresAt ? `; it runs until ${new Date(me.expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}` : ""}.</Note>
          : <Note kind="warn">PayFast hasn't confirmed the payment yet. If you were charged, it will appear here shortly; contact the host if it doesn't within the hour.</Note>)}
      {returned === "cancelled" && <Note>Payment cancelled. You haven't been charged.</Note>}
      {result && (
        <Note kind="ok">
          <b>Request sent for {result.tier.name}.</b>{" "}
          {result.checkoutUrl
            ? <>Complete your payment here: <a href={result.checkoutUrl} target="_blank" rel="noopener noreferrer">open the payment page <Icon name="ext" size={12} /></a>. Your plan is switched on once the host confirms it.</>
            : <>The host will be in touch about payment and switches your plan on once it's confirmed.</>}
        </Note>
      )}
      {error && <Note kind="bad">{error}</Note>}

      <div className="nxa-tiers">
        {plans.tiers.map((t) => (
          <TierCard key={t.id} tier={t} features={plans.features} busy={busy} onChoose={choose} payable={payable(t)} recurring={!!payments?.recurring}
            current={!!me && !me.isAdmin && me.tier.id === t.id} pending={me?.pendingRequest?.tier_id === t.id} />
        ))}
      </div>

      {free.length > 0 && (
        <div className="nxa-card">
          <h3>Included in every plan</h3>
          <ul className="nxa-list" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", marginTop: 12 }}>
            {free.map((f) => <li key={f.key}><Icon name="check" /><span><b>{f.label}</b><br /><span className="nxa-dim">{f.description}</span></span></li>)}
          </ul>
        </div>
      )}
    </>
  );
}

// ── Admin: service keys (server/service-keys.ts) ───────────────────────
function KeyRow({ k, reload }) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function save(v) {
    setBusy(true); setMsg(null);
    try {
      const r = await api(`/api/admin/service-keys/${k.env}`, { method: "PUT", body: { value: v } });
      setValue(""); setOpen(false);
      setMsg({ kind: r.check && /fail|refused|isn't|no domain/i.test(r.check) ? "warn" : "ok",
        text: (r.check ?? (v ? "Saved." : "Removed.")) + (r.restartNeeded ? " It takes effect the next time the host restarts." : "") });
      reload();
    } catch (e) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMsg(null);
    try { const r = await api(`/api/admin/service-keys/${k.env}/test`, { method: "POST" }); setMsg({ kind: r.ok ? "ok" : "bad", text: r.message }); }
    catch (e) { setMsg({ kind: "bad", text: e.message }); } finally { setBusy(false); }
  }
  return (
    <div className="nxa-card" style={{ padding: 16 }}>
      <div className="nxa-card-head" style={{ marginBottom: 0 }}>
        <div>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{k.label}
            {k.set ? <span className="nxa-pill ok">Set{k.ending ? ` …${k.ending}` : ""}{k.source === "env" ? " (from .env)" : ""}</span> : <span className="nxa-pill warn">Not set</span>}</h3>
          <p className="nxa-sub" style={{ margin: 0 }}>{k.purpose}</p>
        </div>
        <div className="nxa-row nxa-wrap">
          <button className="nxa-btn sm" onClick={() => setOpen((v) => !v)}><Icon name="key" /> {k.set ? "Replace" : "Add key"}</button>
          {k.set && k.testable && <button className="nxa-btn sm" disabled={busy} onClick={test}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} Test</button>}
          {k.source === "app" && <button className="nxa-btn sm" disabled={busy} onClick={() => window.confirm(`Remove the saved ${k.label} key?`) && save("")}>Remove</button>}
          <a className="nxa-btn sm" href={k.getUrl} target="_blank" rel="noreferrer"><Icon name="ext" /> Get one</a>
        </div>
      </div>
      {open && (
        <form className="nxa-row nxa-wrap" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(value.trim()); }}>
          <input className="nxa-input sm nxa-grow" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the key" aria-label={`${k.label} key`} autoFocus style={{ minWidth: 220 }} />
          <button type="submit" className="nxa-btn sm primary" disabled={busy || !value.trim()}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} Save{k.testable ? " & test" : ""}</button>
          <p className="nxa-faint" style={{ width: "100%", margin: "4px 0 0", fontSize: 12 }}>Where to find it: {k.where}</p>
        </form>
      )}
      {msg && <div style={{ marginTop: 10 }}><Note kind={msg.kind}>{msg.text}</Note></div>}
    </div>
  );
}

// Resend sends to anyone only once the domain's DNS records are in place.
function ResendDomain() {
  const d = useLoad(() => api("/api/admin/service-keys/resend/domain"), []);
  const [msg, setMsg] = useState("");
  const dom = d.data?.domain;
  if (!dom) return d.error ? <Note kind="bad">{d.error}</Note> : null;
  const verified = dom.status === "verified";
  async function verify() {
    setMsg("");
    try { await api("/api/admin/service-keys/resend/verify", { method: "POST", body: { id: dom.id } }); setMsg("Resend is checking the records; this can take a few minutes after you add them."); setTimeout(d.reload, 8000); }
    catch (e) { setMsg(e.message); }
  }
  return (
    <div className="nxa-card" style={{ padding: 16 }}>
      <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>Email domain {dom.name} {verified ? <span className="nxa-pill ok">Verified</span> : <span className="nxa-pill warn">{dom.status === "pending" ? "Checking" : "Not verified"}</span>}</h3>
      {verified ? <p className="nxa-sub" style={{ margin: 0 }}>Password-reset emails go to every member.</p> : <>
        <p className="nxa-sub">Until this is verified, reset emails only reach your own address. Add these records at your DNS host (savestate.co.za uses Cloudflare: <a href="https://dash.cloudflare.com/?to=/:account/:zone/dns/records" target="_blank" rel="noreferrer">DNS &gt; Records <Icon name="ext" size={11} /></a> &gt; Add record; for each, set Proxy status to <b>DNS only</b>), then press Check now.</p>
        <div style={{ overflowX: "auto" }}>
          <table className="nxa-table" style={{ fontSize: 12.5 }}><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Priority</th><th /></tr></thead><tbody>
            {dom.records.map((r) => (
              <tr key={r.type + r.name}>
                <td><b>{r.type}</b></td><td className="nxa-code">{r.name}</td>
                <td><span className="nxa-code" style={{ wordBreak: "break-all" }}>{r.value.length > 60 ? `${r.value.slice(0, 60)}…` : r.value}</span></td>
                <td>{r.priority ?? ""}</td>
                <td><button className="nxa-btn sm" onClick={() => navigator.clipboard?.writeText(r.value)}><Icon name="copy" size={12} /> Copy value</button>{r.status === "verified" && <span className="nxa-pill ok" style={{ marginLeft: 6 }}>OK</span>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <div className="nxa-row" style={{ marginTop: 10 }}><button className="nxa-btn sm primary" onClick={verify}><Icon name="refresh" /> Check now</button></div>
      </>}
      {msg && <Note>{msg}</Note>}
    </div>
  );
}

function KeysAdmin() {
  const keys = useLoad(() => api("/api/admin/service-keys"), []);
  if (!keys.data) return keys.error ? <Note kind="bad">{keys.error}</Note> : <p className="nxa-dim"><Icon name="spinner" /> Loading…</p>;
  return (
    <>
      <Note>Keys for outside services, stored encrypted on the host. A key saved here is used instead of the same one in .env.</Note>
      {keys.data.keys.map((k) => <React.Fragment key={k.env}><KeyRow k={k} reload={keys.reload} />{k.env === "RESEND_API_KEY" && k.set && <ResendDomain />}</React.Fragment>)}
    </>
  );
}

// ── Admin: tiers ────────────────────────────────────────────────────────
const BLANK = { name: "", tagline: "", priceCents: 0, currency: "ZAR", period: "month", color: "#22d3ee", badge: "", isPublic: true, checkoutUrl: "", perks: [] };

function TierEditor({ tier, count, onSaved, onCancel, onDelete }) {
  const isNew = !tier.id;
  const [f, setF] = useState({ ...BLANK, ...tier, price: ((tier.priceCents ?? 0) / 100).toString(), perksText: (tier.perks ?? []).join("\n") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((old) => ({ ...old, [k]: e?.target ? e.target.value : e }));

  async function save(e) {
    e.preventDefault();
    const price = Number(String(f.price).replace(",", "."));
    if (!f.name.trim()) return setError("Give the tier a name.");
    if (!Number.isFinite(price) || price < 0) return setError("The price must be a number, 0 or more.");
    setBusy(true); setError("");
    const body = {
      name: f.name, tagline: f.tagline, priceCents: Math.round(price * 100), currency: f.currency,
      period: price === 0 && f.period !== "once" ? "free" : f.period === "free" ? "month" : f.period,
      color: f.color, badge: f.badge, isPublic: f.isPublic, checkoutUrl: f.checkoutUrl,
      maxProfiles: String(f.maxProfiles ?? "").trim() === "" ? null : Number(f.maxProfiles),
      perks: f.perksText.split("\n").map((p) => p.trim()).filter(Boolean),
    };
    try {
      const r = await api(isNew ? "/api/admin/plans/tiers" : `/api/admin/plans/tiers/${encodeURIComponent(tier.id)}`, { method: isNew ? "POST" : "PATCH", body });
      onSaved(r.tier);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <form className="nxa-card" onSubmit={save} style={{ borderColor: f.color }}>
      <div className="nxa-card-head">
        <h3>{isNew ? "New tier" : `Edit ${tier.name}`}</h3>
        {!isNew && <span className="nxa-pill">{count} member{count === 1 ? "" : "s"}</span>}
      </div>
      <div className="nxa-form">
        <div className="nxa-field"><label>Name</label><input className="nxa-input sm" value={f.name} onChange={set("name")} maxLength={40} placeholder="Pro" autoFocus={isNew} /></div>
        <div className="nxa-field"><label>Price</label><input className="nxa-input sm" value={f.price} onChange={set("price")} inputMode="decimal" placeholder="0" /></div>
        <div className="nxa-field"><label>Currency</label><input className="nxa-input sm" value={f.currency} onChange={(e) => set("currency")(e.target.value.toUpperCase().slice(0, 3))} placeholder="ZAR" /></div>
        <div className="nxa-field"><label>Billed</label>
          <select className="nxa-input sm" value={f.period === "free" ? "month" : f.period} onChange={set("period")}>
            <option value="month">Monthly</option><option value="year">Yearly</option><option value="once">Once-off</option>
          </select>
        </div>
        <div className="nxa-field"><label>Badge <i>(optional)</i></label><input className="nxa-input sm" value={f.badge} onChange={set("badge")} maxLength={24} placeholder="Most popular" /></div>
        <div className="nxa-field"><label>Household profiles <i>(blank: no limit)</i></label><input className="nxa-input sm" value={f.maxProfiles ?? ""} onChange={(e) => set("maxProfiles")(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="No limit" /></div>
        <div className="nxa-field"><label>Colour</label><input className="nxa-input sm" type="color" value={f.color} onChange={set("color")} style={{ padding: 3, height: 36 }} /></div>
        <div className="nxa-field wide"><label>Tagline <i>(optional)</i></label><input className="nxa-input sm" value={f.tagline} onChange={set("tagline")} maxLength={120} placeholder="For households that watch every day" /></div>
        <div className="nxa-field wide"><label>Payment link <i>(optional, only used when PayFast is off: Yoco, PayPal.me... shown after a member asks for this tier)</i></label>
          <input className="nxa-input sm" value={f.checkoutUrl} onChange={set("checkoutUrl")} placeholder="https://" inputMode="url" /></div>
        <div className="nxa-field wide"><label>Extra selling points <i>(optional, one per line; features you gate are listed automatically)</i></label>
          <textarea className="nxa-input sm" rows={3} value={f.perksText} onChange={set("perksText")} placeholder={"Priority requests\nEarly access to new features"} /></div>
        <div className="nxa-row wide">
          <button type="button" className={`nxa-switch ${f.isPublic ? "on" : ""}`} role="switch" aria-checked={f.isPublic} aria-label="Show on the plans page" onClick={() => set("isPublic")(!f.isPublic)} />
          <span>{f.isPublic ? "Shown on the plans page" : "Hidden draft: only admins can see or assign it"}</span>
        </div>
      </div>
      {error && <div style={{ marginTop: 12 }}><Note kind="bad">{error}</Note></div>}
      <div className="nxa-row nxa-wrap" style={{ marginTop: 16, justifyContent: "space-between" }}>
        <div className="nxa-row">
          <button type="submit" className="nxa-btn primary" disabled={busy}>{busy ? <Icon name="spinner" /> : <Icon name="check" />} {isNew ? "Create tier" : "Save"}</button>
          <button type="button" className="nxa-btn" onClick={onCancel}>Cancel</button>
        </div>
        {!isNew && !tier.isDefault && <button type="button" className="nxa-btn danger" onClick={onDelete}><Icon name="trash" /> Delete tier</button>}
      </div>
    </form>
  );
}

function TiersAdmin({ data, reload }) {
  const [editing, setEditing] = useState(null); // tier object, or {} for new
  const [error, setError] = useState("");
  const act = async (fn) => { setError(""); try { await fn(); await reload(); } catch (e) { setError(e.message); } };
  const remove = (t) => {
    const n = data.counts[t.id] ?? 0;
    if (!window.confirm(`Delete the ${t.name} tier?${n ? ` ${n} member${n === 1 ? "" : "s"} on it will move to the default tier.` : ""}`)) return;
    act(async () => { await api(`/api/admin/plans/tiers/${encodeURIComponent(t.id)}`, { method: "DELETE" }); setEditing(null); });
  };
  return (
    <>
      {error && <Note kind="bad">{error}</Note>}
      {editing ? (
        <TierEditor key={editing.id ?? "new"} tier={editing} count={data.counts[editing.id] ?? 0} onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }} onDelete={() => remove(editing)} />
      ) : (
        <div className="nxa-card">
          <div className="nxa-card-head">
            <div><h3>Tiers</h3><p className="nxa-sub">New accounts start on the default tier. Drafts are hidden from members until you publish them.</p></div>
            <button className="nxa-btn primary" onClick={() => setEditing({})}><Icon name="plus" /> New tier</button>
          </div>
          <div className="nxa-scroll">
            <table className="nxa-table">
              <thead><tr><th>Tier</th><th>Price</th><th className="c">Members</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.tiers.map((t) => (
                  <tr key={t.id}>
                    <td><div className="nxa-tier-name" style={{ fontSize: 14, "--tc": t.color }}><i />{t.name}</div>{t.tagline && <div className="nxa-faint" style={{ fontSize: 12 }}>{t.tagline}</div>}</td>
                    <td>{priceOf(t)}<span className="nxa-faint">{t.priceCents > 0 ? PERIOD[t.period] ?? "" : ""}</span></td>
                    <td className="c">{data.counts[t.id] ?? 0}</td>
                    <td><div className="nxa-row nxa-wrap">
                      {t.isDefault && <span className="nxa-pill acc">Default</span>}
                      <span className={`nxa-pill ${t.isPublic ? "ok" : "warn"}`}>{t.isPublic ? "Published" : "Draft"}</span>
                      {t.priceCents > 0 && !t.checkoutUrl && <span className="nxa-pill" title="Members who ask for this tier are told the host will contact them">No payment link</span>}
                    </div></td>
                    <td><div className="nxa-row" style={{ justifyContent: "flex-end" }}>
                      {!t.isDefault && <button className="nxa-btn sm" onClick={() => act(() => api(`/api/admin/plans/tiers/${encodeURIComponent(t.id)}`, { method: "PATCH", body: { isDefault: true, isPublic: true } }))}>Make default</button>}
                      <button className="nxa-btn sm" onClick={() => setEditing(t)}><Icon name="edit" size={13} /> Edit</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ── Admin: which features need which tiers ──────────────────────────────
function FeaturesAdmin({ data, reload }) {
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [local, setLocal] = useState(data.features);
  useEffect(() => setLocal(data.features), [data.features]);

  async function save(feature, next) {
    setSaving(feature.key); setError("");
    setLocal((old) => old.map((f) => (f.key === feature.key ? { ...f, ...next } : f)));
    try { await api(`/api/admin/plans/features/${encodeURIComponent(feature.key)}`, { method: "PUT", body: { gated: next.gated, tiers: next.tiers } }); await reload(); }
    catch (e) { setError(e.message); setLocal(data.features); }
    finally { setSaving(""); }
  }
  const toggleTier = (f, id) => save(f, { gated: true, tiers: f.tiers.includes(id) ? f.tiers.filter((t) => t !== id) : [...f.tiers, id] });
  const gatedCount = local.filter((f) => f.gated).length;

  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <div>
          <h3>What's behind a paid tier</h3>
          <p className="nxa-sub">Everything is free for everyone until you switch on "Paid" for a feature and tick the tiers that include it. Admins always have everything.</p>
        </div>
        <span className={`nxa-pill ${gatedCount ? "acc" : "ok"}`}>{gatedCount ? `${gatedCount} paid feature${gatedCount === 1 ? "" : "s"}` : "Everything is free"}</span>
      </div>
      {error && <div style={{ marginBottom: 12 }}><Note kind="bad">{error}</Note></div>}
      <div className="nxa-scroll">
        <table className="nxa-table">
          <thead><tr><th>Feature</th><th className="c">Paid</th>{data.tiers.map((t) => <th key={t.id} className="c">{t.name}</th>)}</tr></thead>
          <tbody>
            {CATEGORIES.map((cat) => (
              <React.Fragment key={cat}>
                <tr className="group"><td colSpan={2 + data.tiers.length}>{cat}</td></tr>
                {local.filter((f) => f.category === cat).map((f) => {
                  const unreachable = f.gated && f.tiers.length === 0;
                  return (
                    <tr key={f.key} style={{ opacity: saving === f.key ? 0.6 : 1 }}>
                      <td><b>{f.label}</b><div className="nxa-faint" style={{ fontSize: 12 }}>{f.description}</div>
                        {unreachable && <div className="nxa-hint warn" style={{ marginTop: 4 }}><Icon name="alert" size={13} /> No tier includes this, so only admins can use it.</div>}</td>
                      <td className="c"><button className={`nxa-switch ${f.gated ? "on" : ""}`} role="switch" aria-checked={f.gated} aria-label={`${f.label} is paid`} onClick={() => save(f, { gated: !f.gated, tiers: f.tiers })} /></td>
                      {data.tiers.map((t) => (
                        <td key={t.id} className="c">
                          <input type="checkbox" className="nxa-check" aria-label={`${t.name} includes ${f.label}`} disabled={!f.gated}
                            checked={!f.gated || f.tiers.includes(t.id)} onChange={() => toggleTier(f, t.id)} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Admin: members ──────────────────────────────────────────────────────
function MembersAdmin({ data, reload }) {
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [link, setLink] = useState(null);
  const isAdminRole = (u) => ["admin", "superadmin", "ultra_admin"].includes(u.role);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.users.filter((u) => !s || u.username.includes(s) || (u.display_name ?? "").toLowerCase().includes(s) || (u.email ?? "").includes(s));
  }, [data.users, q]);

  async function update(u, body) {
    setBusy(u.id); setError("");
    try { await api(`/api/admin/plans/users/${u.id}`, { method: "PUT", body }); await reload(); }
    catch (e) { setError(e.message); } finally { setBusy(""); }
  }
  async function resetLink(u) {
    setError(""); setLink(null);
    try { const r = await api("/api/auth/admin-reset-link", { method: "POST", body: { username: u.username } }); setLink({ user: u.username, url: r.link }); }
    catch (e) { setError(e.message); }
  }
  const setExpiry = (u) => {
    const cur = u.tier_expires_at ? new Date(u.tier_expires_at).toISOString().slice(0, 10) : "";
    const v = window.prompt(`When should ${u.username}'s tier end? (YYYY-MM-DD, or leave empty for no end date)`, cur);
    if (v === null) return;
    update(u, { expiresAt: v.trim() ? `${v.trim()}T23:59:59` : null });
  };

  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <div><h3>Members</h3><p className="nxa-sub">The tier decides which paid features someone gets. The two library switches decide whether they can open <b>your own</b> films and games: only switch those on for people you trust.</p></div>
        <input className="nxa-input sm" style={{ maxWidth: 220 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members" aria-label="Search members" />
      </div>
      {error && <div style={{ marginBottom: 12 }}><Note kind="bad">{error}</Note></div>}
      {link && (
        <div style={{ marginBottom: 12 }}>
          <Note kind="ok">
            Reset link for <b>{link.user}</b> (works once, for 1 hour). Send it to them yourself:
            <div className="nxa-row" style={{ marginTop: 6 }}><span className="nxa-code nxa-grow">{link.url}</span>
              <button className="nxa-btn sm" onClick={() => navigator.clipboard?.writeText(link.url)}><Icon name="copy" size={13} /> Copy</button></div>
          </Note>
        </div>
      )}
      <div className="nxa-scroll">
        <table className="nxa-table">
          <thead><tr><th>Member</th><th>Tier</th><th className="c">Your media</th><th className="c">Your games</th><th className="c">Can upload</th><th>Last seen</th><th /></tr></thead>
          <tbody>
            {shown.map((u) => {
              const admin = isAdminRole(u);
              const games = u.games_access == null ? !!u.media_access : !!u.games_access;
              const expired = u.tier_expires_at && new Date(u.tier_expires_at) < new Date();
              return (
                <tr key={u.id} style={{ opacity: busy === u.id ? 0.6 : 1 }}>
                  <td><div className="nxa-user"><span className="nxa-avatar">{(u.display_name || u.username)[0]?.toUpperCase()}</span>
                    <div><b>{u.display_name || u.username}</b>{admin && <span className="nxa-pill acc" style={{ marginLeft: 6 }}>Admin</span>}
                      <div className="nxa-faint" style={{ fontSize: 12 }}>{u.username}{u.email ? ` · ${u.email}` : ""}</div></div></div></td>
                  <td>
                    <select className="nxa-input sm" style={{ minWidth: 120 }} value={data.tiers.some((t) => t.id === u.user_tier) ? u.user_tier : ""} onChange={(e) => update(u, { tier: e.target.value })} aria-label={`Tier for ${u.username}`}>
                      {!data.tiers.some((t) => t.id === u.user_tier) && <option value="">(default)</option>}
                      {data.tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <button className="nxa-link" style={{ fontSize: 11.5, display: "block", marginTop: 3, color: expired ? "#fb7185" : undefined }} onClick={() => setExpiry(u)}>
                      {u.tier_expires_at ? `${expired ? "Ended" : "Until"} ${new Date(u.tier_expires_at).toLocaleDateString()}` : "No end date"}
                    </button>
                  </td>
                  <td className="c"><button className={`nxa-switch ${admin || u.media_access ? "on" : ""}`} disabled={admin} role="switch" aria-checked={admin || !!u.media_access} aria-label={`${u.username} can open your media`} onClick={() => update(u, { media_access: !u.media_access })} /></td>
                  <td className="c"><button className={`nxa-switch ${admin || games ? "on" : ""}`} disabled={admin} role="switch" aria-checked={admin || games} aria-label={`${u.username} can open your games`} onClick={() => update(u, { games_access: !games })} /></td>
                  <td className="c"><button className={`nxa-switch ${admin || u.can_upload_media ? "on" : ""}`} disabled={admin} role="switch" aria-checked={admin || !!u.can_upload_media} aria-label={`${u.username} can upload`} onClick={() => update(u, { can_upload_media: !u.can_upload_media })} /></td>
                  <td className="nxa-dim" style={{ whiteSpace: "nowrap" }}>{when(u.last_seen)}</td>
                  <td><button className="nxa-btn sm" title="Create a one-time password reset link" onClick={() => resetLink(u)}><Icon name="key" size={13} /> Reset link</button></td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={7} className="nxa-dim">No members match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Admin: requests ─────────────────────────────────────────────────────
const PAY_STATUS = { paid: ["ok", "Paid"], pending: ["", "Started"], cancelled: ["warn", "Cancelled"], failed: ["bad", "Failed"], amount_mismatch: ["bad", "Wrong amount"] };
function PaymentsCard({ tiers }) {
  const list = useLoad(() => api("/api/admin/payments"), []);
  const cfg = useLoad(() => api("/api/payments/config"), []);
  const tierName = (id) => tiers.find((t) => t.id === id)?.name ?? id;
  const rows = list.data?.payments ?? [];
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const check = async () => {
    setChecking(true); setCheckResult(null);
    try { setCheckResult(await api("/api/admin/payments/payfast/check", { method: "POST" })); }
    catch (e) { setCheckResult({ ok: false, message: e.message }); }
    finally { setChecking(false); }
  };
  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <div><h3>Payments</h3>
          <p className="nxa-sub">{cfg.data?.payfast
            ? <>PayFast is connected{cfg.data.sandbox ? " (sandbox)" : ""}. Members pay on the Plans page and their tier switches on by itself once PayFast confirms the payment.{!cfg.data.recurring && <> Monthly and yearly plans are paid one period at a time; add your PayFast passphrase to the host's .env (PAYFAST_PASSPHRASE) to turn them into automatic subscriptions.</>}</>
            : <>Card payments are off. Add PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY to the host's .env to switch them on.</>}</p></div>
        <div className="nxa-row">
          {cfg.data?.payfast && <button className="nxa-btn sm" disabled={checking} onClick={check}>{checking ? <Icon name="spinner" size={13} /> : <Icon name="shield" size={13} />} Check PayFast connection</button>}
          <button className="nxa-btn sm" onClick={list.reload}><Icon name="refresh" size={13} /> Refresh</button>
        </div>
      </div>
      {checkResult && <div style={{ marginBottom: 12 }}><Note kind={checkResult.ok ? "ok" : "bad"}>{checkResult.message}</Note></div>}
      {rows.length === 0 ? <p className="nxa-dim">No payments yet.</p> : (
        <div className="nxa-scroll"><table className="nxa-table">
          <thead><tr><th>Member</th><th>Plan</th><th>Amount</th><th>Status</th><th>When</th><th>PayFast ref</th></tr></thead>
          <tbody>{rows.map((r) => {
            const [cls, label] = PAY_STATUS[r.status] ?? ["", r.status];
            return (
              <tr key={r.id}>
                <td><b>{r.display_name || r.username || "(deleted account)"}</b></td>
                <td>{tierName(r.tier_id)}{r.recurring && <span className="nxa-pill" style={{ marginLeft: 6 }}>Subscription</span>}</td>
                <td>{money(r.amount_cents, "ZAR")}</td>
                <td><span className={`nxa-pill ${cls}`}>{label}</span></td>
                <td className="nxa-dim">{when(r.updated_at ?? r.created_at)}</td>
                <td><span className="nxa-code">{r.provider_payment_id ?? "-"}</span></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </div>
  );
}

function RequestsAdmin({ data, resets, reload, reloadResets }) {
  const [error, setError] = useState("");
  const [link, setLink] = useState(null);
  const tierName = (id) => data.tiers.find((t) => t.id === id)?.name ?? id;
  const act = async (fn) => { setError(""); try { await fn(); } catch (e) { setError(e.message); } };
  return (
    <>
      {error && <Note kind="bad">{error}</Note>}
      <div className="nxa-card">
        <div className="nxa-card-head"><div><h3>Upgrade requests</h3><p className="nxa-sub">Approve once you've received payment. The member's tier changes straight away.</p></div></div>
        {data.requests.length === 0 ? <p className="nxa-dim">No one is waiting.</p> : (
          <div className="nxa-scroll"><table className="nxa-table">
            <thead><tr><th>Member</th><th>Wants</th><th>Asked</th><th /></tr></thead>
            <tbody>{data.requests.map((r) => (
              <tr key={r.id}>
                <td><b>{r.display_name || r.username}</b><div className="nxa-faint" style={{ fontSize: 12 }}>{r.username} · now on {tierName(r.user_tier)}</div></td>
                <td><span className="nxa-pill acc">{tierName(r.tier_id)}</span>{r.note && <div className="nxa-dim" style={{ fontSize: 12, marginTop: 4 }}>{r.note}</div>}</td>
                <td className="nxa-dim">{when(r.created_at)}</td>
                <td><div className="nxa-row" style={{ justifyContent: "flex-end" }}>
                  <button className="nxa-btn sm ok" onClick={() => act(async () => { await api(`/api/admin/plans/requests/${r.id}`, { method: "POST", body: { action: "approve" } }); await reload(); })}><Icon name="check" size={13} /> Approve</button>
                  <button className="nxa-btn sm" onClick={() => act(async () => { await api(`/api/admin/plans/requests/${r.id}`, { method: "POST", body: { action: "decline" } }); await reload(); })}>Decline</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <PaymentsCard tiers={data.tiers} />

      <div className="nxa-card">
        <div className="nxa-card-head"><div><h3>Password reset requests</h3>
          <p className="nxa-sub">People who used "Forgot your password?" and could not be emailed. Create a link and send it to them yourself.</p></div></div>
        {link && <div style={{ marginBottom: 12 }}><Note kind="ok">Link for <b>{link.user}</b> (works once, for 1 hour):
          <div className="nxa-row" style={{ marginTop: 6 }}><span className="nxa-code nxa-grow">{link.url}</span>
            <button className="nxa-btn sm" onClick={() => navigator.clipboard?.writeText(link.url)}><Icon name="copy" size={13} /> Copy</button></div></Note></div>}
        {resets.length === 0 ? <p className="nxa-dim">No one is waiting.</p> : (
          <div className="nxa-scroll"><table className="nxa-table">
            <thead><tr><th>Member</th><th>Asked</th><th /></tr></thead>
            <tbody>{resets.map((r) => (
              <tr key={r.id}>
                <td><b>{r.display_name || r.username}</b><div className="nxa-faint" style={{ fontSize: 12 }}>{r.username}{r.email ? ` · ${r.email}` : ""}</div></td>
                <td className="nxa-dim">{when(r.created_at)}</td>
                <td><div className="nxa-row" style={{ justifyContent: "flex-end" }}>
                  <button className="nxa-btn sm ok" onClick={() => act(async () => { const x = await api("/api/auth/admin-reset-link", { method: "POST", body: { username: r.username } }); setLink({ user: r.username, url: x.link }); await reloadResets(); })}><Icon name="key" size={13} /> Create link</button>
                  <button className="nxa-btn sm" onClick={() => act(async () => { await api(`/api/admin/reset-requests/${r.id}`, { method: "DELETE" }); await reloadResets(); })}>Dismiss</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

// ── Admin: the host PC ──────────────────────────────────────────────────
function HostAdmin() {
  const gm = useLoad(() => api("/api/host/game-mode"), []);
  const [error, setError] = useState("");
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) gm.reload(); }, 10_000); return () => clearInterval(t); }, [gm.reload]);
  const markGame = async (name, remove) => { setError(""); try { gm.set(await api("/api/host/game-mode/games", { method: "POST", body: { name, remove } })); } catch (e) { setError(e.message); } };
  const setMode = async (mode) => { setError(""); try { gm.set(await api("/api/host/game-mode", { method: "POST", body: { mode } })); } catch (e) { setError(e.message); } };
  const s = gm.data;
  return (
    <div className="nxa-card">
      <div className="nxa-card-head">
        <div><h3>Game mode</h3>
          <p className="nxa-sub">When a game starts on the host PC, the server steps aside: it drops to low priority, holds back scans, artwork and compression, and slows torrents. Streams to other people keep running. Everything resumes when the game closes.</p></div>
        {s && <span className={`nxa-pill ${s.active ? "warn" : "ok"}`}><Icon name={s.active ? "bolt" : "check"} size={12} /> {s.active ? `On: ${s.game ?? "game"}` : "Standing by"}</span>}
      </div>
      {error && <div style={{ marginBottom: 12 }}><Note kind="bad">{error}</Note></div>}
      {!s ? <p className="nxa-dim">{gm.error ?? "Loading…"}</p> : !s.supported ? <Note kind="warn">Game detection needs a Windows host. You can still switch game mode on by hand.</Note> : null}
      {s && (
        <div className="nxa-row nxa-wrap" style={{ marginTop: 6 }}>
          <div className="nxa-seg" role="group" aria-label="Game mode">
            {[["auto", "Automatic"], ["on", "Always on"], ["off", "Off"]].map(([id, label]) => (
              <button key={id} className={s.setting === id ? "on" : ""} onClick={() => setMode(id)}>{label}</button>
            ))}
          </div>
          {s.active && <span className="nxa-dim">{s.reason}{s.since ? ` · since ${new Date(s.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}{s.torrentsThrottled ? " · torrents slowed" : ""}</span>}
        </div>
      )}
      {s?.supported && (
        <div style={{ marginTop: 16 }}>
          <p className="nxa-label">YOUR GAMES</p>
          <p className="nxa-sub">Emulators and games installed through Steam, Epic, GOG, Xbox and similar are recognised on their own. If one is missed, open it and mark it here.</p>
          <div className="nxa-row nxa-wrap" style={{ marginTop: 8 }}>
            {s.myGames.map((g) => (
              <span key={g} className="nxa-pill acc">{g}
                <button className="nxa-link" style={{ color: "inherit" }} aria-label={`Stop treating ${g} as a game`} onClick={() => markGame(g, true)}><Icon name="x" size={11} /></button>
              </span>
            ))}
            {s.foreground && !s.myGames.includes(s.foreground.toLowerCase()) && (
              <button className="nxa-btn sm" onClick={() => markGame(s.foreground, false)}><Icon name="plus" size={13} /> Treat "{s.foreground}" (in front now) as a game</button>
            )}
            {!s.foreground && s.myGames.length === 0 && <span className="nxa-dim">Nothing marked yet.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────
export function PlansPage() {
  useStyles();
  const plans = useLoad(() => api("/api/plans"), []);
  const payments = useLoad(() => api("/api/payments/config").catch(() => null), []);
  const me = useLoad(() => api("/api/plans/me?pending=1").catch((e) => { if (e.status === 401) return null; throw e; }), []);
  const isAdmin = !!me.data?.isAdmin;
  const admin = useLoad(() => (isAdmin ? api("/api/admin/plans") : Promise.resolve(null)), [isAdmin]);
  const resets = useLoad(() => (isAdmin ? api("/api/admin/reset-requests").then((r) => r.requests) : Promise.resolve([])), [isAdmin]);
  const [view, setView] = useState("plans");
  const reloadAll = useCallback(async () => { await Promise.all([admin.reload(), plans.reload()]); }, [admin.reload, plans.reload]);
  const waiting = (admin.data?.requests.length ?? 0) + (resets.data?.length ?? 0);

  // Wait for "who am I" too: an admin briefly saw the member page otherwise.
  if ((plans.loading && !plans.data) || (me.loading && !me.data)) return <div className="nxa nxa-page"><p className="nxa-dim"><Icon name="spinner" /> Loading plans…</p></div>;
  if (!plans.data) return <div className="nxa nxa-page"><Note kind="bad">{plans.error ?? "Could not load the plans."} <button className="nxa-link" onClick={plans.reload}>Try again</button></Note></div>;

  const tabs = [["plans", "Plans", "star"], ["tiers", "Tiers", "edit"], ["features", "Paid features", "lock"], ["members", "Members", "users"], ["requests", "Payments & requests", "mail"], ["keys", "Service keys", "key"], ["host", "Host PC", "chip"]];
  return (
    <div className="nxa nxa-page">
      {isAdmin && (
        <div className="nxa-seg" role="tablist" aria-label="Plans admin">
          {tabs.map(([id, label, icon]) => (
            <button key={id} role="tab" aria-selected={view === id} className={view === id ? "on" : ""} onClick={() => setView(id)}>
              <Icon name={icon} size={14} /> {label}{id === "requests" && waiting > 0 && <span className="nxa-count">{waiting}</span>}
            </button>
          ))}
        </div>
      )}
      {view === "plans" || !isAdmin ? (
        <>
          {isAdmin && <Note>This is the page members see. Use the tabs above to create tiers and choose what they unlock.</Note>}
          <MemberPlans plans={plans.data} me={me.data} reloadMe={me.reload} payments={payments.data} />
        </>
      ) : !admin.data ? (
        admin.error ? <Note kind="bad">{admin.error} <button className="nxa-link" onClick={admin.reload}>Try again</button></Note> : <p className="nxa-dim"><Icon name="spinner" /> Loading…</p>
      ) : view === "tiers" ? <TiersAdmin data={admin.data} reload={reloadAll} />
        : view === "features" ? <FeaturesAdmin data={admin.data} reload={reloadAll} />
        : view === "members" ? <MembersAdmin data={admin.data} reload={admin.reload} />
        : view === "requests" ? <RequestsAdmin data={admin.data} resets={resets.data ?? []} reload={admin.reload} reloadResets={resets.reload} />
        : view === "keys" ? <KeysAdmin />
        : <HostAdmin />}
    </div>
  );
}
