/**
 * People (admin): every account on the host and every group, in one place.
 *
 * Groups used to be visible only to whoever created them, so an admin could
 * not see or change the circles another admin made. Here an admin sees all
 * accounts with their role, plan, library access, groups and devices, and can
 * change any of it, send a password link, sign someone out everywhere,
 * suspend or remove an account; and manage every group and its members.
 *
 * Only the ultra admin changes roles. Nobody here can change, suspend or
 * remove their own account or the ultra admin's.
 */
import type express from "express";
import type { Caller } from "./access.ts";
import { receipt } from "./receipts.ts";

export type AdminPeopleDeps = {
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[] | null>;
  callerOf: (req: express.Request) => Promise<Caller>;
  invalidateUser: (userId?: string) => void;
  /** Library access for someone added to an admin's group (server.ts). */
  grantHostAccess: (granterId: string, targetId: string) => Promise<boolean>;
  resetLink: (userId: string) => Promise<string>;
  tierIds: () => string[];
  /** Screens watching now on an account (planlimits.ts). */
  screensOf: (userId: string) => number;
  log: (level: string, msg: string) => void;
};

const SCHEMA = `ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;`;
const ADMIN_ROLES = ["admin", "superadmin", "ultra_admin"];

export function createAdminPeople(deps: AdminPeopleDeps) {
  let schemaReady = false;
  const ensure = async () => { if (!schemaReady) schemaReady = !!(await deps.query(SCHEMA)); return schemaReady; };

  async function adminOf(req: express.Request, res: express.Response): Promise<Caller | null> {
    const c = await deps.callerOf(req);
    if (!c.admin || !c.userId) { res.status(403).json({ error: "admin_only", message: "Only the host's admins can do this." }); return null; }
    await ensure();
    return c;
  }
  const userRow = async (id: string) => (await deps.query("SELECT id, username, role FROM users WHERE id::text=$1", [id]))?.[0] ?? null;
  /** Why this admin may not change that account, or "" when they may. */
  function guard(admin: Caller, target: { id: string; role: string | null }) {
    if (String(target.id) === admin.userId) return "Change your own account from your profile, not here.";
    if (target.role === "ultra_admin") return "The host's owner account can't be changed here.";
    return "";
  }

  function register(app: express.Express) {
    // Everyone, with their groups; and every group.
    app.get("/api/admin/people", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const [users, groups, members] = await Promise.all([
        deps.query(`SELECT id, username, display_name, email, role, user_tier, tier_expires_at, media_access, games_access,
                           can_upload_media, created_at, last_seen, to_jsonb(users)->>'suspended_at' AS suspended_at
                      FROM users ORDER BY lower(coalesce(display_name, username))`),
        deps.query(`SELECT g.id, g.name, g.description, g.icon, g.color, g.allow_media_access, g.allow_downloads, g.created_at,
                           g.owner_id, u.username AS owner
                      FROM host_groups g LEFT JOIN users u ON u.id = g.owner_id ORDER BY g.created_at`),
        deps.query(`SELECT group_id, user_id, can_download, joined_at FROM host_group_members`),
      ]);
      if (!users) return res.status(503).json({ error: "The database is not reachable right now. Try again in a minute." });
      const byUser = new Map<string, Array<{ id: string; can_download: boolean }>>();
      const count = new Map<string, number>();
      for (const m of members ?? []) {
        const k = String(m.user_id);
        if (!byUser.has(k)) byUser.set(k, []);
        byUser.get(k)!.push({ id: String(m.group_id), can_download: !!m.can_download });
        count.set(String(m.group_id), (count.get(String(m.group_id)) ?? 0) + 1);
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        me: { id: admin.userId, ultra: admin.role === "ultra_admin" },
        tiers: deps.tierIds(),
        users: users.map((u: any) => ({ ...u, groups: byUser.get(String(u.id)) ?? [], screens: deps.screensOf(String(u.id)) })),
        groups: (groups ?? []).map((g: any) => ({ ...g, members: count.get(String(g.id)) ?? 0 })),
      });
    });

    // Role, name, email, suspension. (Plan and library access: PUT /api/admin/plans/users/:id.)
    app.patch("/api/admin/people/:id", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const target = await userRow(req.params.id);
      if (!target) return res.status(404).json({ error: "That account no longer exists." });
      const why = guard(admin, target);
      if (why) return res.status(400).json({ error: why });
      const b = req.body ?? {};
      const sets: string[] = []; const vals: unknown[] = [target.id];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
      if (b.role !== undefined) {
        if (admin.role !== "ultra_admin") return res.status(403).json({ error: "Only the host's owner can make someone an admin." });
        if (!["user", "admin"].includes(b.role)) return res.status(400).json({ error: "A role is either member or admin." });
        set("role", b.role);
      }
      if (typeof b.display_name === "string") set("display_name", b.display_name.trim().slice(0, 60) || null);
      if (typeof b.email === "string") {
        const e = b.email.trim().toLowerCase();
        if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: "That email address doesn't look right." });
        if (e) {
          const taken = await deps.query("SELECT 1 FROM users WHERE lower(email)=$1 AND id::text<>$2", [e, target.id]);
          if (taken?.length) return res.status(409).json({ error: "Another account already uses that email." });
        }
        set("email", e || null);
      }
      if (typeof b.suspended === "boolean") {
        set("suspended_at", b.suspended ? new Date() : null);
        // Suspending also ends every session on every device.
        if (b.suspended) sets.push("password_changed_at=NOW()");
      }
      if (!sets.length) return res.status(400).json({ error: "Nothing to change." });
      const r = await deps.query(`UPDATE users SET ${sets.join(", ")} WHERE id::text=$1 RETURNING id, username`, vals);
      if (!r?.length) return res.status(500).json({ error: "Could not save. Please try again." });
      deps.invalidateUser(String(target.id));
      const what = Object.keys(b).filter((k) => ["role", "display_name", "email", "suspended"].includes(k));
      deps.log("INFO", `${admin.username} changed ${target.username}: ${what.join(", ")}`);
      receipt({ kind: "plan", userId: String(target.id), actor: admin.username,
        title: `${target.username}: ${typeof b.suspended === "boolean" ? (b.suspended ? "suspended" : "unsuspended") : what.join(", ").replace(/_/g, " ") + " changed"}`,
        detail: b.role ? `Role: ${b.role === "admin" ? "admin" : "member"}` : "" });
      res.json({ ok: true });
    });

    // Sign out on every device (the next request from any of them is refused).
    app.post("/api/admin/people/:id/sign-out", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const target = await userRow(req.params.id);
      if (!target) return res.status(404).json({ error: "That account no longer exists." });
      const why = guard(admin, target); if (why) return res.status(400).json({ error: why });
      await deps.query("UPDATE users SET password_changed_at=NOW() WHERE id::text=$1", [target.id]);
      deps.invalidateUser(String(target.id));
      deps.log("INFO", `${admin.username} signed ${target.username} out everywhere`);
      res.json({ ok: true });
    });

    // A one-hour link to choose a new password, for the admin to send.
    app.post("/api/admin/people/:id/reset-link", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const target = await userRow(req.params.id);
      if (!target) return res.status(404).json({ error: "That account no longer exists." });
      if (target.role === "ultra_admin" && String(target.id) !== admin.userId) return res.status(400).json({ error: "The host's owner account can't be changed here." });
      try { res.json({ ok: true, link: await deps.resetLink(String(target.id)), expiresInMinutes: 60 }); }
      catch { res.status(500).json({ error: "Could not make a link. Please try again." }); }
    });

    // Remove an account for good.
    app.delete("/api/admin/people/:id", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const target = await userRow(req.params.id);
      if (!target) return res.status(404).json({ error: "That account no longer exists." });
      const why = guard(admin, target); if (why) return res.status(400).json({ error: why });
      if (String(req.body?.confirm ?? req.query.confirm ?? "") !== target.username) return res.status(400).json({ error: `Type ${target.username} to confirm.` });
      for (const sql of [
        "DELETE FROM host_group_members WHERE user_id::text=$1",
        "DELETE FROM host_groups WHERE owner_id::text=$1",
        "DELETE FROM host_access_requests WHERE requester_id::text=$1",
        "DELETE FROM plan_upgrade_requests WHERE user_id::text=$1",
        "DELETE FROM password_reset_requests WHERE user_id::text=$1",
      ]) await deps.query(sql, [target.id]);
      const r = await deps.query("DELETE FROM users WHERE id::text=$1 RETURNING id", [target.id]);
      if (!r?.length) return res.status(409).json({ error: "This account still has data linked to it and couldn't be removed. Suspend it instead." });
      deps.invalidateUser(String(target.id));
      deps.log("INFO", `${admin.username} removed the account ${target.username}`);
      receipt({ kind: "plan", actor: admin.username, title: `Account removed: ${target.username}`, detail: "" });
      res.json({ ok: true });
    });

    // ── Groups (any admin, any group) ─────────────────────────────────────
    const groupBody = (b: any) => ({
      name: typeof b.name === "string" ? b.name.trim().slice(0, 60) : undefined,
      description: typeof b.description === "string" ? b.description.trim().slice(0, 200) : undefined,
      icon: typeof b.icon === "string" ? b.icon.slice(0, 8) : undefined,
      color: typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : undefined,
      allow_media_access: typeof b.allow_media_access === "boolean" ? b.allow_media_access : undefined,
      allow_downloads: typeof b.allow_downloads === "boolean" ? b.allow_downloads : undefined,
    });
    app.post("/api/admin/groups", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const g = groupBody(req.body ?? {});
      if (!g.name) return res.status(400).json({ error: "Give the group a name." });
      const r = await deps.query(
        `INSERT INTO host_groups (name, description, icon, color, owner_id, allow_media_access, allow_downloads)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [g.name, g.description ?? "", g.icon ?? "👥", g.color ?? "#4d7cff", admin.userId, g.allow_media_access ?? true, g.allow_downloads ?? true]);
      if (!r?.length) return res.status(500).json({ error: "Could not create the group." });
      res.json({ ok: true, id: r[0].id });
    });
    app.patch("/api/admin/groups/:id", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const g = groupBody(req.body ?? {});
      if (g.name === "") return res.status(400).json({ error: "A group needs a name." });
      const sets: string[] = []; const vals: unknown[] = [req.params.id];
      for (const [k, v] of Object.entries(g)) if (v !== undefined) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
      if (!sets.length) return res.status(400).json({ error: "Nothing to change." });
      const r = await deps.query(`UPDATE host_groups SET ${sets.join(", ")} WHERE id::text=$1 RETURNING id`, vals);
      if (!r?.length) return res.status(404).json({ error: "That group no longer exists." });
      res.json({ ok: true });
    });
    app.delete("/api/admin/groups/:id", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      await deps.query("DELETE FROM host_group_members WHERE group_id::text=$1", [req.params.id]);
      const r = await deps.query("DELETE FROM host_groups WHERE id::text=$1 RETURNING name", [req.params.id]);
      if (!r?.length) return res.status(404).json({ error: "That group no longer exists." });
      deps.log("INFO", `${admin.username} deleted the group ${r[0].name}`);
      res.json({ ok: true });
    });
    app.post("/api/admin/groups/:id/members", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      const g = (await deps.query("SELECT id, owner_id, name, allow_media_access FROM host_groups WHERE id::text=$1", [req.params.id]))?.[0];
      if (!g) return res.status(404).json({ error: "That group no longer exists." });
      const ids: string[] = (Array.isArray(req.body?.userIds) ? req.body.userIds : [req.body?.userId]).map(String).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x));
      if (!ids.length) return res.status(400).json({ error: "Choose who to add." });
      for (const uid of ids) {
        await deps.query(
          `INSERT INTO host_group_members (group_id, user_id, added_by, can_download) VALUES ($1,$2,$3,$4)
           ON CONFLICT (group_id, user_id) DO NOTHING`, [g.id, uid, admin.userId, req.body?.can_download !== false]);
        // A group that opens the library opens it for its members (as before).
        if (g.allow_media_access) await deps.grantHostAccess(String(g.owner_id ?? admin.userId), uid);
        deps.invalidateUser(uid);
      }
      res.json({ ok: true });
    });
    app.patch("/api/admin/groups/:id/members/:userId", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      if (typeof req.body?.can_download !== "boolean") return res.status(400).json({ error: "Nothing to change." });
      await deps.query("UPDATE host_group_members SET can_download=$1 WHERE group_id::text=$2 AND user_id::text=$3", [req.body.can_download, req.params.id, req.params.userId]);
      res.json({ ok: true });
    });
    app.delete("/api/admin/groups/:id/members/:userId", async (req, res) => {
      const admin = await adminOf(req, res); if (!admin) return;
      await deps.query("DELETE FROM host_group_members WHERE group_id::text=$1 AND user_id::text=$2", [req.params.id, req.params.userId]);
      deps.invalidateUser(req.params.userId);
      res.json({ ok: true });
    });
  }

  return { register, ensure, ADMIN_ROLES };
}
