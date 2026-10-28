// Which machine serves savestate.co.za, and the switch (Connections page).
//
// The PC and the NAS run the same server. Each one answers for itself:
//   PC   its tunnel runs unless <data>\tunnel.off exists (scripts/windows/
//        run-host.ps1 stops and starts it within seconds);
//   NAS  its tunnel runs while tunnel.on exists, or (tunnel.auto) while the PC
//        is down (deploy/qnap/savestate.sh, checked every 20 s).
// GET/POST /api/host/serving/local read and set that, for the host itself.
// GET/POST /api/host/serving ask both over the home network with the same
// sign-in, so the page works from either. Switching starts the new host's
// tunnel first and stops the old one only once it runs: the site never drops.
//
// On the PC in NAS mode, visitors can still arrive through Agent Builder's
// own connector (same tunnel, its routes point at this PC): those requests
// are passed to the NAS, so all of them get the NAS and this PC stays idle.
import type express from "express";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { writeFile, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

export type Role = "pc" | "nas";

export function createServing(deps: {
  isAdmin: (req: express.Request) => Promise<boolean>;
  log: (level: string, msg: string) => void;
  dataDir: string;
  nasUrl: string;
  pcUrl: string;
}) {
  const base = path.dirname(process.cwd());
  const role: Role = existsSync(path.join(base, "savestate.sh")) ? "nas" : "pc";
  const pcOff = path.join(deps.dataDir, "tunnel.off");
  const nasOn = path.join(base, "tunnel.on");
  const nasAuto = path.join(base, "tunnel.auto");

  // Whether this PC's own connector is running (cached 10 s: it's a process list).
  let pcTunnel: { at: number; running: boolean } = { at: 0, running: false };
  function pcTunnelRunning(): Promise<boolean> {
    if (Date.now() - pcTunnel.at < 10_000) return Promise.resolve(pcTunnel.running);
    return new Promise((resolve) => {
      execFile("powershell", ["-NoProfile", "-Command",
        "@(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -like '*NexusEmuHost*' }).Count"],
        { windowsHide: true, timeout: 15_000 }, (err, out) => {
          const running = !err && Number(String(out).trim()) > 0;
          pcTunnel = { at: Date.now(), running };
          resolve(running);
        });
    });
  }
  async function nasTunnelRunning(): Promise<boolean> {
    const pid = Number((await readFile(path.join(base, "run", "tunnel.pid"), "utf8").catch(() => "")).trim());
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  async function local() {
    if (role === "pc") return { host: "pc" as Role, wantsToServe: !existsSync(pcOff), tunnelRunning: await pcTunnelRunning() };
    const failover = (await readFile(path.join(base, "run", "failover"), "utf8").catch(() => "")).trim() === "1";
    return { host: "nas" as Role, wantsToServe: existsSync(nasOn), auto: existsSync(nasAuto), failover, tunnelRunning: await nasTunnelRunning() };
  }
  async function setLocal(serve: boolean) {
    if (role === "pc") {
      if (serve) await rm(pcOff, { force: true }); else await writeFile(pcOff, `The NAS serves the site (set ${new Date().toISOString()})\n`);
      pcTunnel.at = 0;
    } else if (serve) await writeFile(nasOn, ""); else await rm(nasOn, { force: true });
    deps.log("INFO", `This ${role === "pc" ? "PC" : "NAS"} ${serve ? "serves" : "no longer serves"} savestate.co.za`);
  }

  // The other machine, over the home network, with the caller's sign-in.
  const otherUrl = role === "pc" ? deps.nasUrl : deps.pcUrl;
  async function other(auth: string, body?: { serve: boolean }) {
    try {
      const r = await fetch(`${otherUrl}/api/host/serving/local`, {
        method: body ? "POST" : "GET", headers: { authorization: auth, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 404) return { error: "runs an older SaveState without the switch" };
      if (!r.ok) return { error: `answered ${r.status}` };
      return await r.json();
    } catch { return { error: "isn't answering on the home network" }; }
  }

  async function overview(auth: string) {
    const mine = await local();
    const theirs: any = await other(auth);
    const pc = role === "pc" ? mine : theirs;
    const nas = role === "nas" ? mine : theirs;
    const pcServes = !!pc?.tunnelRunning, nasServes = !!nas?.tunnelRunning;
    return {
      here: role,
      serving: pcServes && nasServes ? "both" : pcServes ? "pc" : nasServes ? "nas" : pc?.error && nas?.error ? "unknown" : "none",
      // What it's set to: the NAS when the PC has handed it over or the NAS is forced on.
      mode: pc?.wantsToServe === false || nas?.wantsToServe ? "nas" : "pc",
      pc, nas,
    };
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let switching: Promise<any> | null = null;
  async function switchTo(to: Role, auth: string) {
    const setOn = async (who: Role, serve: boolean) => (who === role ? setLocal(serve) : other(auth, { serve }));
    const running = async (who: Role) => {
      if (who === role) { if (role === "pc") pcTunnel.at = 0; return (await local()).tunnelRunning; }
      const s: any = await other(auth);
      return !!s?.tunnelRunning;
    };
    const from: Role = to === "pc" ? "nas" : "pc";
    const r: any = await setOn(to, true);
    if (r?.error) throw new Error(`The ${to === "nas" ? "NAS" : "PC"} ${r.error}.`);
    // The NAS checks every 20 s, the PC's watchdog every few: give it 90 s.
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { await wait(3000); up = await running(to); }
    if (!up) {
      await setOn(to, false);
      throw new Error(`The ${to === "nas" ? "NAS" : "PC"}'s tunnel didn't start within 90 s, so the site stays where it was.`);
    }
    await setOn(from, false);
    deps.log("INFO", `savestate.co.za now served by the ${to === "nas" ? "NAS" : "PC"}`);
    return overview(auth);
  }

  // NAS mode on the PC: public requests go to the NAS (checked every 15 s).
  let nasHealthy = { at: 0, ok: false };
  const nasTarget = new URL(deps.nasUrl);
  async function nasOk() {
    if (Date.now() - nasHealthy.at < 15_000) return nasHealthy.ok;
    nasHealthy.at = Date.now();
    nasHealthy.ok = await fetch(`${deps.nasUrl}/api/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
    return nasHealthy.ok;
  }
  const handedOver = () => role === "pc" && existsSync(pcOff);

  // On the NAS: the PC's own work (uploads, conversions, Pause all, torrents,
  // the Arr apps, Jarvis and the Agent Builder) is shown and controlled on the
  // PC, so those requests go there while it answers. With the site on the NAS
  // the Activity page was empty and had no Resume (2026-10-28).
  const PC_WORK = /^\/api\/(activity\/|admin\/(pause-all|offload|video-prep|drives|integrations)|drives\/|torrent\/|arr\/|host\/(game-mode|perf$))/;
  let pcHealthy = { at: 0, ok: false };
  const pcTarget = new URL(deps.pcUrl);
  async function pcOk() {
    if (Date.now() - pcHealthy.at < 15_000) return pcHealthy.ok;
    pcHealthy.at = Date.now();
    pcHealthy.ok = await fetch(`${deps.pcUrl}/api/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
    return pcHealthy.ok;
  }
  const pipeTo = (target: URL, req: express.Request, res: express.Response, next: express.NextFunction, by: string) => {
    const up = http.request({
      hostname: target.hostname, port: target.port || 80, method: req.method, path: req.originalUrl,
      headers: { ...req.headers, "x-forwarded-by": by },
    }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { if (!res.headersSent) next(); else res.destroy(); });
    req.on("aborted", () => up.destroy());
    req.pipe(up);
  };

  return {
    /** On the NAS: the PC's work, asked of the PC (see PC_WORK). */
    pcWorkProxy(): express.RequestHandler {
      return (req, res, next) => {
        if (role !== "nas" || req.headers["x-forwarded-by"] || !PC_WORK.test(req.path)) return next();
        void pcOk().then((ok) => (ok ? pipeTo(pcTarget, req, res, next, "savestate-nas") : next()));
      };
    },
    role,
    handedOver,
    /** For Pause all: move the site, quietly (no caller to ask: uses the token given). */
    switchTo: (to: Role, auth: string) => (switching ??= switchTo(to, auth).finally(() => { switching = null; })),
    publicProxy(): express.RequestHandler {
      return (req, res, next) => {
        if (!req.headers["cf-connecting-ip"] || !handedOver()) return next();
        void nasOk().then((ok) => {
          if (!ok) return next();
          const up = http.request({
            hostname: nasTarget.hostname, port: nasTarget.port || 80, method: req.method, path: req.originalUrl,
            headers: { ...req.headers, "x-forwarded-by": "savestate-pc" },
          }, (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.pipe(res);
          });
          up.on("error", () => { if (!res.headersSent) next(); else res.destroy(); });
          req.on("aborted", () => up.destroy());
          req.pipe(up);
        });
      };
    },
    register(app: express.Express) {
      app.get("/api/host/serving/local", async (req, res) => {
        if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Owner only." });
        res.json(await local());
      });
      app.post("/api/host/serving/local", async (req, res) => {
        if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Owner only." });
        await setLocal(!!req.body?.serve);
        res.json(await local());
      });
      app.get("/api/host/serving", async (req, res) => {
        if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Owner only." });
        res.setHeader("Cache-Control", "no-store");
        res.json({ ...(await overview(String(req.headers.authorization || ""))), switching: !!switching });
      });
      app.post("/api/host/serving", async (req, res) => {
        if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Owner only." });
        const to = req.body?.to === "nas" ? "nas" : req.body?.to === "pc" ? "pc" : null;
        if (!to) return res.status(400).json({ error: "Say pc or nas." });
        try { res.json(await (switching ??= switchTo(to, String(req.headers.authorization || "")).finally(() => { switching = null; }))); }
        catch (e: any) { res.status(409).json({ error: e?.message ?? String(e) }); }
      });
    },
  };
}
