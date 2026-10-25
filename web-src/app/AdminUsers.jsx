// Admin > Manage Users: every account on the host and every group.
// Search and filter people; open someone to change their plan, library
// access, role, name and email, put them in groups, send a password link,
// sign them out everywhere, suspend or remove them. The Groups tab shows
// every group (whoever made it), what it opens, and who is in it.
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useStyles, api, Icon, Note, when } from "./lib.jsx";

const CSS = `
.nxau-top{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.nxau-top .nxa-input{flex:1;min-width:180px}
.nxau-list{display:grid;gap:8px}
.nxau-row{border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.03)}
.nxau-row.open{border-color:var(--acc)}
.nxau-head{width:100%;display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 14px;background:none;border:0;text-align:left}
.nxau-av{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-weight:900;color:#03121a}
.nxau-name{font-weight:800;font-size:14.5px;overflow-wrap:anywhere}
.nxau-sub{font-size:12.5px;color:var(--dim);overflow-wrap:anywhere}
.nxau-pills{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
.nxau-body{padding:4px 14px 16px;display:grid;gap:14px;border-top:1px solid var(--line)}
.nxau-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.nxau-box{display:grid;gap:8px;padding:12px;border-radius:12px;background:rgba(0,0,0,.2);border:1px solid var(--line)}
.nxau-box h4{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
.nxau-tog{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13.5px}
.nxau-chips{display:flex;gap:6px;flex-wrap:wrap}
.nxau-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid var(--line);background:rgba(255,255,255,.05)}
.nxau-chip button{border:0;background:rgba(255,255,255,.1);border-radius:50%;width:18px;height:18px;display:grid;place-items:center;padding:0}
.nxau-acts{display:flex;gap:8px;flex-wrap:wrap}
.nxau-link{font:12.5px ui-monospace,Consolas,monospace;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:10px;padding:8px 10px;overflow-wrap:anywhere}
@media (max-width:560px){.nxau-head{grid-template-columns:36px minmax(0,1fr)}.nxau-head .nxau-seen{display:none}.nxau-av{width:36px;height:36px}}
`;

const COLORS = ["#4d7cff", "#22d3ee", "#a855f7", "#f472b6", "#f59e0b", "#34d399", "#ef4444", "#94a3b8"];
const colorOf = (s) => COLORS[[...String(s)].reduce((n, c) => n + c.charCodeAt(0), 0) % COLORS.length];
const ROLE = { ultra_admin: "Owner", superadmin: "Admin", admin: "Admin", user: "Member" };
const isAdminRole = (r) => ["admin", "superadmin", "ultra_admin"].includes(r);
const dateInput = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export function AdminUsers() {
  useStyles();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("people");
  const load = useCallback(() => api("/api/admin/people").then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="nxa nxa-page"><style>{CSS}</style>{error ? <Note kind="bad">{error}</Note> : <p className="nxa-dim"><Icon name="spinner" /> Loading…</p>}</div>;
  const admins = data.users.filter((u) => isAdminRole(u.role)).length;
  return (
    <div className="nxa nxa-page">
      <style>{CSS}</style>
      <div className="nxa-card">
        <div className="nxa-card-head">
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 900 }}>People &amp; groups</h2>
            <p className="nxa-dim" style={{ marginTop: 4 }}>{data.users.length} accounts · {admins} admin{admins === 1 ? "" : "s"} · {data.groups.length} group{data.groups.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="nxa-tabs" role="tablist" style={{ marginTop: 6 }}>
          <button role="tab" aria-selected={tab === "people"} className={tab === "people" ? "on" : ""} onClick={() => setTab("people")}>People</button>
          <button role="tab" aria-selected={tab === "groups"} className={tab === "groups" ? "on" : ""} onClick={() => setTab("groups")}>Groups</button>
          <button role="tab" aria-selected={tab === "invites"} className={tab === "invites" ? "on" : ""} onClick={() => setTab("invites")}>Custom Invites</button>
          <button role="tab" aria-selected={tab === "streams"} className={tab === "streams" ? "on" : ""} onClick={() => setTab("streams")}>Devices &amp; Streams</button>
        </div>
      </div>
      {error && <Note kind="bad">{error}</Note>}
      {tab === "people" && <People data={data} reload={load} />}
      {tab === "groups" && <Groups data={data} reload={load} />}
      {tab === "invites" && <InvitesTab data={data} />}
      {tab === "streams" && <StreamsTab data={data} />}
    </div>
  );
}

