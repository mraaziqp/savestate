#!/usr/bin/env node
// Accounts, access and plans, end to end against a running host.
//
//   node scripts/test-accounts-plans.mjs            (AUDIT_BASE=http://host:3000 to point elsewhere)
//
// Covers sign-up rules, sign-in by email, what a brand-new member can and
// cannot reach, that invites between ordinary accounts grant nothing, tier
// gating (402) and upgrade requests, and password reset including signing
// other sessions out. It creates two throwaway accounts and one throwaway
// tier, and deletes them at the end. Needs .env (JWT_SECRET, DATABASE_URL).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const pg = require("pg");
const jwt = require("jsonwebtoken");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const envOf = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const BASE = process.env.AUDIT_BASE || "http://127.0.0.1:3000";
// A host session (what the PIN login issues) is an admin.
const admin = jwt.sign({ nexus: true, ts: Date.now() }, envOf("JWT_SECRET"), { expiresIn: "20m" });
// Same TLS as the server: the certificate is checked; the URL's sslmode is
// dropped because these settings govern (and it makes pg warn).
const db = () => new pg.Client({
  connectionString: envOf("DATABASE_URL").replace(/([?&])sslmode=[^&]*(&|$)/, (_m, a, b) => (b ? a : "")).replace(/[?&]$/, ""),
  ssl: { rejectUnauthorized: true },
});
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
async function call(method, path, { token, body, cookie } = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
}
const name = "nxtest" + Math.random().toString(36).slice(2, 8);
const email = `${name}@example.com`;
let tierId = null, userId = null;
try {
  let r = await call("GET", `/api/auth/check-username?u=${name}`);
  ok("username is reported free", r.json?.available === true);
  r = await call("POST", "/api/auth/register", { body: { username: name, password: "short" } });
  ok("short password refused", r.status === 400 && r.json?.field === "password", r.json?.error);
  r = await call("POST", "/api/auth/register", { body: { username: name, password: "password123" } });
  ok("common password refused", r.status === 400, r.json?.error);
  r = await call("POST", "/api/auth/register", { body: { username: name, password: "correct horse 42", display_name: "Test Person", email } });
  ok("sign-up works", r.status === 200 && !!r.json?.token, JSON.stringify(r.json?.user ?? r.json).slice(0, 90));
  ok("sign-up sets the session cookie", /nx_session=/.test(r.headers.get("set-cookie") ?? ""));
  userId = r.json?.user?.id;
  let tok = r.json?.token;
  r = await call("GET", `/api/auth/check-username?u=${name}`);
  ok("username now taken, with a suggestion", r.json?.available === false && !!r.json?.suggestion, r.json?.suggestion);
  r = await call("POST", "/api/auth/register", { body: { username: name + "x", password: "correct horse 42", email } });
  ok("duplicate email refused", r.status === 409 && r.json?.field === "email");
  r = await call("POST", "/api/auth/login", { body: { username: email.toUpperCase(), password: "correct horse 42" } });
  ok("sign-in by email, any case", r.status === 200 && !!r.json?.token);
  r = await call("POST", "/api/auth/login", { body: { username: name, password: "wrong password" } });
  ok("wrong password refused", r.status === 401, r.json?.error);

  // What a brand-new member can and cannot reach.
  r = await call("GET", "/api/plans/me", { token: tok });
  ok("new member: free tier, no host library", r.json?.tier?.id === "free" && r.json?.access?.media === false && r.json?.access?.games === false);
  for (const [p, want] of [["/api/media/library", 403], ["/api/music/collection", 403], ["/api/brain/key/reveal", 403], ["/api/fs/roots", 403], ["/api/vault/config", 403], ["/api/admin/plans", 403], ["/api/discover/rows", 200]]) {
    r = await call("GET", p, { token: tok });
    ok(`new member GET ${p} -> ${want}`, r.status === want, String(r.status));
  }
  r = await call("GET", "/api/games", { token: tok });
  ok("new member sees an empty game library", r.status === 200 && Array.isArray(r.json) && r.json.length === 0);
  r = await call("PATCH", "/api/profiles/00000000-0000-4000-8000-000000000000", { token: tok, body: { bio: "x" } });
  ok("cannot edit someone else's profile", r.status === 403, String(r.status));
  r = await call("GET", `/api/music/stream?rel=${encodeURIComponent(path.join(root, ".env"))}`, { cookie: `nx_session=${tok}` });
  ok("music stream refuses non-music paths even when signed in", r.status === 403 || r.status === 404, String(r.status));

  // Self-grant through a friend invite must not work any more.
  r = await call("POST", "/api/friends/invite/generate", { token: tok, body: {} });
  const code = r.json?.code;
  if (code) {
    const second = await call("POST", "/api/auth/register", { body: { username: name + "b", password: "correct horse 42", email: `${name}b@example.com` } });
    const other = second.json?.token;
    r = await call("POST", "/api/friends/invite/accept", { token: other, body: { code } });
    const me = await call("GET", "/api/plans/me", { token: other });
    ok("accepting a non-admin's invite grants no media access", me.json?.access?.media === false, `accept=${r.status}`);
  } else ok("friend invite generated", false, JSON.stringify(r.json));

  // Plans: a tier, a gate, a 402, an upgrade request, approval.
  r = await call("POST", "/api/admin/plans/tiers", { token: admin, body: { name: "E2E Test Tier", priceCents: 4900, period: "month", isPublic: false, checkoutUrl: "https://example.com/pay" } });
  tierId = r.json?.tier?.id;
  ok("admin creates a tier", r.status === 200 && !!tierId, tierId);
  r = await call("POST", "/api/admin/plans/tiers", { token: tok, body: { name: "Nope" } });
  ok("member cannot create a tier", r.status === 403);
  r = await call("PUT", "/api/admin/plans/features/cloud.backup", { token: admin, body: { gated: true, tiers: [tierId] } });
  ok("admin gates Phone backup behind the tier", r.status === 200);
  r = await call("GET", "/api/phone/backup/manifest", { token: tok });
  ok("free member gets 402 on the gated feature", r.status === 402 && r.json?.error === "upgrade_required", r.json?.message);
  r = await call("GET", "/api/plans/me", { token: tok });
  ok("locked tab is reported", r.json?.lockedTabs?.phonebackup?.feature === "cloud.backup" && r.json.lockedTabs.phonebackup.tiers[0] === "E2E Test Tier");
  r = await call("GET", "/api/phone/backup/manifest", { token: admin });
  ok("admin is never gated", r.status !== 402, String(r.status));
  r = await call("POST", "/api/plans/request", { token: tok, body: { tierId } });
  ok("member asks for the tier, gets the payment link", r.status === 200 && r.json?.checkoutUrl === "https://example.com/pay");
  r = await call("GET", "/api/admin/plans", { token: admin });
  const request = r.json?.requests?.find((x) => x.username === name);
  ok("admin sees the upgrade request", !!request);
  r = await call("POST", `/api/admin/plans/requests/${request?.id}`, { token: admin, body: { action: "approve" } });
  ok("admin approves", r.status === 200);
  r = await call("GET", "/api/phone/backup/manifest", { token: tok });
  ok("upgraded member is let through", r.status !== 402, String(r.status));
  r = await call("PUT", `/api/admin/plans/users/${userId}`, { token: admin, body: { expiresAt: "2020-01-01T00:00:00Z" } });
  r = await call("GET", "/api/phone/backup/manifest", { token: tok });
  ok("an expired tier falls back to the default", r.status === 402, String(r.status));
  r = await call("PUT", "/api/admin/plans/features/cloud.backup", { token: admin, body: { gated: false, tiers: [] } });
  ok("gate removed", r.status === 200);

  // Forgot / reset, and signing other devices out.
  r = await call("POST", "/api/auth/forgot", { body: { identifier: email } });
  ok("forgot answers the same for everyone", r.status === 200 && r.json?.ok === true, r.json?.message);
  r = await call("GET", "/api/admin/reset-requests", { token: admin });
  ok("reset request queued for the admin (no mail service)", !!r.json?.requests?.find((x) => x.username === name));
  r = await call("POST", "/api/auth/admin-reset-link", { token: admin, body: { username: name } });
  const resetToken = new URL(r.json?.link ?? "http://x/?reset=").searchParams.get("reset");
  ok("admin creates a reset link", !!resetToken);
  r = await call("POST", "/api/auth/reset", { body: { token: resetToken, password: "abc" } });
  ok("reset refuses a weak password", r.status === 400, r.json?.error);
  await new Promise((res) => setTimeout(res, 6000));   // the 5 s grace the revocation check allows
  r = await call("POST", "/api/auth/reset", { body: { token: resetToken, password: "a much better passphrase" } });
  ok("reset works", r.status === 200 && r.json?.username === name);
  r = await call("POST", "/api/auth/reset", { body: { token: resetToken, password: "a much better passphrase 2" } });
  ok("reset link works once", r.status === 400);
  r = await call("GET", "/api/auth/me", { token: tok });
  ok("the old session is signed out", r.status === 401 && r.json?.code === "session_expired", `${r.status} ${r.json?.error}`);
  r = await call("POST", "/api/auth/login", { body: { username: name, password: "a much better passphrase" } });
  ok("new password signs in", r.status === 200);
  tok = r.json?.token;
  r = await call("POST", "/api/auth/change-password", { token: tok, body: { current: "nope", next: "another fine passphrase" } });
  ok("change-password needs the current one", r.status === 401);
  r = await call("POST", "/api/auth/refresh", { token: tok });
  ok("session refresh returns a token", r.status === 200 && !!r.json?.token);
} finally {
  // Clean up the throwaway account and tier.
  if (tierId) await call("DELETE", `/api/admin/plans/tiers/${tierId}`, { token: admin });
  const c = db();
  await c.connect();
  await c.query("DELETE FROM plan_upgrade_requests WHERE tier_id LIKE 'e2e-test-tier%'");
  await c.query("DELETE FROM friend_invites WHERE from_username LIKE 'nxtest%'").catch(() => {});
  await c.query("DELETE FROM friendships WHERE friend_username LIKE 'nxtest%' OR user_id::text = $1", [String(userId ?? "-")]).catch(() => {});
  // The test's own changes appear in the Activity log; they don't belong there.
  await c.query("DELETE FROM activity_receipts WHERE title LIKE 'nxtest%'").catch(() => {});
  const del = await c.query("DELETE FROM users WHERE username LIKE 'nxtest%' AND email LIKE '%@example.com' RETURNING username");
  await c.end();
  console.log(`cleanup: removed ${del.rowCount} test account(s)${tierId ? " and the test tier" : ""}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
