// Exercises cloudflare-worker/savestate-failover.js with a mocked fetch.
//   node scripts/test-failover-worker.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const workerPath = pathToFileURL(path.resolve("cloudflare-worker/savestate-failover.js")).href;
let n = 0;
// Fresh module per case so the per-isolate breaker starts closed.
const load = async () => (await import(`${workerPath}?case=${n++}`)).default;

const PRIMARY = "https://savestate.co.za";
const STANDBY = "https://standby.example.awsapprunner.com";
const STATIC = "https://main.example.amplifyapp.com";
const env = { STANDBY_ORIGIN: STANDBY, FALLBACK_ORIGIN: STATIC };

const app = (status, body = "{}") =>
  new Response(body, { status, headers: { "x-savestate-origin": "primary", "content-type": "application/json" } });
const bare = (status) => new Response("err", { status });

function mockFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (req) => {
    const r = req instanceof Request ? req : new Request(req);
    const host = new URL(r.url).origin;
    calls.push({ host, url: r.url, method: r.method, body: r.body ? await r.clone().text() : null, headers: r.headers });
    const h = handlers[host];
    if (!h) throw new Error("unexpected origin " + host);
    return h(r);
  };
  return calls;
}

const cases = {
  async "healthy primary passes straight through"() {
    const w = await load();
    const calls = mockFetch({ [PRIMARY]: () => app(200, '{"ok":1}') });
    const res = await w.fetch(new Request(`${PRIMARY}/api/games`), env);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
  },

  async "app-level 503 is the app's answer, not an outage"() {
    const w = await load();
    const calls = mockFetch({ [PRIMARY]: () => app(503, '{"error":"Database unavailable"}') });
    const res = await w.fetch(new Request(`${PRIMARY}/api/games`), env);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /Database unavailable/);
    assert.equal(calls.length, 1, "must not fail over");
  },

  async "tunnel down (530) sends API to the standby"() {
    const w = await load();
    const calls = mockFetch({
      [PRIMARY]: () => bare(530),
      [STANDBY]: () => new Response('{"games":[]}', { status: 200, headers: { "x-savestate-origin": "standby" } }),
    });
    const res = await w.fetch(new Request(`${PRIMARY}/api/games?x=1`), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-savestate-origin"), "standby");
    assert.equal(calls[1].url, `${STANDBY}/api/games?x=1`);
    assert.equal(calls[1].headers.get("x-forwarded-host"), "savestate.co.za");
  },

  async "cloudflared 502 without the app header counts as down"() {
    const w = await load();
    mockFetch({ [PRIMARY]: () => bare(502), [STANDBY]: () => app(200) });
    const res = await w.fetch(new Request(`${PRIMARY}/`), env);
    assert.equal(res.status, 200);
  },

  async "thrown fetch counts as down"() {
    const w = await load();
    mockFetch({ [PRIMARY]: () => { throw new TypeError("network"); }, [STANDBY]: () => app(200) });
    const res = await w.fetch(new Request(`${PRIMARY}/api/health`), env);
    assert.equal(res.status, 200);
  },

  async "small POST body is replayed to the standby intact"() {
    const w = await load();
    const calls = mockFetch({ [PRIMARY]: () => bare(530), [STANDBY]: () => app(200) });
    const body = JSON.stringify({ username: "a", password: "b" });
    const res = await w.fetch(new Request(`${PRIMARY}/api/auth/login`, {
      method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length) },
    }), env);
    assert.equal(res.status, 200);
    assert.equal(calls[0].body, body);
    assert.equal(calls[1].body, body);
    assert.equal(calls[1].method, "POST");
  },

  async "unsized upload is not buffered and is not replayed"() {
    const w = await load();
    const calls = mockFetch({ [PRIMARY]: () => bare(530), [STANDBY]: () => app(200) });
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("chunk")); c.close(); } });
    const res = await w.fetch(new Request(`${PRIMARY}/api/upload`, { method: "POST", body: stream, duplex: "half" }), env);
    assert.equal(res.status, 503);
    assert.equal(calls.filter(c => c.host === STANDBY).length, 0);
  },

  async "breaker skips the dead primary, then probes it again"() {
    const w = await load();
    let primaryUp = false;
    const calls = mockFetch({ [PRIMARY]: () => (primaryUp ? app(200) : bare(530)), [STANDBY]: () => app(200) });
    await w.fetch(new Request(`${PRIMARY}/a`), env);
    await w.fetch(new Request(`${PRIMARY}/b`), env);
    assert.deepEqual(calls.map(c => c.host), [PRIMARY, STANDBY, STANDBY], "second request goes straight to standby");
    const realNow = Date.now;
    Date.now = () => realNow() + 25_000;
    try {
      primaryUp = true;
      const res = await w.fetch(new Request(`${PRIMARY}/c`), env);
      assert.equal(res.headers.get("x-savestate-origin"), "primary", "primary takes traffic back");
    } finally {
      Date.now = realNow;
    }
  },

  async "standby down too: page loads get the static shell"() {
    const w = await load();
    mockFetch({ [PRIMARY]: () => bare(530), [STANDBY]: () => bare(503), [STATIC]: () => new Response("<html>", { status: 200 }) });
    const res = await w.fetch(new Request(`${PRIMARY}/library`), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-savestate-origin"), "static");
  },

  async "standby down too: API gets a JSON 503, never the static shell"() {
    const w = await load();
    const calls = mockFetch({ [PRIMARY]: () => bare(530), [STANDBY]: () => bare(503), [STATIC]: () => new Response("<html>") });
    const res = await w.fetch(new Request(`${PRIMARY}/api/games`), env);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "host_offline");
    assert.equal(calls.filter(c => c.host === STATIC).length, 0);
  },

  async "no standby configured behaves like before"() {
    const w = await load();
    mockFetch({ [PRIMARY]: () => bare(530), [STATIC]: () => new Response("<html>") });
    const res = await w.fetch(new Request(`${PRIMARY}/`), { FALLBACK_ORIGIN: STATIC });
    assert.equal(res.headers.get("x-savestate-origin"), "static");
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { failed++; console.log("FAIL", name, "\n   ", e.message); }
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
