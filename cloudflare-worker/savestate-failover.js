/**
 * savestate.co.za — origin failover.
 *
 * The site is served from a Cloudflare Tunnel to a machine at home (the
 * "primary"). This Worker sits on the domain's routes and decides, per
 * request, who answers:
 *
 *   1. primary (home host, via the tunnel)      — always tried first
 *   2. STANDBY_ORIGIN (the AWS App Runner copy) — full app, API included
 *   3. FALLBACK_ORIGIN (Amplify, static)         — page loads only
 *   4. the built-in offline page / JSON 503
 *
 * So AWS only receives traffic while the home host is down, and the home host
 * takes it back automatically as soon as it answers again.
 *
 * Design notes, because a Worker in front of a media server is easy to get
 * wrong:
 *
 *  - The happy path is a straight pass-through. The upstream Response object is
 *    returned untouched, so the body streams rather than buffering, and Range
 *    requests / 206 responses / Content-Range survive intact. Video scrubbing
 *    breaks immediately if you rebuild the response by hand.
 *
 *  - "Host down" means the request never reached the app: Cloudflare's own
 *    52x/530 (530 is error 1033, a tunnel with no connector), a thrown fetch,
 *    or a 502/503/504 WITHOUT the X-SaveState-Origin header. The app stamps
 *    that header on every response (server.ts), so an app-level 503 such as
 *    "Database unavailable" passes through as the app's own answer instead of
 *    being replaced with the offline page. cloudflared's 502 when nothing is
 *    listening on :3000 carries no such header.
 *
 *  - Once the primary is seen down, this isolate goes straight to the standby
 *    for BREAKER_MS instead of paying for a failed round trip on every
 *    request, then probes the primary again.
 *
 *  - A request body can only be read once. Bodies up to MAX_REPLAY_BYTES are
 *    buffered so a failed POST can be retried on the standby; larger or
 *    unsized bodies (uploads) stream straight to the primary and get a 503 if
 *    it is down, rather than being held in Worker memory.
 */

// Cloudflare-generated: the request never reached the app.
const CF_ORIGIN_ERRORS = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);
// Could come from the app or from cloudflared/Cloudflare; the header decides.
const AMBIGUOUS_ERRORS = new Set([502, 503, 504]);
const ORIGIN_HEADER = "x-savestate-origin";

const BREAKER_MS = 20_000;
const MAX_REPLAY_BYTES = 1024 * 1024;

// Per-isolate. Each Cloudflare location discovers the outage on its own, which
// costs one failed request there; that is fine.
let primaryDownUntil = 0;

function isOriginDown(res) {
  if (CF_ORIGIN_ERRORS.has(res.status)) return true;
  if (AMBIGUOUS_ERRORS.has(res.status)) return !res.headers.has(ORIGIN_HEADER);
  return false;
}

function originUrl(env, name) {
  return (env && env[name] ? String(env[name]) : "").trim();
}

// Rebuild the request against another origin. The app reads X-Forwarded-Host
// for subdomain tenancy, so it still sees savestate.co.za rather than the
// App Runner hostname.
function forOrigin(request, base, body) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, base);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  return new Request(target.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/");
    const standby = originUrl(env, "STANDBY_ORIGIN");
    const staticFallback = originUrl(env, "FALLBACK_ORIGIN");

    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
    let replayBody = null;
    let canReplay = !hasBody;
    if (hasBody && standby) {
      const len = Number(request.headers.get("content-length") || "");
      if (Number.isFinite(len) && len > 0 && len <= MAX_REPLAY_BYTES) {
        replayBody = await request.arrayBuffer();
        canReplay = true;
      }
    }

    const skipPrimary = standby && canReplay && Date.now() < primaryDownUntil;

    if (!skipPrimary) {
      try {
        const primaryReq = replayBody !== null ? new Request(request, { body: replayBody }) : request;
        const upstream = await fetch(primaryReq);
        if (!isOriginDown(upstream)) {
          primaryDownUntil = 0;
          // Normal case: hand the response straight back, body still streaming.
          return upstream;
        }
      } catch (_err) {
        // Connection refused / DNS / tunnel gone — treat as origin down.
      }
      primaryDownUntil = Date.now() + BREAKER_MS;
    }

    // Primary is down. The standby runs the same app, so it takes everything,
    // API and WebSocket upgrades included.
    if (standby && canReplay) {
      try {
        const res = await fetch(forOrigin(request, standby, hasBody ? replayBody : undefined));
        if (!isOriginDown(res)) return res;
      } catch (_err) {
        // fall through
      }
    }

    // Static shell. API requests are deliberately NOT sent there: Amplify's SPA
    // rewrite answers /api/* with index.html, and the app would get HTML where
    // it expects JSON. A clean 503 is easier to handle and to read.
    if (staticFallback && !isApi && (method === "GET" || method === "HEAD")) {
      try {
        const res = await fetch(forOrigin(request, staticFallback));
        if (!isOriginDown(res)) {
          const out = new Response(res.body, res);
          out.headers.set(ORIGIN_HEADER, "static");
          return out;
        }
      } catch (_err) {
        // fall through to the offline response
      }
    }

    // Machine-readable for anything that is not a browser page load.
    const wantsJson =
      isApi || (request.headers.get("accept") || "").includes("application/json");

    if (wantsJson) {
      return new Response(
        JSON.stringify({
          error: "host_offline",
          message: "The SaveState host is currently offline. Media and games are unavailable until it is back.",
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": "120",
          },
        },
      );
    }

    return new Response(OFFLINE_PAGE, {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "120",
      },
    });
  },
};

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SaveState — Host Offline</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(circle at 50% 30%, #1a1a3a 0%, #07070d 70%);
    color: #e8e8f0; padding: 24px;
  }
  .card {
    max-width: 520px; width: 100%; text-align: center;
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px; padding: 48px 32px; backdrop-filter: blur(20px);
  }
  h1 {
    margin: 0 0 8px; font-size: clamp(28px, 6vw, 40px); font-weight: 900;
    letter-spacing: -0.03em; font-style: italic; text-transform: uppercase;
    background: linear-gradient(135deg, #4D7CFF, #A855F7);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    background: #f59e0b; margin-right: 8px; vertical-align: middle;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .status {
    font-size: 11px; letter-spacing: .28em; text-transform: uppercase;
    color: rgba(255,255,255,.45); margin-bottom: 20px; font-weight: 700;
  }
  p { line-height: 1.65; color: rgba(255,255,255,.7); margin: 0 0 12px; font-size: 15px; }
  .hint { font-size: 13px; color: rgba(255,255,255,.4); margin-top: 24px; }
  button {
    margin-top: 28px; padding: 13px 30px; border-radius: 999px; cursor: pointer;
    background: rgba(77,124,255,.14); border: 1px solid rgba(77,124,255,.45);
    color: #cbd9ff; font-weight: 800; font-size: 12px; letter-spacing: .18em;
    text-transform: uppercase; transition: background .2s, border-color .2s;
  }
  button:hover { background: rgba(77,124,255,.24); border-color: rgba(77,124,255,.7); }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
</style>
</head>
<body>
  <div class="card">
    <div class="status"><span class="dot"></span>Host Offline</div>
    <h1>SaveState</h1>
    <p>The host machine is currently offline, so the library cannot be reached right now.</p>
    <p>Nothing has been lost — everything is stored safely and will be here when the host is back.</p>
    <button onclick="location.reload()">Try again</button>
    <div class="hint">This page refreshes nothing automatically, so you are not stuck in a loop.</div>
  </div>
</body>
</html>`;
