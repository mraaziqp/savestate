// Lets the NAS reach apps on this PC that only listen on 127.0.0.1 (Jarvis on
// 3005), now that the NAS runs the Cloudflare tunnel (deploy/qnap). Each
// argument is "listen:target", e.g. node lan-forward.cjs 3006:3005. Only
// addresses on the home network may connect; run-host.ps1 keeps it running.
const net = require("net");

const LAN = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const pairs = process.argv.slice(2).map((a) => a.split(":").map(Number)).filter(([l, t]) => l > 0 && t > 0);
if (!pairs.length) { console.error("usage: node lan-forward.cjs <listen>:<target> ..."); process.exit(1); }

for (const [listen, target] of pairs) {
  net.createServer((client) => {
    if (!LAN.test(client.remoteAddress || "")) { client.destroy(); return; }
    const up = net.connect(target, "127.0.0.1");
    client.pipe(up).pipe(client);
    const end = () => { client.destroy(); up.destroy(); };
    client.on("error", end); up.on("error", end);
  }).listen(listen, "0.0.0.0", () => console.log(`forwarding :${listen} -> 127.0.0.1:${target} (home network only)`))
    .on("error", (e) => { console.error(`:${listen}: ${e.message}`); process.exit(1); });
}
