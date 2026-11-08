import type express from "express";
import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import QRCode from "qrcode";
import { randomInt } from "node:crypto";

export type RemoteControlDeps = {
  httpServer: http.Server;
  app: express.Express;
  log: (level: string, msg: string, subsystem?: string) => void;
  getOptionalAuthUser?: (req: express.Request) => any;
  /** The signed-in user a token belongs to, or null. */
  userFromToken: (token: string) => string | null;
};

type DisplaySession = {
  displayId: string;
  pin: string;
  deviceName: string;
  userId: string | null;
  ws: WebSocket;
  pairedControllers: Set<WebSocket>;
  createdAt: number;
  lastPing: number;
};

export function registerRemoteControl(deps: RemoteControlDeps) {
  const { httpServer, app, log, getOptionalAuthUser, userFromToken } = deps;

  // Commands are small; nothing bigger is needed (and nothing bigger is relayed).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // Wrong PINs per address: 8 in 10 minutes, then pairing by PIN is refused.
  const pinFails = new Map<string, { n: number; until: number }>();
  const ipOf = (req: http.IncomingMessage) => String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const pinBlocked = (ip: string) => { const f = pinFails.get(ip); return !!f && f.until > Date.now() && f.n >= 8; };
  const pinFailed = (ip: string) => { const f = pinFails.get(ip); const now = Date.now(); if (!f || f.until <= now) pinFails.set(ip, { n: 1, until: now + 10 * 60_000 }); else f.n++; };

  const displays = new Map<string, DisplaySession>(); // displayId -> DisplaySession
  const pinMap = new Map<string, string>(); // PIN -> displayId
  const controllerToDisplay = new Map<WebSocket, string>(); // controllerWs -> displayId

  function generatePin(): string {
    for (let attempts = 0; attempts < 100; attempts++) {
      const pin = String(randomInt(100000, 1000000));
      if (!pinMap.has(pin)) return pin;
    }
    return String(randomInt(100000, 1000000));
  }

  function cleanDeadSessions() {
    const now = Date.now();
    for (const [id, s] of displays.entries()) {
      if (s.ws.readyState !== WebSocket.OPEN || now - s.lastPing > 90_000) {
        try { s.ws.close(); } catch {}
        pinMap.delete(s.pin);
        displays.delete(id);
        for (const c of s.pairedControllers) {
          try {
            c.send(JSON.stringify({ type: "display_disconnected", error: "TV went offline" }));
          } catch {}
          controllerToDisplay.delete(c);
        }
      }
    }
  }

  // Periodic cleanup
  setInterval(cleanDeadSessions, 30_000);

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const role = url.searchParams.get("role") ?? "display"; // "display" or "controller"
    const pin = url.searchParams.get("pin") ?? "";
    // Who this is comes from their sign-in, never from the address: before
    // 2026-11-08 anyone could connect, read every TV's PIN from the public
    // /api/remote/active-displays, and type into or move around a signed-in
    // SaveState on someone else's TV.
    const userId = userFromToken(url.searchParams.get("token") ?? "");
    if (!userId) {
      try { ws.send(JSON.stringify({ type: "error", error: "Sign in to SaveState first." })); } catch {}
      ws.close(1008, "Sign in required");
      return;
    }
    const deviceName = url.searchParams.get("name") ?? (role === "display" ? "Living Room TV" : "Smartphone");

    if (role === "display") {
      let displayId = url.searchParams.get("displayId") || `tv_${Math.random().toString(36).substring(2, 8)}`;
      let assignedPin = generatePin();

      // If existing session with this displayId, close previous ws
      const prev = displays.get(displayId);
      if (prev) {
        pinMap.delete(prev.pin);
        try { prev.ws.close(); } catch {}
      }

      const session: DisplaySession = {
        displayId,
        pin: assignedPin,
        deviceName,
        userId,
        ws,
        pairedControllers: new Set(),
        createdAt: Date.now(),
        lastPing: Date.now(),
      };

      displays.set(displayId, session);
      pinMap.set(assignedPin, displayId);

      log("INFO", `TV Display connected: ${displayId} (PIN: ${assignedPin})`, "remote");

      const host = req.headers.host || "localhost:3000";
      const proto = req.headers["x-forwarded-proto"] || "http";
      const remoteUrl = `${proto}://${host}/?remote=1&pin=${assignedPin}`;

      void QRCode.toDataURL(remoteUrl, { margin: 1, width: 220 })
        .then((qrData) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "registered",
              displayId,
              pin: assignedPin,
              deviceName,
              remoteUrl,
              qrData,
            }));
          }
        })
        .catch(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "registered",
              displayId,
              pin: assignedPin,
              deviceName,
              remoteUrl,
            }));
          }
        });

      ws.on("message", (raw: string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            session.lastPing = Date.now();
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }

          // Status or media update from TV -> forward to all paired controllers
          if (msg.type === "media_status" || msg.type === "page_status") {
            for (const c of session.pairedControllers) {
              if (c.readyState === WebSocket.OPEN) {
                c.send(raw.toString());
              }
            }
          }
        } catch {}
      });

      ws.on("close", () => {
        log("INFO", `TV Display disconnected: ${displayId}`, "remote");
        pinMap.delete(session.pin);
        displays.delete(displayId);
        for (const c of session.pairedControllers) {
          try {
            c.send(JSON.stringify({ type: "display_disconnected", error: "TV went offline" }));
          } catch {}
          controllerToDisplay.delete(c);
        }
      });

    } else if (role === "controller") {
      // Find matching display
      // The PIN shown on the TV pairs any signed-in phone (wrong guesses are
      // limited); without one, only a TV signed in to the same account.
      let targetDisplayId = "";
      const ip = ipOf(req);
      if (pin) {
        if (pinBlocked(ip)) {
          try { ws.send(JSON.stringify({ type: "error", error: "Too many wrong PINs. Try again in 10 minutes." })); } catch {}
          ws.close(1008, "Too many attempts");
          return;
        }
        targetDisplayId = pinMap.get(pin.trim()) || "";
        if (!targetDisplayId) pinFailed(ip);
      } else {
        let newest = 0;
        for (const [id, s] of displays.entries()) {
          if (s.userId === userId && s.ws.readyState === WebSocket.OPEN && s.lastPing >= newest) { targetDisplayId = id; newest = s.lastPing; }
        }
      }

      const session = targetDisplayId ? displays.get(targetDisplayId) : null;
      if (!session || session.ws.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "error",
          error: "Could not find an active TV display with that PIN.",
        }));
        ws.close(1008, "Display not found");
        return;
      }

      session.pairedControllers.add(ws);
      controllerToDisplay.set(ws, session.displayId);

      log("INFO", `Remote controller paired to TV: ${session.displayId} (controllers: ${session.pairedControllers.size})`, "remote");

      ws.send(JSON.stringify({
        type: "paired",
        displayId: session.displayId,
        pin: session.pin,
        displayDevice: session.deviceName,
      }));

      // Notify TV that a controller joined
      try {
        session.ws.send(JSON.stringify({
          type: "controller_joined",
          controllerCount: session.pairedControllers.size,
          deviceName,
        }));
      } catch {}

      ws.on("message", (raw: string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }

          // Forward control commands to display
          // Commands include:
          // { type: "nav", action: "up" | "down" | "left" | "right" | "confirm" | "cancel" | "home" | "menu" }
          // { type: "scroll", deltaY: number, smooth?: boolean }
          // { type: "media", action: "play_pause" | "seek" | "volume" | "mute" | "fullscreen", value?: number }
          // { type: "input", text: string, replace?: boolean, submit?: boolean }
          // { type: "navigate_tab", tab: string }
          if (session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(raw.toString());
          }
        } catch {}
      });

      ws.on("close", () => {
        session.pairedControllers.delete(ws);
        controllerToDisplay.delete(ws);
        try {
          if (session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({
              type: "controller_left",
              controllerCount: session.pairedControllers.size,
            }));
          }
        } catch {}
      });
    }
  });

  // REST API helper to discover active TV sessions
  app.get("/api/remote/active-displays", (req, res) => {
    // Only this account's own TVs (with their PINs).
    const raw = String(req.headers.authorization ?? "").replace(/^Bearer /i, "").trim() || String(req.query.token ?? "");
    const me = userFromToken(raw);
    if (!me) return res.status(401).json({ ok: false, error: "Sign in required" });
    const list: Array<{ displayId: string; pin: string; name: string; ageSec: number }> = [];
    const now = Date.now();
    for (const [id, s] of displays.entries()) {
      if (s.ws.readyState === WebSocket.OPEN && s.userId === me) {
        list.push({
          displayId: id,
          pin: s.pin,
          name: s.deviceName,
          ageSec: Math.round((now - s.createdAt) / 1000),
        });
      }
    }
    return res.json({ ok: true, displays: list });
  });

  log("INFO", "Remote Control WebSocket server ready at /ws/remote", "remote");

  return {
    wss,
    displays,
    pinMap,
  };
}