// ── People ────────────────────────────────────────────────────────────────
function People({ data, reload }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(null);
  const groupName = useMemo(() => Object.fromEntries(data.groups.map((g) => [g.id, g])), [data.groups]);
  const list = data.users.filter((u) => {
    const text = `${u.display_name ?? ""} ${u.username} ${u.email ?? ""}`.toLowerCase();
    if (q && !text.includes(q.trim().toLowerCase())) return false;
    if (filter === "admins") return isAdminRole(u.role);
    if (filter === "members") return !isAdminRole(u.role);
    if (filter === "nolibrary") return !u.media_access && !isAdminRole(u.role);
    if (filter === "suspended") return !!u.suspended_at;
    if (filter.startsWith("tier:")) return (u.user_tier ?? "free") === filter.slice(5);
    if (filter.startsWith("group:")) return u.groups.some((g) => g.id === filter.slice(6));
    return true;
  });
  return (
    <div className="nxa-card" style={{ display: "grid", gap: 12 }}>
      <div className="nxau-top">
        <input className="nxa-input sm" placeholder="Search by name, username or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <select className="nxa-input sm" style={{ width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show">
          <option value="all">Everyone</option>
          <option value="admins">Admins</option>
          <option value="members">Members</option>
          <option value="nolibrary">No library access</option>
          <option value="suspended">Suspended</option>
          {data.tiers.map((t) => <option key={t} value={`tier:${t}`}>Plan: {t}</option>)}
          {data.groups.map((g) => <option key={g.id} value={`group:${g.id}`}>Group: {g.name}</option>)}
        </select>
      </div>
      {!list.length && <p className="nxa-dim">Nobody matches.</p>}
      <div className="nxau-list">
        {list.map((u) => (
          <Person key={u.id} u={u} data={data} groupName={groupName} open={open === u.id} onToggle={() => setOpen(open === u.id ? null : u.id)} reload={reload} />
        ))}
      </div>
    </div>
  );
}

