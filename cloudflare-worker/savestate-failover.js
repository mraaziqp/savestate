/**
 * savestate.co.za — origin failover / graceful offline.
 *
 * The site is served from a Cloudflare Tunnel to a machine at home. When that
 * machine is off, Cloudflare answers with a raw 1033/502 error page, which is
 * what a visitor saw when the laptop went down. This Worker sits on the route
 * and turns that into a real page.
 *
 * Design notes, because a Worker in front of a media server is easy to get
 * wrong:
 *
 *  - The happy path is a straight pass-through. The upstream Response object is
 *    returned untouched, so the body streams rather than buffering, and Range
 *    requests / 206 responses / Content-Range survive intact. Video scrubbing
 *    breaks immediately if you rebuild the response by hand.
 *  - Only origin-level failures are intercepted. A 404 or 401 from the app is
 *    the app working correctly and must pass through.
 *  - Cloudflare's own origin errors are the 52x family (521 down, 522 timeout,
 *    523 unreachable, 524 timeout) plus 1033 for a tunnel with no connector.
 *    Those, and a thrown fetch, are the "host is down" signal.
 *  - Media and API requests get a JSON/503 rather than an HTML page, so a
 *    player or fetch() sees a real error instead of parsing a web page.
 *
 * Optional: set FALLBACK_ORIGIN (a Worker environment variable) to another
 * host that can serve the app, and the Worker will try it before giving up.
 * Leave it unset and the offline page is the fallback.
 */

const ORIGIN_DOWN_STATUSES = new Set([521, 522, 523, 524, 525, 526, 530, 502, 503, 504]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    let upstream = null;
    try {
      upstream = await fetch(request);
      if (!ORIGIN_DOWN_STATUSES.has(upstream.status)) {
        // Normal case: hand the response straight back, body still streaming.
        return upstream;
      }
    } catch (_err) {
      // Connection refused / DNS / tunnel gone — treat as origin down.
    }

    const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/");

    // Origin is down. Try a secondary origin if one is configured.
    //
    // API requests are deliberately NOT sent there. The configured fallback is
    // static hosting (Amplify) with an SPA rewrite, so /api/* returns a 301 to
    // index.html — the app would receive HTML where it expects JSON and fail in
    // a confusing way. A clean 503 is far easier to handle and to read in a
    // network tab.
    const fallback = (env && env.FALLBACK_ORIGIN ? String(env.FALLBACK_ORIGIN) : "").trim();
    if (fallback && !isApi) {
      try {
        const alt = new URL(url.pathname + url.search, fallback);
        const altReq = new Request(alt.toString(), request);
        const altRes = await fetch(altReq);
        if (!ORIGIN_DOWN_STATUSES.has(altRes.status)) {
          // Flagged so the app (and you, in devtools) can tell this is the
          // standby shell rather than the live host.
          const out = new Response(altRes.body, altRes);
          out.headers.set("x-savestate-origin", "standby");
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
