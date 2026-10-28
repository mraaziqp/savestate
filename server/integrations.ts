// Connections (admin page): whether Jarvis, the Agent Builder and the NAS
// host are live, and a log of what passes between them and SaveState.
//
// Status comes from each service's own health address, checked at most every
// 15 s (Jarvis answers 401 to an unsigned health check: that still means it's
// up). The log keeps the last 400 events in memory:
//   - every request that signs in with the brain key (Jarvis, Second Brain):
//     method, path, answer, time taken; the key itself is never kept;
//   - the in-app Jarvis routes (/api/ai/*) whoever calls them;
//   - lines the server logs about them (sources "ai", "minigames", "brain").
import type express from "express";

export type IntegrationEvent = {
  at: number;
  service: string;
  direction: "in" | "out" | "note";
  summary: string;
  status?: number;
  ms?: number;
  ok: boolean;
};

type Service = { id: string; name: string; what: string; url: string; health: string; parse?: (body: any, status: number) => { state: "up" | "degraded" | "down"; detail: string } };

export function createIntegrations(deps: {
  brainKey: () => string;
  isAdmin: (req: express.Request) => Promise<boolean>;
}) {
  const events: IntegrationEvent[] = [];
  const record = (e: Omit<IntegrationEvent, "at">) => {
    events.push({ at: Date.now(), ...e });
    if (events.length > 400) events.splice(0, events.length - 400);
  };

  const services: Service[] = [
    {
      id: "jarvis", name: "Jarvis", what: "The assistant: sends commands and questions to SaveState with the brain key.",
      url: process.env.JARVIS_URL ?? "http://127.0.0.1:3005", health: "/api/health",
      parse: (_b, status) => status === 401 || status === 200 ? { state: "up", detail: status === 401 ? "running (its health check needs Jarvis's own sign-in)" : "running" } : { state: "down", detail: `answered ${status}` },
    },
    {
      id: "agent-builder", name: "Agent Builder", what: "Builds the Mini Games SaveState puts on the shelf; Jarvis orders games through it.",
      url: process.env.AGENT_BUILDER_URL ?? "http://127.0.0.1:4000", health: "/api/health",
      parse: (b, status) => {
        if (status !== 200) return { state: "down", detail: `answered ${status}` };
        const bad = Object.entries(b?.components ?? {}).filter(([, c]: [string, any]) => c?.status && c.status !== "ok").map(([k, c]: [string, any]) => `${k}: ${c.status}`);
        return { state: b?.status === "ok" ? "up" : "degraded", detail: bad.length ? bad.join(", ") : String(b?.status ?? "ok") };
      },
    },
    {
      id: "nas", name: "NAS host", what: "The QNAP's copy of SaveState: serves the site when this PC is off (failover).",
      url: process.env.NEXUS_NAS_URL ?? "http://192.168.31.206:3000", health: "/api/health",
      parse: (_b, status) => (status === 200 ? { state: "up", detail: "standing by" } : { state: "down", detail: `answered ${status}` }),
    },
  ];
  let cache: { at: number; list: any[] } | null = null;
  let checking: Promise<any[]> | null = null;
  async function check(): Promise<any[]> {
    if (cache && Date.now() - cache.at < 15_000) return cache.list;
    if (checking) return checking;
    checking = Promise.all(services.map(async (s) => {
      const t0 = Date.now();
      try {
        const r = await fetch(s.url + s.health, { signal: AbortSignal.timeout(5000) });
        const body = await r.json().catch(() => null);
        const p = s.parse ? s.parse(body, r.status) : { state: r.ok ? "up" : "down", detail: String(r.status) };
        return { id: s.id, name: s.name, what: s.what, url: s.url, ...p, ms: Date.now() - t0 };
      } catch (e: any) {
        return { id: s.id, name: s.name, what: s.what, url: s.url, state: "down", detail: e?.name === "TimeoutError" ? "no answer in 5 s" : "not reachable", ms: Date.now() - t0 };
      }
    })).then((list) => {
      // A change of state goes in the log too.
      for (const s of list) {
        const before = cache?.list.find((x) => x.id === s.id);
        if (before && before.state !== s.state) record({ service: s.name, direction: "note", summary: `${before.state} → ${s.state} (${s.detail})`, ok: s.state !== "down" });
      }
      cache = { at: Date.now(), list };
      return list;
    }).finally(() => { checking = null; });
    return checking;
  }

  /** Calls signed with the brain key, and the in-app Jarvis routes. */
  function middleware(): express.RequestHandler {
    return (req, res, next) => {
      const key = deps.brainKey();
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      const viaKey = !!key && (auth === key || String(req.headers["x-brain-key"] ?? "").trim() === key);
      const jarvisRoute = req.path.startsWith("/api/ai/") && req.path !== "/api/ai/stream";
      if (!viaKey && !jarvisRoute) return next();
      const t0 = Date.now();
      res.on("finish", () => {
        record({
          service: viaKey ? "Jarvis / Second Brain" : "Jarvis (in the app)",
          direction: "in",
          summary: `${req.method} ${req.path}`,
          status: res.statusCode,
          ms: Date.now() - t0,
          ok: res.statusCode < 400,
        });
      });
      next();
    };
  }

  /** Server log lines about the assistant and the Agent Builder. */
  function fromLog(level: string, message: string, source: string) {
    if (!/^(ai|minigames|brain|jarvis|agent)$/i.test(source)) return;
    record({ service: /minigames|agent/i.test(source) ? "Agent Builder" : "Jarvis", direction: "note", summary: message.slice(0, 300), ok: !/^(ERROR|WARN)$/i.test(level) });
  }

  function register(app: express.Express) {
    app.get("/api/admin/integrations", async (req, res) => {
      if (!(await deps.isAdmin(req))) return res.status(403).json({ error: "Admins only." });
      res.setHeader("Cache-Control", "no-store");
      const since = Date.now() - 24 * 3600_000;
      const day = events.filter((e) => e.at > since);
      res.json({
        services: await check(),
        events: events.slice(-200).reverse(),
        today: { calls: day.filter((e) => e.direction === "in").length, failed: day.filter((e) => !e.ok).length },
      });
    });
  }

  return { middleware, fromLog, register, record };
}
