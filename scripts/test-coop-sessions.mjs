// Co-op session and /ws/coop behaviour against a running server.
//   NEXUS_TEST_URL=http://localhost:3000 NEXUS_TEST_TOKEN=<jwt> node scripts/test-coop-sessions.mjs
// The token is any valid JWT for that server (signed with its JWT_SECRET).
import WebSocket from "ws";
const B = (process.env.NEXUS_TEST_URL || "http://localhost:3000").replace(/\/$/, "");
const W = B.replace(/^http/, "ws");
const TOKEN = process.env.NEXUS_TEST_TOKEN || "";
const j = async (p, o = {}) => { const r = await fetch(B + p, { headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, ...o }); return { status: r.status, body: await r.json().catch(() => null) }; };
const open = (path) => new Promise((res) => { const ws = new WebSocket(W + path); ws.msgs = []; ws.on("message", m => ws.msgs.push(JSON.parse(m))); ws.on("open", () => res(ws)); ws.on("close", (c) => { ws.code = c; if (ws.readyState !== 1) res(ws); }); });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const c = await j("/api/multiplayer/sessions", { method: "POST", body: JSON.stringify({ gameTitle: "Contra", hostId: "hostabc", playerName: "H", mode: "local" }) });
ok(c.status === 200 && c.body.wsUrl.includes("&hk="), "create returns host wsUrl with key " + c.status);
const sid = c.body.session.id;
const list = await j("/api/multiplayer/sessions");
const host1 = await open(c.body.wsUrl); await wait(100);
const list2 = await j("/api/multiplayer/sessions");
ok(list2.body.sessions.find(s => s.id === sid).players.every(p => !("id" in p)), "public list hides player ids");
const det = await j("/api/multiplayer/sessions/" + sid);
ok(det.body.players.length === 1 && !("id" in det.body.players[0]), "public detail hides player ids");

const attacker = await open(`/ws/coop?session=${sid}&id=hostabc&name=X&role=host`); await wait(200);
ok(attacker.code === 4013, "second host socket without key rejected (code " + attacker.code + ")");
ok(host1.readyState === 1, "real host still connected");

const jr = await j(`/api/multiplayer/sessions/${sid}/join`, { method: "POST", body: JSON.stringify({ playerName: "P2" }) });
const cl = await open(jr.body.wsUrl); await wait(150);
const req = host1.msgs.find(m => m.type === "join_request");
ok(!!req, "host receives join_request");
host1.send(JSON.stringify({ type: "approve_join", clientId: req.clientId })); await wait(150);
ok(cl.msgs.some(m => m.type === "join_approved"), "client approved");

// reconnect race: host reconnects with key while old socket still open, then old closes
const host2 = await open(c.body.wsUrl); await wait(150);
ok(host2.readyState === 1, "host reconnect with key accepted");
await wait(200);
ok(host1.readyState !== 1, "stale host socket terminated");
cl.send(JSON.stringify({ type: "controller", buttons: [true], axes: [0] })); await wait(150);
ok(host2.msgs.some(m => m.type === "controller"), "reconnected host still receives controller input after stale close");
const det2 = await j("/api/multiplayer/sessions/" + sid);
ok(det2.body.players.some(p => p.role === "host"), "host still registered after stale close");

// chat cap
cl.send(JSON.stringify({ type: "chat", text: "x".repeat(5000) })); await wait(150);
const chat = host2.msgs.find(m => m.type === "chat");
ok(chat && chat.text.length === 500, "chat capped at 500 chars");

// oversized frame
const big = await open(`/ws/coop?session=${sid}&id=hostabc&name=H&role=host&hk=${c.body.hostKey}`); await wait(100);
big.send("x".repeat(300 * 1024)); await wait(300);
ok(big.code === 1009, "oversized frame closes socket (code " + big.code + ")");

// DELETE auth
const d1 = await j("/api/multiplayer/sessions/" + sid, { method: "DELETE" });
ok(d1.status === 403, "DELETE without host id refused " + d1.status);
const d2 = await j("/api/multiplayer/sessions/" + sid, { method: "DELETE", body: JSON.stringify({ hostId: "hostabc" }) });
ok(d2.status === 200, "DELETE by host allowed " + d2.status);

// EmulatorPlayer-style: host builds own URL w/o key, no live host -> accepted
const c3 = await j("/api/multiplayer/sessions", { method: "POST", body: JSON.stringify({ gameTitle: "Y", hostId: "emuhost", mode: "browser" }) });
const e = await open(`/ws/coop?session=${c3.body.session.id}&id=emuhost&name=Host&role=host`); await wait(100);
ok(e.readyState === 1, "keyless host accepted when seat is free (EmulatorPlayer)");
e.close(); await wait(100);
const e2 = await open(`/ws/coop?session=${c3.body.session.id}&id=emuhost&name=Host&role=host`); await wait(100);
ok(e2.readyState === 1, "keyless host can reconnect after clean close");
console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
