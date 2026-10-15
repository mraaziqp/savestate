/**
 * Service keys: the API keys SaveState uses for outside services, entered by
 * an admin in the app (Plans > Service keys) instead of editing .env.
 *
 * Stored encrypted in service-keys.json in the data folder. A key saved here
 * wins over the same name in .env; removing it falls back to .env again.
 * `applyServiceKeysSync` runs at start-up, before anything reads them.
 */
import type express from "express";
import { readFileSync, existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Caller } from "./access.ts";

type KeyDef = {
  env: string; label: string; purpose: string; getUrl: string; where: string;
  /** Takes effect without a restart. */
  live: boolean;
  test?: (v: string) => Promise<string>;
};

const get = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (r.status === 401 || r.status === 403) throw new Error("The service refused this key.");
  if (!r.ok) throw new Error(`The service answered ${r.status}.`);
  return r.json().catch(() => ({}));
};

export const SERVICE_KEYS: KeyDef[] = [
  {
    env: "RESEND_API_KEY", label: "Resend (password-reset emails)", live: true,
    purpose: "Emails a reset link to members who forget their password. Without it, resets wait for an admin under Plans > Payments & requests.",
    getUrl: "https://resend.com/api-keys", where: "resend.com > API Keys > Create API key (Sending access). Also add and verify your domain under Domains.",
    test: async (v) => {
      const d: any = await get("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${v}` } });
      const domains = (d?.data ?? []) as any[];
      const ok = domains.filter((x) => x.status === "verified").map((x) => x.name);
      return ok.length ? `Works. Verified domain: ${ok.join(", ")}.` : "The key works, but no domain is verified in Resend yet, so emails can only go to your own address.";
    },
  },
  {
    env: "PAYFAST_PASSPHRASE", label: "PayFast passphrase", live: true,
    purpose: "Signs card payments. Needed when your PayFast account has a passphrase set (otherwise PayFast refuses every payment).",
    getUrl: "https://my.payfast.io/", where: "PayFast > Settings > Security > Salt passphrase. Then use \"Check PayFast connection\" under Payments & requests.",
  },
  {
    env: "GEMINI_API_KEY", label: "Google Gemini (AI assistant)", live: true,
    purpose: "Powers the AI assistant, natural-language search and game guides.",
    getUrl: "https://aistudio.google.com/app/apikey", where: "Google AI Studio > Get API key > Create API key.",
    test: async (v) => { const d: any = await get(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(v)}`); return `Works (${(d?.models ?? []).length} models available).`; },
  },
  {
    env: "TMDB_API_KEY", label: "TMDB (film and TV details)", live: false,
    purpose: "Posters, plots, cast and age ratings. SaveState has a shared key built in; your own avoids its rate limits.",
    getUrl: "https://www.themoviedb.org/settings/api", where: "themoviedb.org > Settings > API > API Key (v3 auth).",
    test: async (v) => { await get(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(v)}`); return "Works."; },
  },
];

const FILE = "service-keys.json";
/** What .env said before any saved key was applied, so removing one falls back to it. */
const fromEnv = new Map<string, string | undefined>();

export function applyServiceKeysSync(persistDir: string, decrypt: (s: string) => string): string[] {
  for (const k of SERVICE_KEYS) if (!fromEnv.has(k.env)) fromEnv.set(k.env, process.env[k.env]);
  const file = path.join(persistDir, FILE);
  if (!existsSync(file)) return [];
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    const applied: string[] = [];
    for (const k of SERVICE_KEYS) {
      const v = saved[k.env] ? decrypt(saved[k.env]) : "";
      if (v) { process.env[k.env] = v; applied.push(k.env); }
    }
    return applied;
  } catch { return []; }
}

