/**
 * Receipts and "happening now".
 *
 * A receipt is a permanent line for something that finished or changed: an
 * upload confirmed on Drive, space freed on the PC, a download completed, a
 * payment, a profile or key change. Any module records one with
 * `receipt({...})` (no wiring needed once `initReceipts` has run); they live
 * in the activity_receipts table and are shown, with live progress for what
 * is still running, under System & Tools > Activity log.
 *
 * Members see their own receipts; admins see everyone's.
 */
import type express from "express";
import type { Caller } from "./access.ts";

export type ReceiptKind = "upload" | "freed" | "download" | "search" | "payment" | "plan" | "profile" | "key" | "library" | "account" | "system";
export type Receipt = {
  kind: ReceiptKind;
  title: string;
  /** Plain-language outcome: "128 files, 42.1 GB, all checksums matched". */
  detail?: string;
  status?: "ok" | "warn" | "failed";
  userId?: string | null;
  actor?: string | null;
  bytes?: number | null;
  amountCents?: number | null;
  currency?: string | null;
  /** Anything else worth keeping (ids, paths). */
  data?: Record<string, unknown>;
};
export type LiveItem = { kind: string; title: string; progress: number | null; detail: string; speed?: number | null; eta?: number | null; status?: string };

type Query = <T = any>(sql: string, params?: unknown[]) => Promise<T[] | null>;
let q: Query | null = null;
let ready: Promise<boolean> | null = null;
const pending: Receipt[] = [];
const liveSources: Array<() => Promise<LiveItem[]> | LiveItem[]> = [];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS activity_receipts (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), kind TEXT NOT NULL, title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ok', user_id TEXT, actor TEXT,
    bytes BIGINT, amount_cents BIGINT, currency TEXT, data JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_activity_receipts_at ON activity_receipts(at DESC);
  CREATE INDEX IF NOT EXISTS idx_activity_receipts_user ON activity_receipts(user_id, at DESC);
`;

async function write(r: Receipt) {
  await q!(`INSERT INTO activity_receipts (kind, title, detail, status, user_id, actor, bytes, amount_cents, currency, data)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [r.kind, r.title.slice(0, 300), (r.detail ?? "").slice(0, 2000), r.status ?? "ok", r.userId ?? null, r.actor ?? null,
     r.bytes ?? null, r.amountCents ?? null, r.currency ?? null, JSON.stringify(r.data ?? {})]);
}

/** Record a receipt. Never throws; queued until the database is ready. */
export function receipt(r: Receipt): void {
  if (!q) { if (pending.length < 500) pending.push(r); return; }
  void (ready ?? Promise.resolve(false)).then(async (ok) => {
    if (ok) await write(r);
    else if (pending.length < 500) pending.push(r);
  }).catch(() => {});
}

/** Something long-running reports its progress here (called on every refresh). */
export function addLiveSource(fn: () => Promise<LiveItem[]> | LiveItem[]) { liveSources.push(fn); }

export function initReceipts(deps: { query: Query; dbUp: () => boolean; callerOf: (req: express.Request) => Promise<Caller>; log: (level: string, msg: string) => void }) {
  q = deps.query;
  const tryInit = async (): Promise<boolean> => {
    if (!deps.dbUp()) return false;
    if (!(await deps.query(SCHEMA))) return false;
    for (const r of pending.splice(0)) await write(r).catch(() => {});
    return true;
  };
  ready = tryInit();
  // The database may come up after the server; keep trying until it does.
  const t = setInterval(() => { void ready!.then((ok) => { if (!ok) ready = tryInit(); else clearInterval(t); }); }, 30_000);
  t.unref?.();

  function register(app: express.Express) {
    app.get("/api/receipts", async (req, res) => {
      const c = await deps.callerOf(req);
      if (!c.authed) return res.status(401).json({ error: "Sign in first." });
      if (!(await ready)) return res.status(503).json({ error: "The activity log is unavailable right now." });
      const all = c.admin && req.query.scope !== "mine";
      const params: unknown[] = [];
      const where: string[] = [];
      if (!all) { params.push(c.userId ?? "-"); where.push(`user_id = $${params.length}`); }
      const kind = String(req.query.kind ?? "");
      if (/^[a-z]+$/.test(kind)) { params.push(kind); where.push(`kind = $${params.length}`); }
      const before = Number(req.query.before);
      if (Number.isFinite(before) && before > 0) { params.push(before); where.push(`id < $${params.length}`); }
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const rows = await deps.query(`SELECT id, at, kind, title, detail, status, user_id, actor, bytes, amount_cents, currency, data FROM activity_receipts
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`, params);
      res.setHeader("Cache-Control", "no-store");
      res.json({ receipts: rows ?? [], scope: all ? "all" : "mine" });
    });

    app.get("/api/activity/live", async (req, res) => {
      const c = await deps.callerOf(req);
      if (!c.admin) return res.status(403).json({ error: "admin_only" });
      const items: LiveItem[] = [];
      for (const s of liveSources) {
        try { items.push(...(await s())); } catch (e: any) { deps.log("WARN", `live activity source failed: ${e?.message ?? e}`); }
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ items });
    });
  }
  return { register };
}