function Person({ u, data, groupName, open, onToggle, reload }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [link, setLink] = useState("");
  const [name, setName] = useState(u.display_name ?? "");
  const [email, setEmail] = useState(u.email ?? "");
  const [addGroup, setAddGroup] = useState("");
  const self = u.id === data.me.id;
  const locked = self || u.role === "ultra_admin";
  const admin = isAdminRole(u.role);

  async function run(label, fn, done) {
    setBusy(label); setMsg(null);
    try { await fn(); if (done) setMsg({ kind: "ok", text: done }); await reload(); }
    catch (e) { setMsg({ kind: "bad", text: e.message }); }
    finally { setBusy(""); }
  }
  const plan = (body) => run("plan", () => api(`/api/admin/plans/users/${u.id}`, { method: "PUT", body }), "Saved.");
  const patch = (body, done = "Saved.") => run("patch", () => api(`/api/admin/people/${u.id}`, { method: "PATCH", body }), done);

  return (
    <div className={`nxau-row ${open ? "open" : ""}`}>
      <button className="nxau-head" onClick={onToggle} aria-expanded={open}>
        <span className="nxau-av" style={{ background: colorOf(u.username) }}>{(u.display_name || u.username).slice(0, 1).toUpperCase()}</span>
        <span style={{ minWidth: 0 }}>
          <span className="nxau-name">{u.display_name || u.username}{self ? " (you)" : ""}</span>
          <span className="nxau-sub" style={{ display: "block" }}>@{u.username}{u.email && u.email !== u.username ? ` · ${u.email}` : ""}</span>
          <span className="nxau-pills">
            <span className={`nxa-pill ${admin ? "acc" : ""}`}>{ROLE[u.role] ?? u.role}</span>
            <span className="nxa-pill">{u.user_tier ?? "free"}{u.tier_expires_at ? ` until ${new Date(u.tier_expires_at).toLocaleDateString()}` : ""}</span>
            {(admin || u.media_access) && <span className="nxa-pill ok">Films</span>}
            {(admin || (u.games_access ?? u.media_access)) && <span className="nxa-pill ok">Games</span>}
            {(admin || u.can_upload_media) && <span className="nxa-pill ok">Uploads</span>}
            {u.suspended_at && <span className="nxa-pill bad">Suspended</span>}
            {u.screens > 0 && <span className="nxa-pill warn">Watching on {u.screens}</span>}
            {u.groups.map((g) => groupName[g.id] && <span key={g.id} className="nxa-pill" style={{ borderColor: groupName[g.id].color }}>{groupName[g.id].icon} {groupName[g.id].name}</span>)}
          </span>
        </span>
        <span className="nxau-sub nxau-seen" style={{ textAlign: "right" }}>seen {when(u.last_seen)}<br />joined {when(u.created_at)}</span>
      </button>

      {open && (
        <div className="nxau-body">
          {locked && <Note>{self ? "This is your own account: change your name, email and password from your profile." : "This is the host's owner account; it can't be changed here."}</Note>}
          <div className="nxau-grid">
            <div className="nxau-box">
              <h4>Plan</h4>
              <select className="nxa-input sm" value={u.user_tier ?? "free"} disabled={!!busy} onChange={(e) => plan({ tier: e.target.value })} aria-label="Plan">
                {data.tiers.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <label className="nxau-sub">Until <i>(blank: no end)</i></label>
              <input type="date" className="nxa-input sm" defaultValue={dateInput(u.tier_expires_at)} disabled={!!busy}
                onBlur={(e) => { if (e.target.value !== dateInput(u.tier_expires_at)) plan({ expiresAt: e.target.value || null }); }} aria-label="Plan ends" />
            </div>
            <div className="nxau-box">
              <h4>Host library</h4>
              <Toggle label="Films & shows" on={admin || !!u.media_access} disabled={admin || !!busy} onChange={(v) => plan({ media_access: v })} />
              <Toggle label="Games" on={admin || !!(u.games_access ?? u.media_access)} disabled={admin || !!busy} onChange={(v) => plan({ games_access: v })} />
              <Toggle label="Can upload" on={admin || !!u.can_upload_media} disabled={admin || !!busy} onChange={(v) => plan({ can_upload_media: v })} />
              {admin && <span className="nxau-sub">Admins always have everything.</span>}
            </div>
            <div className="nxau-box">
              <h4>Account</h4>
              <input className="nxa-input sm" value={name} placeholder="Display name" disabled={locked || !!busy} onChange={(e) => setName(e.target.value)}
                onBlur={() => { if (name !== (u.display_name ?? "")) patch({ display_name: name }); }} aria-label="Display name" />
              <input className="nxa-input sm" value={email} placeholder="Email" inputMode="email" disabled={locked || !!busy} onChange={(e) => setEmail(e.target.value)}
                onBlur={() => { if (email !== (u.email ?? "")) patch({ email }); }} aria-label="Email" />
              {data.me.ultra && !locked && (
                <select className="nxa-input sm" value={admin ? "admin" : "user"} disabled={!!busy} onChange={(e) => patch({ role: e.target.value }, e.target.value === "admin" ? `${u.username} is now an admin.` : `${u.username} is now a member.`)} aria-label="Role">
                  <option value="user">Member</option><option value="admin">Admin</option>
                </select>
              )}
            </div>
          </div>

          <div className="nxau-box">
            <h4>Groups</h4>
            <div className="nxau-chips">
              {!u.groups.length && <span className="nxau-sub">Not in any group.</span>}
              {u.groups.map((g) => groupName[g.id] && (
                <span key={g.id} className="nxau-chip" style={{ borderColor: groupName[g.id].color }}>{groupName[g.id].icon} {groupName[g.id].name}
                  <button aria-label={`Remove from ${groupName[g.id].name}`} disabled={!!busy} onClick={() => run("group", () => api(`/api/admin/groups/${g.id}/members/${u.id}`, { method: "DELETE" }))}><Icon name="x" size={11} /></button>
                </span>
              ))}
            </div>
            {data.groups.some((g) => !u.groups.some((x) => x.id === g.id)) && (
              <div className="nxa-row">
                <select className="nxa-input sm" value={addGroup} onChange={(e) => setAddGroup(e.target.value)} aria-label="Add to group" style={{ flex: 1 }}>
                  <option value="">Add to a group…</option>
                  {data.groups.filter((g) => !u.groups.some((x) => x.id === g.id)).map((g) => <option key={g.id} value={g.id}>{g.icon} {g.name}</option>)}
                </select>
                <button className="nxa-btn" disabled={!addGroup || !!busy} onClick={() => run("group", () => api(`/api/admin/groups/${addGroup}/members`, { method: "POST", body: { userId: u.id } }).then(() => setAddGroup("")))}><Icon name="plus" /> Add</button>
              </div>
            )}
          </div>

          {!locked && (
            <div className="nxau-acts">
              <button className="nxa-btn" disabled={!!busy} onClick={() => run("link", async () => { const r = await api(`/api/admin/people/${u.id}/reset-link`, { method: "POST" }); setLink(r.link); })}><Icon name="key" /> Password link</button>
              <button className="nxa-btn" disabled={!!busy} onClick={() => run("out", () => api(`/api/admin/people/${u.id}/sign-out`, { method: "POST" }), `${u.username} is signed out on every device.`)}><Icon name="lock" /> Sign out everywhere</button>
              <button className="nxa-btn" disabled={!!busy} onClick={() => patch({ suspended: !u.suspended_at }, u.suspended_at ? `${u.username} can sign in again.` : `${u.username} is suspended and signed out.`)}>
                <Icon name={u.suspended_at ? "check" : "alert"} /> {u.suspended_at ? "Unsuspend" : "Suspend"}</button>
              <button className="nxa-btn" disabled={!!busy} style={{ color: "var(--bad)" }} onClick={() => {
                const typed = prompt(`Remove ${u.username}'s account for good? Their profile, plan and group places go too.\n\nType ${u.username} to confirm.`);
                if (typed === u.username) run("del", () => api(`/api/admin/people/${u.id}`, { method: "DELETE", body: { confirm: typed } }));
              }}><Icon name="trash" /> Remove</button>
            </div>
          )}
          {link && (
            <div className="nxau-box">
              <h4>Password link (works for 1 hour)</h4>
              <div className="nxau-link">{link}</div>
              <div className="nxa-row"><button className="nxa-btn" onClick={() => { navigator.clipboard?.writeText(link); setMsg({ kind: "ok", text: "Copied. Send it to them." }); }}><Icon name="copy" /> Copy</button></div>
            </div>
          )}
          {busy && <p className="nxau-sub"><Icon name="spinner" /> Saving…</p>}
          {msg && <Note kind={msg.kind}>{msg.text}</Note>}
        </div>
      )}
    </div>
  );
}

function Toggle({ label, on, disabled, onChange }) {
  return (
    <div className="nxau-tog">
      <span>{label}</span>
      <button type="button" className={`nxa-switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />
    </div>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────
function Groups({ data, reload }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError("");
    try { await api("/api/admin/groups", { method: "POST", body: { name, color: COLORS[data.groups.length % COLORS.length] } }); setName(""); await reload(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <>
      <form className="nxa-card nxau-top" onSubmit={create}>
        <input className="nxa-input sm" placeholder="New group name, e.g. Family or Friends" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="New group name" />
        <button className="nxa-btn primary" disabled={busy || !name.trim()}>{busy ? <Icon name="spinner" /> : <Icon name="plus" />} Create group</button>
        {error && <Note kind="bad">{error}</Note>}
      </form>
      {!data.groups.length && <p className="nxa-dim">No groups yet. A group is a circle of people, like Family or Friends; adding someone to a group that opens the library gives them access.</p>}
      {data.groups.map((g) => <Group key={g.id} g={g} data={data} reload={reload} />)}
    </>
  );
}

function Group({ g, data, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [add, setAdd] = useState("");
  const [name, setName] = useState(g.name);
  const members = data.users.filter((u) => u.groups.some((x) => x.id === g.id));
  const others = data.users.filter((u) => !u.groups.some((x) => x.id === g.id));
  async function run(fn) {
    setBusy(true); setError("");
    try { await fn(); await reload(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const save = (body) => run(() => api(`/api/admin/groups/${g.id}`, { method: "PATCH", body }));
  return (
    <div className="nxa-card" style={{ borderColor: g.color, display: "grid", gap: 12 }}>
      <div className="nxa-card-head" style={{ marginBottom: 0 }}>
        <div className="nxa-row" style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 22 }}>{g.icon}</span>
          <input className="nxa-input sm" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name !== g.name) save({ name }); }} aria-label="Group name" style={{ fontWeight: 800, maxWidth: 320 }} />
          <input type="color" value={g.color} onChange={(e) => save({ color: e.target.value })} aria-label="Group colour" style={{ width: 34, height: 30, padding: 0, border: 0, background: "none" }} />
        </div>
        <span className="nxa-pill">{g.members} member{g.members === 1 ? "" : "s"}{g.owner ? ` · made by ${g.owner}` : ""}</span>
      </div>
      <div className="nxau-grid">
        <div className="nxau-box">
          <h4>Opens</h4>
          <Toggle label="The host's films & shows" on={!!g.allow_media_access} disabled={busy} onChange={(v) => save({ allow_media_access: v })} />
          <Toggle label="Downloads" on={!!g.allow_downloads} disabled={busy} onChange={(v) => save({ allow_downloads: v })} />
        </div>
        <div className="nxau-box">
          <h4>Members</h4>
          <div className="nxau-chips">
            {!members.length && <span className="nxau-sub">Nobody yet.</span>}
            {members.map((u) => (
              <span key={u.id} className="nxau-chip">{u.display_name || u.username}
                <button aria-label={`Remove ${u.username}`} disabled={busy} onClick={() => run(() => api(`/api/admin/groups/${g.id}/members/${u.id}`, { method: "DELETE" }))}><Icon name="x" size={11} /></button>
              </span>
            ))}
          </div>
          {others.length > 0 && (
            <div className="nxa-row">
              <select className="nxa-input sm" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Add someone" style={{ flex: 1 }}>
                <option value="">Add someone…</option>
                {others.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username} (@{u.username})</option>)}
              </select>
              <button className="nxa-btn" disabled={!add || busy} onClick={() => run(() => api(`/api/admin/groups/${g.id}/members`, { method: "POST", body: { userId: add } }).then(() => setAdd("")))}><Icon name="plus" /> Add</button>
            </div>
          )}
        </div>
      </div>
      <div className="nxa-row">
        <button className="nxa-btn" style={{ color: "var(--bad)" }} disabled={busy} onClick={() => { if (confirm(`Delete the group ${g.name}? Its members keep their accounts and access.`)) run(() => api(`/api/admin/groups/${g.id}`, { method: "DELETE" })); }}><Icon name="trash" /> Delete group</button>
        {busy && <span className="nxau-sub"><Icon name="spinner" /> Saving…</span>}
      </div>
      {error && <Note kind="bad">{error}</Note>}
    </div>
  );
}

// ── Custom Invites ────────────────────────────────────────────────────────
function InvitesTab({ data }) {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [wording, setWording] = useState("");
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState(data.tiers?.[0] || "free");
  const [maxUses, setMaxUses] = useState("");
  const [expiresHours, setExpiresHours] = useState("0");
  const [copiedId, setCopiedId] = useState(null);

  const fetchInvites = useCallback(async () => {
    try {
      const list = await api("/api/hosts/invites");
      setInvites(Array.isArray(list) ? list : []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  const cleanSlug = wording.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const effectiveSlug = cleanSlug ? (cleanSlug.includes("savestate") ? cleanSlug : `savestate-${cleanSlug}`) : "savestate-custom-name";
  const previewUrl = typeof window !== "undefined" ? `${window.location.origin}/invite/${effectiveSlug}` : `/invite/${effectiveSlug}`;

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const res = await api("/api/hosts/invites", {
        method: "POST",
        body: {
          wording: cleanSlug || undefined,
          label: label.trim() || undefined,
          tier,
          max_uses: maxUses ? parseInt(maxUses, 10) : undefined,
          expires_hours: expiresHours !== "0" ? parseInt(expiresHours, 10) : undefined,
        },
      });
      const link = res.invite_url || `${window.location.origin}/invite/${res.code}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(link).catch(() => {});
      }
      setSuccess(`Created and copied to clipboard: ${link}`);
      setWording("");
      setLabel("");
      setMaxUses("");
      await fetchInvites();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm("Revoke this invite link? Anyone who hasn't redeemed it yet will not be able to use it.")) return;
    try {
      await api(`/api/hosts/invites/${id}`, { method: "DELETE" });
      await fetchInvites();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleCopy(inv) {
    const link = inv.invite_url || `${window.location.origin}/invite/${inv.code}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(link).catch(() => {});
    }
    setCopiedId(inv.id);
    setTimeout(() => setCopiedId(null), 2500);
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <form className="nxa-card" onSubmit={handleCreate} style={{ display: "grid", gap: 14 }}>
        <div className="nxa-card-head" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>Create Custom "savestate" Invite Link</h3>
            <p className="nxa-dim" style={{ marginTop: 4 }}>
              Invite friends, family, or your own remote devices to connect directly to your SaveState host server.
            </p>
          </div>
        </div>

        <div className="nxau-grid">
          <div className="nxau-box">
            <h4>Custom Name / Wording</h4>
            <input
              className="nxa-input sm"
              placeholder="e.g. family, livingroom, retro-club"
              value={wording}
              onChange={(e) => setWording(e.target.value)}
              maxLength={60}
            />
            <span className="nxau-sub">
              Live link: <code style={{ color: "var(--acc)", fontWeight: 700 }}>{previewUrl}</code>
            </span>
          </div>

          <div className="nxau-box">
            <h4>Label &amp; Membership Plan</h4>
            <input
              className="nxa-input sm"
              placeholder="Label (optional, e.g. For Mike)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
            />
            <select className="nxa-input sm" value={tier} onChange={(e) => setTier(e.target.value)}>
              {data.tiers.map((t) => (
                <option key={t} value={t}>Plan: {t}</option>
              ))}
            </select>
          </div>

          <div className="nxau-box">
            <h4>Usage &amp; Expiration</h4>
            <input
              type="number"
              min="1"
              className="nxa-input sm"
              placeholder="Max uses (blank = unlimited)"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />
            <select className="nxa-input sm" value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)}>
              <option value="0">Never expires</option>
              <option value="24">Expires in 24 hours</option>
              <option value="72">Expires in 3 days</option>
              <option value="168">Expires in 7 days</option>
              <option value="720">Expires in 30 days</option>
            </select>
          </div>
        </div>

        {error && <Note kind="bad">{error}</Note>}
        {success && <Note kind="ok">{success}</Note>}

        <div className="nxa-row">
          <button type="submit" className="nxa-btn primary" disabled={busy}>
            {busy ? <Icon name="spinner" /> : <Icon name="plus" />} Create &amp; Copy Invite Link
          </button>
        </div>
      </form>

      <div className="nxa-card" style={{ display: "grid", gap: 12 }}>
        <div className="nxa-card-head" style={{ marginBottom: 0 }}>
          <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>Active Invite Links ({invites.length})</h3>
        </div>

        {loading && <p className="nxa-dim"><Icon name="spinner" /> Loading invite links…</p>}

        {!loading && !invites.length && (
          <p className="nxa-dim">No custom invite links created yet. Generate one above to invite devices or friends to your SaveState library.</p>
        )}

        <div className="nxau-list">
          {invites.map((inv) => {
            const fullUrl = inv.invite_url || `${window.location.origin}/invite/${inv.code}`;
            const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date();
            const isFull = inv.max_uses && inv.use_count >= inv.max_uses;
            const isCopied = copiedId === inv.id;

            return (
              <div key={inv.id} className="nxau-row" style={{ padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 800, fontSize: 15, fontFamily: "ui-monospace, monospace" }}>
                        {inv.code}
                      </span>
                      <span className="nxa-pill acc">{inv.tier || "free"}</span>
                      {inv.label && <span className="nxa-pill">{inv.label}</span>}
                      {isExpired && <span className="nxa-pill bad">Expired</span>}
                      {isFull && <span className="nxa-pill warn">Usage Limit Reached</span>}
                    </div>

                    <div className="nxau-link" style={{ marginTop: 8, maxWidth: 540 }}>
                      {fullUrl}
                    </div>

                    <div className="nxau-pills" style={{ marginTop: 8 }}>
                      <span className="nxau-sub">
                        Uses: <b>{inv.use_count || 0}</b>{inv.max_uses ? ` / ${inv.max_uses}` : " (unlimited)"}
                      </span>
                      <span className="nxau-sub">·</span>
                      <span className="nxau-sub">
                        {inv.expires_at ? `Expires ${when(inv.expires_at)}` : "Never expires"}
                      </span>
                      <span className="nxau-sub">·</span>
                      <span className="nxau-sub">Created {when(inv.created_at)}</span>
                    </div>
                  </div>

                  <div className="nxa-row" style={{ gap: 8 }}>
                    <button className="nxa-btn sm" onClick={() => handleCopy(inv)}>
                      <Icon name={isCopied ? "check" : "copy"} /> {isCopied ? "Copied!" : "Copy"}
                    </button>
                    <button className="nxa-btn sm" style={{ color: "var(--bad)" }} onClick={() => handleDelete(inv.id)}>
                      <Icon name="trash" /> Revoke
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Devices & Streams ─────────────────────────────────────────────────────
function StreamsTab({ data }) {
  const [streams, setStreams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stoppingKey, setStoppingKey] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const userById = useMemo(() => {
    return Object.fromEntries(data.users.map((u) => [String(u.id), u]));
  }, [data.users]);

  const loadStreams = useCallback(async () => {
    try {
      const res = await api("/api/admin/streams");
      setStreams(Array.isArray(res.streams) ? res.streams : []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStreams();
    const timer = setInterval(loadStreams, 8000);
    return () => clearInterval(timer);
  }, [loadStreams]);

  async function handleStop(s) {
    setStoppingKey(s.key);
    setError("");
    setMsg("");
    try {
      await api("/api/admin/streams/stop", {
        method: "POST",
        body: { key: s.key, account: s.account, device: s.device },
      });
      setMsg(`Playback disconnected on ${s.label}.`);
      await loadStreams();
    } catch (e) {
      setError(e.message);
    } finally {
      setStoppingKey(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
        <div className="nxa-card-head" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>Live Screens &amp; Active Playback</h3>
            <p className="nxa-dim" style={{ marginTop: 4 }}>
              Monitor active video and game streams running across connected client devices. You can disconnect any screen to free up capacity.
            </p>
          </div>
          <button className="nxa-btn sm" onClick={loadStreams} disabled={loading}>
            <Icon name="spinner" /> Refresh
          </button>
        </div>

        {error && <Note kind="bad">{error}</Note>}
        {msg && <Note kind="ok">{msg}</Note>}

        {loading && !streams.length && (
          <p className="nxa-dim"><Icon name="spinner" /> Checking active streams…</p>
        )}

        {!loading && !streams.length && (
          <div style={{ padding: "24px 16px", textAlign: "center", background: "rgba(255,255,255,.02)", borderRadius: 12, border: "1px dashed var(--line)" }}>
            <p style={{ fontWeight: 800, fontSize: 16, margin: 0 }}>No active streams right now</p>
            <p className="nxa-dim" style={{ marginTop: 6, fontSize: 13 }}>
              When users watch movies, stream games, or connect devices to your host, their live sessions and screens will be listed here.
            </p>
          </div>
        )}

        <div className="nxau-list">
          {streams.map((s) => {
            const user = userById[s.account];
            const userName = user ? (user.display_name || user.username) : (s.who || `Account #${s.account}`);
            const durationMin = Math.max(1, Math.round((Date.now() - s.since) / 60000));
            const isStopping = stoppingKey === s.key;

            return (
              <div key={s.key} className="nxau-row" style={{ padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 8px #22c55e" }} />
                      <span style={{ fontWeight: 800, fontSize: 15 }}>{s.label}</span>
                      <span className="nxa-pill acc">{userName}</span>
                      {s.openCount > 0 && <span className="nxa-pill ok">{s.openCount} feed{s.openCount === 1 ? "" : "s"}</span>}
                    </div>

                    <div style={{ marginTop: 6, fontSize: 13.5, fontWeight: 700, color: "#fff" }}>
                      {s.title || "Active media playback"}
                    </div>

                    <div className="nxau-pills" style={{ marginTop: 6 }}>
                      <span className="nxau-sub">Streaming for {durationMin} min</span>
                      <span className="nxau-sub">·</span>
                      <span className="nxau-sub">Device ID: <code style={{ fontSize: 11 }}>{s.device}</code></span>
                    </div>
                  </div>

                  <div>
                    <button
                      className="nxa-btn sm"
                      style={{ color: "var(--bad)" }}
                      disabled={isStopping}
                      onClick={() => handleStop(s)}
                    >
                      <Icon name="x" /> {isStopping ? "Disconnecting…" : "Stop Stream"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="nxa-card" style={{ display: "grid", gap: 14 }}>
        <div className="nxa-card-head" style={{ marginBottom: 0 }}>
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>SaveState Everywhere: Client Installers</h3>
            <p className="nxa-dim" style={{ marginTop: 4 }}>
              Equip all your devices with official SaveState native builds to connect to this server.
            </p>
          </div>
        </div>

        <div className="nxau-grid">
          <div className="nxau-box">
            <h4 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 16 }}>🪟</span> Windows Desktop
            </h4>
            <p className="nxau-sub">Direct hardware acceleration, full Dolphin &amp; PS2/GC emulator support, remote streaming.</p>
            <a href="/api/downloads/desktop?platform=windows" className="nxa-btn sm primary" download style={{ textDecoration: "none", textAlign: "center" }}>
              Download Windows App (.exe)
            </a>
          </div>

          <div className="nxau-box">
            <h4 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 16 }}>📱</span> Android Mobile &amp; Tablet
            </h4>
            <p className="nxau-sub">Full APK v1.0.70 with gamepad Bluetooth controller support and persistent scoped storage.</p>
            <a href="/api/downloads/apk" className="nxa-btn sm primary" download style={{ textDecoration: "none", textAlign: "center" }}>
              Download Android APK
            </a>
          </div>

          <div className="nxau-box">
            <h4 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 16 }}>🐧</span> Linux / Steam Deck
            </h4>
            <p className="nxau-sub">Debian/Ubuntu package and automated shell installer with standalone emulator support.</p>
            <a href="/api/downloads/desktop?platform=linux" className="nxa-btn sm primary" download style={{ textDecoration: "none", textAlign: "center" }}>
              Download Linux Package (.deb)
            </a>
          </div>

          <div className="nxau-box">
            <h4 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 16 }}>🎮</span> PlayStation Vita
            </h4>
            <p className="nxau-sub">Native homebrew VPK v1.1 + dedicated lightweight handheld web portal.</p>
            <div style={{ display: "flex", gap: 6 }}>
              <a href="/api/downloads/vita" className="nxa-btn sm primary" download style={{ flex: 1, textDecoration: "none", textAlign: "center" }}>
                Download VPK
              </a>
              <a href="/vita" className="nxa-btn sm" target="_blank" rel="noreferrer" style={{ textDecoration: "none", textAlign: "center" }}>
                Web Portal
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