export function createServiceKeys(deps: {
  persistDir: string;
  encrypt: (s: string) => string;
  decrypt: (s: string) => string;
  callerOf: (req: express.Request) => Promise<Caller>;
  onChange: (env: string) => void;
  log: (level: string, msg: string) => void;
}) {
  const file = path.join(deps.persistDir, FILE);
  const read = (): Record<string, string> => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  async function write(data: Record<string, string>) {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, file);
  }

  function register(app: express.Express) {
    const admin = async (req: express.Request, res: express.Response) => {
      const c = await deps.callerOf(req);
      if (!c.admin) { res.status(403).json({ error: "admin_only", message: "Only the host's admins can do this." }); return false; }
      return true;
    };

    app.get("/api/admin/service-keys", async (req, res) => {
      if (!(await admin(req, res))) return;
      const saved = read();
      res.setHeader("Cache-Control", "no-store");
      res.json({ keys: SERVICE_KEYS.map((k) => {
        const v = process.env[k.env] ?? "";
        return {
          env: k.env, label: k.label, purpose: k.purpose, getUrl: k.getUrl, where: k.where, live: k.live, testable: !!k.test,
          set: !!v, source: saved[k.env] ? "app" : v ? "env" : null, ending: v.length > 8 ? v.slice(-4) : "",
        };
      }) });
    });

    app.put("/api/admin/service-keys/:env", async (req, res) => {
      if (!(await admin(req, res))) return;
      const k = SERVICE_KEYS.find((x) => x.env === req.params.env);
      if (!k) return res.status(404).json({ error: "Unknown key." });
      const value = String(req.body?.value ?? "").trim();
      if (value.length > 500 || /\s/.test(value)) return res.status(400).json({ error: "That doesn't look like a key (no spaces, at most 500 characters)." });
      const saved = read();
      if (value) { saved[k.env] = deps.encrypt(value); process.env[k.env] = value; }
      else {
        delete saved[k.env];
        const orig = fromEnv.get(k.env);
        if (orig) process.env[k.env] = orig; else delete process.env[k.env];
      }
      await write(saved);
      deps.onChange(k.env);
      deps.log("INFO", `Service key ${value ? "saved" : "removed"}: ${k.env}`);
      let check: string | null = null;
      if (value && k.test) check = await k.test(value).catch((e) => `Saved, but the test failed: ${e?.message ?? e}`);
      res.json({ ok: true, check, restartNeeded: !k.live });
    });

    // Resend only emails other people once the sending domain is verified: the
    // records to add at the DNS host, and a "check now".
    const resend = (p: string, init?: RequestInit) => fetch(`https://api.resend.com/${p}`, {
      ...init, headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ""}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
    }).then((r) => r.json());
    app.get("/api/admin/service-keys/resend/domain", async (req, res) => {
      if (!(await admin(req, res))) return;
      if (!process.env.RESEND_API_KEY) return res.json({ domain: null });
      try {
        const list: any = await resend("domains");
        const want = (process.env.RESEND_FROM ?? "noreply@savestate.co.za").replace(/^.*@/, "").replace(/>.*$/, "").trim();
        let d = (list.data ?? []).find((x: any) => x.name === want);
        if (!d) d = await resend("domains", { method: "POST", body: JSON.stringify({ name: want }) });
        const full: any = await resend(`domains/${d.id}`);
        res.json({ domain: { id: full.id, name: full.name, status: full.status, records: (full.records ?? []).map((r: any) => ({ type: r.type, name: r.name, value: r.value, priority: r.priority ?? null, status: r.status })) } });
      } catch (e: any) { res.status(502).json({ error: `Resend didn't answer: ${e?.message ?? e}` }); }
    });
    app.post("/api/admin/service-keys/resend/verify", async (req, res) => {
      if (!(await admin(req, res))) return;
      const id = String(req.body?.id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "Bad id." });
      try { await resend(`domains/${id}/verify`, { method: "POST" }); res.json({ ok: true }); }
      catch (e: any) { res.status(502).json({ error: `Resend didn't answer: ${e?.message ?? e}` }); }
    });

    app.post("/api/admin/service-keys/:env/test", async (req, res) => {
      if (!(await admin(req, res))) return;
      const k = SERVICE_KEYS.find((x) => x.env === req.params.env);
      if (!k?.test) return res.status(404).json({ error: "This key has no test." });
      const v = process.env[k.env] ?? "";
      if (!v) return res.status(400).json({ error: "No key is set." });
      try { res.json({ ok: true, message: await k.test(v) }); }
      catch (e: any) { res.json({ ok: false, message: e?.message ?? String(e) }); }
    });
  }
  return { register };
}
