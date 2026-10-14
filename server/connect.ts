/**
 * Connecting cloud drives from the app, with buttons only.
 *
 * Google Drive: a normal "Sign in with Google" consent screen. The resulting
 * token becomes an rclone remote, so the file manager, uploads and the
 * verify-before-delete jobs work on it exactly as on the host's own drives.
 *   - members connect their own drives ("u_<user id>_<n>" remotes; only they
 *     can open them, see drives.ts);
 *   - admins connect drives to the host (named after the account), or
 *     re-connect an existing remote with the host's own Google app.
 * This needs one OAuth client ("Web application") that the admin creates once
 * in Google Cloud and pastes into the Cloud Drives page; the page walks them
 * through it. It also replaces rclone's shared client ID, which is being
 * retired.
 *
 * Other online drives: anything that speaks WebDAV (Nextcloud, ownCloud,
 * pCloud, Koofr, a NAS ...) connects with an address, user name and password.
 */
import type express from "express";
import crypto from "node:crypto";
import path from "node:path";
import jwt from "jsonwebtoken";
import { readFile, writeFile } from "node:fs/promises";
import { isPersonalRemote, ownerOfRemote } from "./drives.ts";

export type ConnectDeps = {
  persistDir: string;
  jwtSecret: string;
  publicUrl: () => string;
  rc: <T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  callerOf: (req: express.Request) => Promise<{ authed: boolean; admin: boolean; userId: string | null; username: string | null }>;
  encrypt: (v: string) => string;
  decrypt: (v: string) => string;
  log: (level: string, msg: string) => void;
  /** The Google account behind a Drive remote. */
  emailOf?: (remote: string) => Promise<string | null>;
};

