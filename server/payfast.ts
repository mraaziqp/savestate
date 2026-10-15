/**
 * PayFast: members pay for a tier themselves and it switches on by itself.
 *
 * Flow: the Plans page asks /checkout for a signed PayFast form and submits
 * it, the member pays on PayFast, and PayFast tells /notify (the ITN). Only
 * that notification changes anyone's tier, and only after it has passed
 * every check PayFast documents: our signature, PayFast confirming the data
 * itself (/eng/query/validate), the amount matching what we asked for, and
 * not having been handled before.
 *
 * Billing:
 *  - "once" tiers are paid once and never expire.
 *  - monthly / yearly tiers become a PayFast subscription when a passphrase is
 *    set (PayFast refuses subscriptions without one); each successful charge
 *    extends the tier by one period. Without a passphrase each payment buys
 *    one period, and paying again extends it.
 *
 * .env: PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE (must
 * match PayFast > Settings > Security), PAYFAST_SANDBOX=1 for the test site.
 */
import type express from "express";
import crypto from "node:crypto";
import type { Caller } from "./access.ts";
import { receipt } from "./receipts.ts";

export type PayfastTier = { id: string; name: string; priceCents: number; currency: string; period: "free" | "month" | "year" | "once" };

export type PayfastDeps = {
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[] | null>;
  dbUp: () => boolean;
  callerOf: (req: express.Request) => Promise<Caller>;
  tierById: (id: string) => PayfastTier | undefined;
  publicUrl: () => string;
  invalidateUser: (userId: string) => void;
  log: (level: string, msg: string) => void;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL,
    tier_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'payfast',
    amount_cents INTEGER NOT NULL,
    recurring BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_payment_id TEXT,
    subscription_token TEXT,
    detail JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS payment_events (
    provider_payment_id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL,
    status TEXT NOT NULL,
    amount_cents INTEGER,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

// PHP urlencode(), which is what PayFast signs with: spaces become "+",
// and !'()*~ are escaped too.
const pfEncode = (v: string) => encodeURIComponent(v).replace(/%20/g, "+")
  .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const paramString = (pairs: Array<[string, string]>) => pairs.map(([k, v]) => `${k}=${pfEncode(v.trim())}`).join("&");
const sign = (pairs: Array<[string, string]>, passphrase: string) =>
  crypto.createHash("md5").update(paramString(pairs) + (passphrase ? `&passphrase=${pfEncode(passphrase.trim())}` : "")).digest("hex");
const rand = (n = 16) => crypto.randomBytes(n).toString("hex");
const money = (cents: number) => (cents / 100).toFixed(2);

export function createPayfast(deps: PayfastDeps) {
  const merchantId = () => (process.env.PAYFAST_MERCHANT_ID ?? "").trim();
  const merchantKey = () => (process.env.PAYFAST_MERCHANT_KEY ?? "").trim();
  const passphrase = () => (process.env.PAYFAST_PASSPHRASE ?? "").trim();
  const sandbox = () => process.env.PAYFAST_SANDBOX === "1";
  const host = () => (sandbox() ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za");
  const enabled = () => !!merchantId() && !!merchantKey();
  const canRecur = () => enabled() && !!passphrase();

  let schemaReady = false;
  async function ensureSchema() {
    if (schemaReady) return true;
    if (!deps.dbUp() || !(await deps.query(SCHEMA))) return false;
    schemaReady = true;
    return true;
  }

  /** Give the member the tier: from now, or from the end of what they already have of it. */
  async function grant(payment: any, recurring: boolean) {
    const tier = deps.tierById(payment.tier_id);
    if (!tier) { deps.log("ERROR", `PayFast: paid for tier "${payment.tier_id}", which no longer exists (payment ${payment.id})`); return; }
    const step = tier.period === "year" ? "1 year" : tier.period === "month" ? "1 month" : null;
    // A subscription's next charge lands on the same date; two days' grace
    // keeps the plan from lapsing while PayFast processes it.
    const grace = recurring ? " + interval '2 days'" : "";
    if (!step) {
      await deps.query("UPDATE users SET user_tier=$1, tier_expires_at=NULL WHERE id=$2", [tier.id, payment.user_id]);
    } else {
      await deps.query(
        `UPDATE users SET user_tier=$1, tier_expires_at =
           (CASE WHEN user_tier=$1 AND tier_expires_at > NOW() THEN tier_expires_at ELSE NOW() END) + interval '${step}'${grace}
         WHERE id=$2`, [tier.id, payment.user_id]);
    }
    await deps.query("UPDATE plan_upgrade_requests SET status='approved', resolved_at=NOW(), resolved_by='payfast' WHERE user_id=$1 AND status='pending'", [payment.user_id]).catch(() => null);
    deps.invalidateUser(String(payment.user_id));
  }

  function register(app: express.Express) {
    app.get("/api/payments/config", (_req, res) => {
      res.json({ payfast: enabled(), recurring: canRecur(), sandbox: sandbox(), currency: "ZAR" });
    });

    app.post("/api/payments/payfast/checkout", async (req, res) => {
      const caller = await deps.callerOf(req);
      if (!caller.authed || !caller.userId) return res.status(401).json({ error: "Sign in with an account to pay for a plan." });
      if (!enabled()) return res.status(503).json({ error: "Card payments aren't set up on this host yet." });
      if (!(await ensureSchema())) return res.status(503).json({ error: "Payments are unavailable right now. Try again in a minute." });
      const tier = deps.tierById(String(req.body?.tierId ?? ""));
      if (!tier) return res.status(404).json({ error: "That plan no longer exists." });
      if (tier.priceCents <= 0) return res.status(400).json({ error: "That plan is free." });
      if (tier.currency !== "ZAR") return res.status(400).json({ error: "PayFast only takes payments in rand (ZAR). Ask the host to price this plan in ZAR." });
      if (tier.priceCents < 500) return res.status(400).json({ error: "PayFast's smallest payment is R5.00." });

      const users = await deps.query("SELECT username, display_name, email FROM users WHERE id=$1", [caller.userId]);
      const u = users?.[0];
      if (!u) return res.status(404).json({ error: "Account not found." });
      const recurring = canRecur() && (tier.period === "month" || tier.period === "year");
      const id = `pf_${Date.now().toString(36)}_${rand(6)}`;
      const ok = await deps.query(
        "INSERT INTO payments (id, user_id, tier_id, amount_cents, recurring) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [id, caller.userId, tier.id, tier.priceCents, recurring]);
      if (!ok) return res.status(500).json({ error: "Could not start the payment. Please try again." });

      const base = deps.publicUrl();
      const name = String(u.display_name || u.username || "").trim();
      const what = tier.period === "once" ? "" : tier.period === "year" ? " (1 year)" : " (1 month)";
      // Order matters: PayFast signs the fields in this documented order.
      const pairs: Array<[string, string]> = [
        ["merchant_id", merchantId()],
        ["merchant_key", merchantKey()],
        ["return_url", `${base}/?tab=plans&payment=done`],
        ["cancel_url", `${base}/?tab=plans&payment=cancelled`],
        ["notify_url", `${base}/api/payments/payfast/notify`],
        ...(name ? [["name_first", name.slice(0, 100)] as [string, string]] : []),
        ...(u.email ? [["email_address", String(u.email).slice(0, 100)] as [string, string]] : []),
        ["m_payment_id", id],
        ["amount", money(tier.priceCents)],
        ["item_name", `${tier.name} plan${recurring ? "" : what}`.slice(0, 100)],
        ["custom_str1", tier.id],
        ...(recurring ? [
          ["subscription_type", "1"],
          ["recurring_amount", money(tier.priceCents)],
          ["frequency", tier.period === "year" ? "6" : "3"],
          ["cycles", "0"],
        ] as Array<[string, string]> : []),
      ].filter(([, v]) => v !== "") as Array<[string, string]>;
      const fields = Object.fromEntries(pairs);
      fields.signature = sign(pairs, passphrase());
      deps.log("INFO", `PayFast checkout ${id}: ${u.username} -> ${tier.name}, R${money(tier.priceCents)}${recurring ? " monthly/yearly subscription" : ""}`);
      res.json({ url: `${host()}/eng/process`, fields, recurring });
    });

    // Admins (the /api/admin/ rule in access.ts): recent payments.
    app.get("/api/admin/payments", async (_req, res) => {
      if (!(await ensureSchema())) return res.json({ payments: [] });
      const rows = await deps.query(
        `SELECT p.id, p.tier_id, p.amount_cents, p.recurring, p.status, p.provider_payment_id, p.created_at, p.updated_at,
                u.username, u.display_name
           FROM payments p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.status <> 'pending' OR p.created_at > NOW() - interval '1 day'
          ORDER BY p.created_at DESC LIMIT 200`);
      res.json({ payments: rows ?? [] });
    });

    // Admins: does PayFast accept our signed forms? Posts a R5 checkout to
    // PayFast and reads the answer; nothing is charged and nothing is stored.
    app.post("/api/admin/payments/payfast/check", async (_req, res) => {
      if (!enabled()) return res.json({ ok: false, message: "PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY are not set." });
      const base = deps.publicUrl();
      const pairs: Array<[string, string]> = [
        ["merchant_id", merchantId()], ["merchant_key", merchantKey()],
        ["return_url", `${base}/?tab=plans`], ["cancel_url", `${base}/?tab=plans`], ["notify_url", `${base}/api/payments/payfast/notify`],
        ["m_payment_id", `check_${rand(4)}`], ["amount", "5.00"], ["item_name", "Connection check"],
      ];
      const body = new URLSearchParams([...pairs, ["signature", sign(pairs, passphrase())]]).toString();
      try {
        const r = await fetch(`${host()}/eng/process`, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, redirect: "manual", signal: AbortSignal.timeout(20_000),
        });
        const html = await r.text().catch(() => "");
        // PayFast lists what is wrong as "1. ...<br/> 2. ..." in .error-block__message.
        const block = /error-block__message">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
        const problems = block.split(/<\/?br\s*\/?>/i).map((t) => t.replace(/<[^>]+>/g, "").replace(/^\s*\d+\.\s*/, "").trim()).filter(Boolean);
        if (r.status >= 400 || problems.length) {
          const sig = problems.some((t) => /signature/i.test(t));
          return res.json({ ok: false, message: sig
            ? (passphrase() ? "PayFast says the signature is wrong: the passphrase in .env (PAYFAST_PASSPHRASE) does not match the one in PayFast > Settings > Security." : "PayFast says the signature is wrong. Your PayFast account has a passphrase: put it in the host's .env as PAYFAST_PASSPHRASE and restart.")
            : problems.join(" ") || `PayFast answered ${r.status}.` });
        }
        res.json({ ok: true, message: `PayFast accepted the signed checkout${sandbox() ? " (sandbox)" : ""}. Payments will work.` });
      } catch (e: any) {
        res.json({ ok: false, message: `Could not reach PayFast: ${e?.message ?? e}` });
      }
    });

    // PayFast's Instant Transaction Notification. Answer 200 straight away
    // (PayFast retries otherwise) and do the checks after.
    app.post("/api/payments/payfast/notify", (req, res, next) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { raw += c; if (raw.length > 64_000) req.destroy(); });
      req.on("end", () => {
        res.status(200).end();
        handleNotify(raw).catch((e) => deps.log("ERROR", `PayFast notify failed: ${e?.message ?? e}`));
      });
      req.on("error", next);
    });
  }

  async function handleNotify(raw: string) {
    // Keep PayFast's own order and encoding for the signature.
    const pairs: Array<[string, string]> = [];
    for (const part of raw.split("&")) {
      if (!part) continue;
      const i = part.indexOf("=");
      const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
      const v = i < 0 ? "" : decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "));
      pairs.push([k, v]);
    }
    const data = Object.fromEntries(pairs);
    const id = String(data.m_payment_id ?? "");
    const pfId = String(data.pf_payment_id ?? "");
    const status = String(data.payment_status ?? "").toUpperCase();
    const tag = `PayFast notify ${id || "(no id)"} ${pfId} ${status}`;

    const unsigned = pairs.filter(([k]) => k !== "signature");
    if (!data.signature || sign(unsigned, passphrase()) !== String(data.signature).toLowerCase()) {
      return deps.log("WARN", `${tag}: signature does not match - ignored`);
    }
    if (String(data.merchant_id ?? "") !== merchantId()) return deps.log("WARN", `${tag}: for another merchant - ignored`);

    // PayFast confirms the data is genuinely theirs.
    const confirm = await fetch(`${host()}/eng/query/validate`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: paramString(unsigned), signal: AbortSignal.timeout(15_000),
    }).then((r) => r.text()).catch((e) => `error: ${e?.message ?? e}`);
    if (confirm.trim() !== "VALID") return deps.log("WARN", `${tag}: PayFast did not confirm it (${confirm.trim().slice(0, 60)}) - ignored`);

    if (!(await ensureSchema())) throw new Error("database unavailable");
    const rows = await deps.query("SELECT * FROM payments WHERE id=$1", [id]);
    const payment = rows?.[0];
    if (!payment) return deps.log("WARN", `${tag}: no payment with that id - ignored`);

    const gross = Math.round(Number(data.amount_gross) * 100);
    if (status === "COMPLETE" && gross !== Number(payment.amount_cents)) {
      await deps.query("UPDATE payments SET status='amount_mismatch', detail=$2, updated_at=NOW() WHERE id=$1", [id, JSON.stringify(data)]);
      return deps.log("WARN", `${tag}: paid R${money(gross)}, expected R${money(Number(payment.amount_cents))} - not applied`);
    }
    // Each PayFast payment (a subscription's monthly charge has its own
    // pf_payment_id) is applied once, however often PayFast repeats it.
    if (pfId) {
      const fresh = await deps.query(
        "INSERT INTO payment_events (provider_payment_id, payment_id, status, amount_cents) VALUES ($1,$2,$3,$4) ON CONFLICT (provider_payment_id) DO NOTHING RETURNING provider_payment_id",
        [pfId, id, status, gross]);
      if (fresh && !fresh.length && status === "COMPLETE") return deps.log("INFO", `${tag}: already applied`);
    }

    const newStatus = status === "COMPLETE" ? "paid" : status === "CANCELLED" ? "cancelled" : status === "FAILED" ? "failed" : status.toLowerCase() || "unknown";
    await deps.query(
      "UPDATE payments SET status=$2, provider_payment_id=COALESCE(provider_payment_id,$3), subscription_token=COALESCE($4, subscription_token), detail=$5, updated_at=NOW() WHERE id=$1",
      [id, newStatus, pfId || null, data.token ? String(data.token) : null, JSON.stringify(data)]);
    if (status === "COMPLETE") {
      await grant(payment, !!payment.recurring);
      deps.log("INFO", `${tag}: R${money(gross)} received, ${payment.tier_id} switched on`);
      receipt({ kind: "payment", userId: String(payment.user_id ?? ""), title: `Payment received: R${money(gross)} for ${payment.tier_id}`, detail: `PayFast payment ${pfId || id}${payment.recurring ? " (subscription)" : ""}; plan switched on`, amountCents: gross, currency: "ZAR", data: { payment: id, provider: pfId } });
    } else {
      deps.log("INFO", `${tag}: recorded (the plan runs until its current end date)`);
    }
  }

  return { register, enabled, canRecur, ensureSchema, sign, paramString };
}
