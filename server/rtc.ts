/**
 * Play from another device (SaveState Engine, Phase 6): the page on the PC
 * that runs the game sends its picture and sound to another device over
 * WebRTC, and that device sends controls back. This only introduces the two:
 * the PC posts an offer under a short code, the other device posts its
 * answer; the game itself never passes through the host.
 *
 *   POST   /api/rtc/rooms                     { anyone? } -> { code, expiresAt }   (the PC)
 *   PUT    /api/rtc/rooms/:code/offer         { sdp }                             (the PC)
 *   GET    /api/rtc/rooms/:code/offer         waits up to 25 s -> { sdp, game } or 204
 *   PUT    /api/rtc/rooms/:code/answer        { sdp }                             (the other device)
 *   GET    /api/rtc/rooms/:code/answer        waits up to 25 s -> { sdp } or 204   (the PC)
 *   DELETE /api/rtc/rooms/:code                                                   (the PC)
 *
 * By default only the same account may join (the person's own phone or
 * tablet); `anyone: true` lets any signed-in person with the code join (a
 * friend watching or playing along). Codes last 15 minutes. One device at a
 * time. In memory: the PC and the other device talk to the same host.
 */
import express from "express";
import crypto from "crypto";

type Waiter = (body: object | null) => void;
interface Room {
  code: string;
  owner: string;
  anyone: boolean;
  game: string;
  expiresAt: number;
  offer?: string;
  answer?: string;
  joinedBy?: string;
  offerWaiters: Waiter[];
  answerWaiters: Waiter[];
}

const LIFETIME = 15 * 60_000;
const WAIT = 25_000;
// No 0/O or 1/I: the code may be read aloud or typed on a phone.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function registerRtc(app: express.Express, deps: {
  userOf: (req: express.Request, res: express.Response) => { userId: string } | null;
}) {
  const rooms = new Map<string, Room>();
  setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) if (r.expiresAt < now) { r.offerWaiters.forEach((w) => w(null)); r.answerWaiters.forEach((w) => w(null)); rooms.delete(code); }
  }, 60_000).unref();

  const roomOf = (req: express.Request, res: express.Response) => {
    const r = rooms.get(String(req.params.code ?? "").toUpperCase());
    if (!r || r.expiresAt < Date.now()) { res.status(404).json({ error: "That code has expired or doesn't exist. Ask for a new one." }); return null; }
    return r;
  };
  const wait = (req: express.Request, res: express.Response, ready: () => object | null, queue: Waiter[]) => {
    const now = ready();
    if (now) return res.json(now);
    let done = false;
    const finish: Waiter = (body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (body) res.json(body); else res.status(204).end();
    };
    const timer = setTimeout(() => finish(null), WAIT);
    req.on("close", () => { done = true; clearTimeout(timer); });
    queue.push(finish);
  };

  app.post("/api/rtc/rooms", express.json({ limit: "4kb" }), (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    let code = "";
    do { code = Array.from(crypto.randomBytes(6), (b) => LETTERS[b % LETTERS.length]).join(""); } while (rooms.has(code));
    const room: Room = { code, owner: who.userId, anyone: !!req.body?.anyone, game: String(req.body?.game ?? "").slice(0, 120), expiresAt: Date.now() + LIFETIME, offerWaiters: [], answerWaiters: [] };
    rooms.set(code, room);
    res.json({ code, expiresAt: room.expiresAt });
  });

  app.put("/api/rtc/rooms/:code/offer", express.json({ limit: "64kb" }), (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const r = roomOf(req, res); if (!r) return;
    if (r.owner !== who.userId) return res.status(403).json({ error: "Not your code" });
    const sdp = String(req.body?.sdp ?? "");
    if (!sdp.startsWith("v=0")) return res.status(400).json({ error: "sdp required" });
    r.offer = sdp; r.answer = undefined; r.joinedBy = undefined;
    const waiting = r.offerWaiters.splice(0);
    waiting.forEach((w) => w({ sdp, game: r.game }));
    res.json({ ok: true });
  });

  app.get("/api/rtc/rooms/:code/offer", (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const r = roomOf(req, res); if (!r) return;
    if (!r.anyone && r.owner !== who.userId) return res.status(403).json({ error: "This game is shared with its owner's own devices only." });
    if (r.joinedBy && r.joinedBy !== who.userId) return res.status(409).json({ error: "Someone else is already playing on this code." });
    wait(req, res, () => (r.offer ? { sdp: r.offer, game: r.game } : null), r.offerWaiters);
  });

  app.put("/api/rtc/rooms/:code/answer", express.json({ limit: "64kb" }), (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const r = roomOf(req, res); if (!r) return;
    if (!r.anyone && r.owner !== who.userId) return res.status(403).json({ error: "This game is shared with its owner's own devices only." });
    if (r.joinedBy && r.joinedBy !== who.userId) return res.status(409).json({ error: "Someone else is already playing on this code." });
    const sdp = String(req.body?.sdp ?? "");
    if (!sdp.startsWith("v=0")) return res.status(400).json({ error: "sdp required" });
    r.answer = sdp; r.joinedBy = who.userId;
    const waiting = r.answerWaiters.splice(0);
    waiting.forEach((w) => w({ sdp }));
    res.json({ ok: true });
  });

  app.get("/api/rtc/rooms/:code/answer", (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const r = roomOf(req, res); if (!r) return;
    if (r.owner !== who.userId) return res.status(403).json({ error: "Not your code" });
    wait(req, res, () => (r.answer ? { sdp: r.answer } : null), r.answerWaiters);
  });

  app.delete("/api/rtc/rooms/:code", (req, res) => {
    const who = deps.userOf(req, res); if (!who) return;
    const r = rooms.get(String(req.params.code ?? "").toUpperCase());
    if (r && r.owner === who.userId) { r.offerWaiters.forEach((w) => w(null)); r.answerWaiters.forEach((w) => w(null)); rooms.delete(r.code); }
    res.json({ ok: true });
  });
}
