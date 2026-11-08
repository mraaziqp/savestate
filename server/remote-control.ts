import type express from "express";
import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

export type RemoteControlDeps = {
  httpServer: http.Server;
  app: express.Express;
  log: (level: string, msg: string, subsystem?: string) => void;
  getOptionalAuthUser?: (req: express.Request) => any;
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
  const { httpServer, app, log, getOptionalAuthUser } = deps;

  const wss = new WebSocketServer({ noServer: true });

  const displays = new Map<string, DisplaySession>(); // displayId -> DisplaySession
  const pinMap = new Map<string, string>(); // PIN -> displayId
  const controllerToDisplay = new Map<WebSocket, string>(); // controllerWs -> displayId

  function generatePin(): string {
    for (let attempts = 0; attempts < 100; attempts++) {
      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      if (!pinMap.has(pin)) return pin;
    }
    return Math.floor(1000 + Math.random() * 9000).toString();
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
    const userId = url.searchParams.get("userId") ?? null;
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

      ws.send(JSON.stringify({
        type: "registered",
        displayId,
        pin: assignedPin,
        deviceName,
      }));

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
      let targetDisplayId = "";
      if (pin) {
        targetDisplayId = pinMap.get(pin.trim()) || "";
      } else if (userId) {
        // Auto-match display for same user
        for (const [id, s] of displays.entries()) {
          if (s.userId && s.userId === userId) {
            targetDisplayId = id;
            break;
          }
        }
      }

      // If no pin or userId match, but there's exactly one display active on server, auto-connect
      if (!targetDisplayId && displays.size === 1) {
        targetDisplayId = Array.from(displays.keys())[0];
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
    const list: Array<{ displayId: string; pin: string; name: string; ageSec: number }> = [];
    const now = Date.now();
    for (const [id, s] of displays.entries()) {
      if (s.ws.readyState === WebSocket.OPEN) {
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
