// Host performance tracker (admin): how this host is running, every 30 s for
// the last 24 h, so the owner can see whether the NAS copes on its own.
//
// Each sample: requests answered (count, 5xx errors, median and 95th
// percentile time), how many came through Cloudflare (the public site),
// CPU use, load, memory (system and this process), event-loop delay (the
// server's own responsiveness: high means requests wait), and free disk on
// the data folder. GET /api/host/perf answers for this host;
// GET /api/host/perf/nas asks the NAS over the home network (same sign-in),
// so the PC's page shows both, and when the PC is off the NAS serves the
// page and its own numbers.
import type express from "express";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

export type PerfSample = {
  at: number;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  publicRequests: number;
  cpu: number;
  load1: number;
  memUsedPct: number;
  rssMB: number;
  heapMB: number;
  loopP99: number;
  loopMax: number;
  diskFreeGB: number | null;
};

const EVERY_MS = 30_000;
const KEEP = (24 * 3600_000) / EVERY_MS;

export function createPerf(deps: { isAdmin: (req: express.Request) => Promise<boolean>; version: string; dataDir: string; nasUrl: string }) {
  const history: PerfSample[] = [];
  let times: number[] = [];
  let errors = 0, publicHits = 0;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
  let lastCpu = cpuTimes();
  let diskFreeGB: number | null = null;
  const startedAt = Date.now();

  async function readDisk() {
    try {
      const s: any = await (fsp as any).statfs?.(deps.dataDir);
      if (s) diskFreeGB = Math.round((Number(s.bavail) * Number(s.bsize)) / 1e8) / 10;
    } catch { /* statfs needs Node 18.15+; the field stays empty */ }
  }
  void readDisk();
  setInterval(() => void readDisk(), 5 * 60_000).unref();

  function sample() {
    const sorted = times.slice().sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    const now = cpuTimes();
    const dTotal = now.total - lastCpu.total, dIdle = now.idle - lastCpu.idle;
    lastCpu = now;
    const mem = process.memoryUsage();
    history.push({
      at: Date.now(),
      requests: sorted.length,
      errors,
      p50: Math.round(pct(0.5)),
      p95: Math.round(pct(0.95)),
      publicRequests: publicHits,
      cpu: dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0,
      load1: Math.round(os.loadavg()[0] * 100) / 100,
      memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      rssMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
      loopP99: Math.round(loop.percentile(99) / 1e6),
      loopMax: Math.round(loop.max / 1e6),
      diskFreeGB,
    });
    if (history.length > KEEP) history.splice(0, history.length - KEEP);
    times = [];
    errors = 0;
    publicHits = 0;
    loop.reset();
  }
  setInterval(sample, EVERY_MS).unref();

  // What a glance should say: the worst of the last 5 minutes.
  function verdict() {
    const recent = history.slice(-10);
    if (!recent.length) return { state: "starting", notes: ["Measuring: the first numbers arrive within 30 s."] };
    const notes: string[] = [];
    const worst = (k: keyof PerfSample) => Math.max(...recent.map((s) => Number(s[k]) || 0));
    if (worst("p95") > 3000) notes.push(`Slow answers: 1 in 20 took over ${Math.round(worst("p95") / 100) / 10} s.`);
    if (worst("loopP99") > 500) notes.push(`The server stalled for up to ${worst("loopMax")} ms at a time.`);
    if (worst("memUsedPct") > 92) notes.push(`Memory nearly full (${worst("memUsedPct")}%).`);
    const errs = recent.reduce((n, s) => n + s.errors, 0), reqs = recent.reduce((n, s) => n + s.requests, 0);
    if (errs > 5 && errs > reqs * 0.05) notes.push(`${errs} failed answers (server errors) in 5 minutes.`);
    const disk = recent[recent.length - 1].diskFreeGB;
    if (disk != null && disk < 5) notes.push(`Only ${disk} GB free on the data disk.`);
    return { state: notes.length ? (notes.length > 1 || worst("p95") > 8000 ? "struggling" : "busy") : "good", notes };
  }

  function report() {
    return {
      host: {
        name: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        node: process.version,
        version: deps.version,
        cpus: os.cpus().length,
        memTotalMB: Math.round(os.totalmem() / 1048576),
        lowMemory: process.env.NEXUS_LOW_MEMORY === "1",
        upSince: startedAt,
        servingPublic: history.slice(-10).some((s) => s.publicRequests > 0),
      },
      verdict: verdict(),
      everySeconds: EVERY_MS / 1000,
      history,
    };
  }

  return {
    // Times every answer (not the tracker's own polling).
    middleware(): express.RequestHandler {
      return (req, res, next) => {
        if (req.path.startsWith("/api/host/perf")) return next();
        const t = process.hrtime.bigint();
        if (req.headers["cf-connecting-ip"]) publicHits++;
        res.on("finish", () => {
          times.push(Number(process.hrtime.bigint() - t) / 1e6);
          if (res.statusCode >= 500) errors++;
          if (times.length > 20000) times.splice(0, times.length - 20000);
        });
        next();
      };
    },
    register(app: express.Express) {
      app.get("/api/host/perf", async (req, res) => {
        if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Owner only." });
        res.setHeader("Cache-Control", "no-store");
        res.json(report());
      });
      // The NAS's numbers, asked over the home network with the same sign-in.
      app.get("/api/host/perf/nas", async (req, res) => {
        if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Owner only." });
        res.setHeader("Cache-Control", "no-store");
        const t = Date.now();
        try {
          const r = await fetch(`${deps.nasUrl}/api/host/perf`, { headers: { authorization: String(req.headers.authorization || "") }, signal: AbortSignal.timeout(8000) });
          if (r.status === 404) return res.json({ reachable: true, ms: Date.now() - t, error: "The NAS runs an older SaveState without the tracker: it needs the update." });
          if (!r.ok) return res.json({ reachable: true, ms: Date.now() - t, error: `The NAS answered ${r.status}.` });
          res.json({ reachable: true, ms: Date.now() - t, ...(await r.json()) });
        } catch (e: any) {
          res.json({ reachable: false, ms: Date.now() - t, error: e?.name === "TimeoutError" ? "The NAS didn't answer in 8 s." : "The NAS isn't answering on the home network." });
        }
      });
    },
  };
}