const SCOPES = ["https://www.googleapis.com/auth/drive", "openid", "email"];
const slug = (s: string) => s.toLowerCase().replace(/@gmail\.com$/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "drive";

export function createConnect(deps: ConnectDeps) {
  const file = path.join(deps.persistDir, "cloud-connect.json");
  let client: { clientId: string; clientSecret: string } | null = null;
  const load = async () => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      client = raw.clientId ? { clientId: raw.clientId, clientSecret: deps.decrypt(raw.clientSecret) } : null;
    } catch { client = null; }
    if (!client && process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      client = { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID.trim(), clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET.trim() };
    }
  };
  void load();
  const redirectUri = () => `${deps.publicUrl()}/api/drives/oauth/callback`;

  async function remotes(): Promise<Record<string, any>> {
    return deps.rc<Record<string, any>>("config/dump").catch(() => ({}));
  }
  async function nextPersonalName(userId: string) {
    const id = userId.replace(/-/g, "");
    const all = await remotes();
    for (let n = 1; n < 100; n++) if (!all[`u_${id}_${n}`]) return `u_${id}_${n}`;
    throw new Error("Too many connected drives");
  }
  async function describe(name: string, conf: any) {
    const about = await deps.rc("operations/about", { fs: `${name}:` }, 30_000).catch(() => null);
    return {
      name, type: conf.type, label: conf.description || (conf.type === "drive" ? await deps.emailOf?.(name).catch(() => null) : null) || name,
      sharedClient: conf.type === "drive" && !conf.client_id,
      total: about?.total ?? null, used: about?.used ?? null, free: about?.free ?? null,
      ok: !!about,
    };
  }

  function register(app: express.Express) {
    const fail = (res: express.Response, e: any, status = 500) => res.status(status).json({ error: String(e?.message ?? e).slice(0, 300) });

    // What the connect buttons can offer this caller.
    app.get("/api/drives/connect/config", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed) return res.status(401).json({ error: "Sign in first." });
      res.json({ google: !!client, webdav: true, redirectUri: redirectUri(), isAdmin: caller.admin, clientIdHint: client ? `${client.clientId.slice(0, 12)}…` : null });
    });

    // Admin, once: the Google app ("OAuth client ID", Web application).
    app.put("/api/admin/drives/google-app", async (req, res) => {
      const clientId = String(req.body?.clientId ?? "").trim();
      const clientSecret = String(req.body?.clientSecret ?? "").trim();
      if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) return res.status(400).json({ error: "The client ID ends in .apps.googleusercontent.com. Copy it from Google Cloud > Credentials." });
      if (clientSecret.length < 10) return res.status(400).json({ error: "Paste the client secret too." });
      await writeFile(file, JSON.stringify({ clientId, clientSecret: deps.encrypt(clientSecret), savedAt: new Date().toISOString() }, null, 2));
      client = { clientId, clientSecret };
      deps.log("INFO", "Google app for drive connections saved");
      res.json({ ok: true });
    });

    // Start "Sign in with Google". purpose: "personal" (anyone) or "host" (admins).
    app.post("/api/drives/connect/google", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed || !caller.userId && !caller.admin) return res.status(401).json({ error: "Sign in with an account first." });
      if (!client) return res.status(503).json({ error: caller.admin ? "Set up the Google app first (step 1 on this page)." : "The host hasn't switched on Google Drive connections yet." });
      const purpose = req.body?.purpose === "host" ? "host" : "personal";
      if (purpose === "host" && !caller.admin) return res.status(403).json({ error: "Only admins connect drives to the host." });
      if (purpose === "personal" && !caller.userId) return res.status(400).json({ error: "Sign in with an account (not the host PIN) to connect your own drive." });
      const replace = req.body?.replace ? String(req.body.replace) : null;
      if (replace && (purpose !== "host" || isPersonalRemote(replace) || !(await remotes())[replace])) return res.status(400).json({ error: "Can't reconnect that drive." });
      const state = jwt.sign({ p: purpose, u: caller.userId, r: replace, n: crypto.randomBytes(8).toString("hex") }, deps.jwtSecret, { expiresIn: "20m" });
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: client.clientId, redirect_uri: redirectUri(), response_type: "code", scope: SCOPES.join(" "),
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
      }).toString();
      res.json({ url: url.toString() });
    });

    // Google sends the browser back here. Public: the browser carries no
    // token on a redirect; the signed state says who started it.
    app.get("/api/drives/oauth/callback", async (req, res) => {
      const back = (q: Record<string, string>, tab: string) => res.redirect(302, `/?tab=${tab}&${new URLSearchParams(q)}`);
      let st: any;
      try { st = jwt.verify(String(req.query.state ?? ""), deps.jwtSecret); } catch { return back({ drive_error: "That sign-in link expired. Try again." }, "files"); }
      const tab = st.p === "host" ? "cloud" : "files";
      if (req.query.error) return back({ drive_error: req.query.error === "access_denied" ? "Google sign-in was cancelled." : String(req.query.error) }, tab);
      if (!client) return back({ drive_error: "Google connections are not set up on this host." }, tab);
      try {
        const tokRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code: String(req.query.code ?? ""), client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
          signal: AbortSignal.timeout(20_000),
        });
        const tok = await tokRes.json();
        if (!tokRes.ok || !tok.access_token) throw new Error(tok.error_description || tok.error || "Google did not hand over access");
        if (!tok.refresh_token) throw new Error("Google did not grant offline access. Remove the app at myaccount.google.com/permissions and connect again.");
        const email = (() => { try { return JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString()).email as string; } catch { return null; } })();
        const token = JSON.stringify({ access_token: tok.access_token, token_type: "Bearer", refresh_token: tok.refresh_token, expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString() });
        const params = { client_id: client.clientId, client_secret: client.clientSecret, scope: "drive", token, description: email ?? "Google Drive" };
        let name: string;
        if (st.r) {
          name = st.r;
          await deps.rc("config/update", { name, parameters: params, opt: { nonInteractive: true, obscure: true } });
        } else {
          const all = await remotes();
          if (st.p === "personal") name = await nextPersonalName(String(st.u));
          else { name = `g_${slug(email ?? "drive")}`; for (let n = 2; all[name]; n++) name = `g_${slug(email ?? "drive")}_${n}`; }
          await deps.rc("config/create", { name, type: "drive", parameters: params, opt: { nonInteractive: true, obscure: true } });
        }
        deps.log("INFO", `Google Drive ${email ?? ""} ${st.r ? "reconnected" : "connected"} (${st.p === "host" ? "host" : "personal"}: ${name})`);
        back({ drive_connected: email ?? "Google Drive" }, tab);
      } catch (e: any) {
        deps.log("WARN", `Google Drive connection failed: ${e?.message ?? e}`);
        back({ drive_error: String(e?.message ?? e).slice(0, 200) }, tab);
      }
    });

    // WebDAV: Nextcloud, ownCloud, pCloud, Koofr, a NAS...
    app.post("/api/drives/connect/webdav", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed) return res.status(401).json({ error: "Sign in first." });
      const purpose = req.body?.purpose === "host" ? "host" : "personal";
      if (purpose === "host" && !caller.admin) return res.status(403).json({ error: "Only admins connect drives to the host." });
      if (purpose === "personal" && !caller.userId) return res.status(400).json({ error: "Sign in with an account to connect your own drive." });
      const url = String(req.body?.url ?? "").trim();
      if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: "Use the drive's https:// WebDAV address." });
      const vendor = ["nextcloud", "owncloud", "other"].includes(req.body?.vendor) ? req.body.vendor : "other";
      const label = String(req.body?.label ?? new URL(url).hostname).trim().slice(0, 60);
      const name = purpose === "personal" ? await nextPersonalName(caller.userId!) : `w_${slug(label)}`;
      try {
        await deps.rc("config/create", { name, type: "webdav", parameters: { url, vendor, user: String(req.body?.user ?? ""), pass: String(req.body?.pass ?? ""), description: label },
          opt: { nonInteractive: true, obscure: true } });
        // Prove it works before calling it connected.
        await deps.rc("operations/list", { fs: `${name}:`, remote: "", opt: { maxDepth: 1 } }, 30_000);
        deps.log("INFO", `WebDAV drive ${label} connected (${name})`);
        res.json({ ok: true, name });
      } catch (e: any) {
        await deps.rc("config/delete", { name }).catch(() => {});
        fail(res, new Error(`Could not open that drive: ${String(e?.message ?? e).slice(0, 160)}. Check the address, user name and password (some services need an app password).`), 400);
      }
    });

    // A member's own drives.
    app.get("/api/drives/my/accounts", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.userId) return res.json({ accounts: [] });
      const all = await remotes();
      const mine = Object.keys(all).filter((n) => ownerOfRemote(n) === caller.userId!.replace(/-/g, ""));
      res.json({ accounts: await Promise.all(mine.map((n) => describe(n, all[n]))) });
    });
    app.delete("/api/drives/my/accounts/:name", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.userId || ownerOfRemote(req.params.name) !== caller.userId.replace(/-/g, "")) return res.status(403).json({ error: "Not your drive." });
      await deps.rc("config/delete", { name: req.params.name }).catch((e) => fail(res, e));
      if (!res.headersSent) res.json({ ok: true });
    });

    // Admins: the host's drives, with which ones still use rclone's shared Google app.
    app.get("/api/admin/drives/connections", async (_req, res) => {
      const all = await remotes();
      const host = Object.keys(all).filter((n) => !isPersonalRemote(n) && ["drive", "webdav"].includes(all[n].type));
      res.json({ google: !!client, redirectUri: redirectUri(), accounts: await Promise.all(host.map((n) => describe(n, all[n]))),
        personalCount: Object.keys(all).filter(isPersonalRemote).length });
    });
    app.delete("/api/admin/drives/connections/:name", async (req, res) => {
      if (isPersonalRemote(req.params.name)) return res.status(403).json({ error: "Members disconnect their own drives." });
      await deps.rc("config/delete", { name: req.params.name }).catch((e) => fail(res, e));
      if (!res.headersSent) res.json({ ok: true });
    });
  }

  return { register };
}
