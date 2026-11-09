import React, { useState, useEffect, useRef, useCallback } from "react";
import { useStyles, api, token, goTab, Note } from "./lib.jsx";

// Haptic feedback helper
const vibrate = (ms = 25) => {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(ms);
    }
  } catch {}
};

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Dedicated Mouse Scroll Wheel Component:
 * - High-precision tactile vertical wheel with rotating cylindrical ribbing.
 * - Inertial momentum with physics decay curve on release (requestAnimationFrame).
 * - Instantaneous 60fps delta dispatches (no smooth-scroll queue stalls).
 * - Sensitivity multipliers (1x, 2x, 4x) & Stepped Page buttons.
 */
function MouseWheelWidget({ onScroll, onStep, speed = 2, onSpeedChange, compact = false }) {
  const [offsetY, setOffsetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStateRef = useRef({ lastY: 0, lastTime: 0, velocity: 0 });
  const animFrameRef = useRef(null);
  const lastTickDistRef = useRef(0);

  const stopMomentum = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  };

  const startMomentum = (initialVelocity) => {
    stopMomentum();
    let v = initialVelocity;
    const step = () => {
      if (Math.abs(v) < 0.04) {
        animFrameRef.current = null;
        return;
      }
      const delta = v * 14 * speed;
      onScroll(delta, false);
      setOffsetY((prev) => (prev + delta * 0.4) % 120);

      // Decay velocity with friction
      v *= 0.92;
      animFrameRef.current = requestAnimationFrame(step);
    };
    animFrameRef.current = requestAnimationFrame(step);
  };

  const handleTouchStart = (e) => {
    stopMomentum();
    const t = e.touches[0];
    touchStateRef.current = {
      lastY: t.clientY,
      lastTime: performance.now(),
      velocity: 0,
    };
    lastTickDistRef.current = 0;
    setIsDragging(true);
    vibrate(10);
  };

  const handleTouchMove = (e) => {
    if (!touchStateRef.current.lastY) return;
    const t = e.touches[0];
    const now = performance.now();
    const dy = touchStateRef.current.lastY - t.clientY;
    const dt = Math.max(1, now - touchStateRef.current.lastTime);

    // Instantaneous velocity (px/ms)
    const currentV = dy / dt;
    touchStateRef.current.velocity = touchStateRef.current.velocity * 0.3 + currentV * 0.7;
    touchStateRef.current.lastY = t.clientY;
    touchStateRef.current.lastTime = now;

    if (Math.abs(dy) > 0.5) {
      const scrollDelta = dy * 2.2 * speed;
      onScroll(scrollDelta, false);
      setOffsetY((prev) => (prev + scrollDelta * 0.4) % 120);

      // Haptic tick sensation on threshold
      lastTickDistRef.current += Math.abs(dy);
      if (lastTickDistRef.current > 18) {
        vibrate(6);
        lastTickDistRef.current = 0;
      }
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    const v = touchStateRef.current.velocity;
    if (Math.abs(v) > 0.15) {
      startMomentum(v);
    }
  };

  useEffect(() => {
    return () => stopMomentum();
  }, []);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      userSelect: "none",
      touchAction: "none",
    }}>
      {/* Top Stepper: Page / Line Up */}
      <button
        onClick={() => { vibrate(15); onStep(-380); }}
        style={{
          width: compact ? 48 : 64,
          height: 32,
          background: "rgba(255, 255, 255, 0.08)",
          border: "1px solid rgba(255, 255, 255, 0.15)",
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
          color: "#93c5fd",
          fontSize: 13,
          fontWeight: 800,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
        }}
        title="Scroll Up (Page)"
      >
        ▲
      </button>

      {/* Cylindrical Mouse Wheel Track */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          width: compact ? 48 : 64,
          height: compact ? 140 : 180,
          background: isDragging
            ? "radial-gradient(ellipse at center, #1e293b 0%, #090d16 100%)"
            : "radial-gradient(ellipse at center, #182234 0%, #070a12 100%)",
          borderLeft: "2px solid rgba(255,255,255,0.2)",
          borderRight: "2px solid rgba(255,255,255,0.2)",
          position: "relative",
          overflow: "hidden",
          cursor: "ns-resize",
          boxShadow: isDragging
            ? "0 0 20px rgba(56, 189, 248, 0.35), inset 0 0 16px rgba(0,0,0,0.8)"
            : "inset 0 0 14px rgba(0,0,0,0.8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Repeating Wheel Grooves / Ribs */}
        <div style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-around",
          transform: `translateY(${(-offsetY % 20)}px)`,
          pointerEvents: "none",
        }}>
          {[-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div
              key={i}
              style={{
                width: "75%",
                height: 3,
                margin: "5px auto",
                background: "linear-gradient(90deg, rgba(255,255,255,0.06), rgba(255,255,255,0.45) 50%, rgba(255,255,255,0.06))",
                borderRadius: 2,
                boxShadow: "0 1px 2px rgba(0,0,0,0.8)",
              }}
            />
          ))}
        </div>

        {/* Center Illuminated Alignment Notch */}
        <div style={{
          width: "88%",
          height: 6,
          background: isDragging
            ? "linear-gradient(90deg, #0284c7, #38bdf8, #0284c7)"
            : "linear-gradient(90deg, rgba(56,189,248,0.4), #38bdf8, rgba(56,189,248,0.4))",
          borderRadius: 3,
          boxShadow: isDragging ? "0 0 10px #38bdf8" : "0 0 4px #38bdf8",
          zIndex: 2,
          pointerEvents: "none",
        }} />
      </div>

      {/* Bottom Stepper: Page / Line Down */}
      <button
        onClick={() => { vibrate(15); onStep(380); }}
        style={{
          width: compact ? 48 : 64,
          height: 32,
          background: "rgba(255, 255, 255, 0.08)",
          border: "1px solid rgba(255, 255, 255, 0.15)",
          borderBottomLeftRadius: 12,
          borderBottomRightRadius: 12,
          color: "#93c5fd",
          fontSize: 13,
          fontWeight: 800,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.2)",
        }}
        title="Scroll Down (Page)"
      >
        ▼
      </button>

      {/* Speed Selector Toggle */}
      {onSpeedChange && (
        <div style={{ display: "flex", gap: 3, marginTop: 8 }}>
          {[1, 2, 4].map((s) => (
            <button
              key={s}
              onClick={() => { vibrate(10); onSpeedChange(s); }}
              style={{
                border: "none",
                background: speed === s ? "#3b82f6" : "rgba(255,255,255,0.08)",
                color: speed === s ? "#fff" : "#94a3b8",
                fontSize: 10,
                fontWeight: 800,
                padding: "3px 7px",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {s}x
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * TV Control Mirror Dock:
 * Floats at the bottom of the smartphone screen when paired with a TV.
 * Allows the user to navigate the webapp natively while keeping TV remote in sync.
 * Includes Spotify Connect-style mini media player when TV is playing video.
 */
function TvControlMirrorDock({
  pairedDisplay,
  mediaState,
  mirrorActive,
  onToggleMirror,
  syncTabs,
  onToggleSyncTabs,
  onOpenRemote,
  onDisconnect,
  onMediaAction,
}) {
  const [showOptions, setShowOptions] = useState(false);

  return (
    <div style={{
      position: "fixed",
      bottom: 12,
      left: "50%",
      transform: "translateX(-50%)",
      width: "calc(100% - 24px)",
      maxWidth: 480,
      zIndex: 9000,
      background: "rgba(15, 23, 42, 0.94)",
      backdropFilter: "blur(20px)",
      border: "1px solid rgba(255, 255, 255, 0.18)",
      borderRadius: 20,
      padding: "10px 14px",
      boxShadow: "0 12px 35px rgba(0, 0, 0, 0.65), 0 0 1px rgba(255, 255, 255, 0.2)",
      color: "#fff",
      fontFamily: "system-ui, -apple-system, sans-serif",
      userSelect: "none",
    }}>
      {/* Active Playing Media Bar (if TV is playing) */}
      {mediaState.isVideo && (
        <div style={{
          marginBottom: 8,
          paddingBottom: 8,
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 16 }}>🎬</span>
              <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {mediaState.title || "Now Playing on TV"}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
              {formatTime(mediaState.currentTime)} / {formatTime(mediaState.duration)}
            </div>
          </div>

          {/* Mini Scrubber */}
          {mediaState.duration > 0 && (
            <input
              type="range"
              min={0}
              max={mediaState.duration}
              value={mediaState.currentTime}
              onChange={(e) => onMediaAction("seek_to", Number(e.target.value))}
              style={{
                width: "100%",
                accentColor: "#38bdf8",
                height: 4,
                cursor: "pointer",
                display: "block",
                marginBottom: 6,
              }}
            />
          )}

          {/* Playback Action Buttons */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => onMediaAction("seek", -10)}
                style={miniMediaBtn}
                title="Rewind 10s"
              >
                ⏪ 10s
              </button>
              <button
                onClick={() => onMediaAction("play_pause")}
                style={{ ...miniMediaBtn, background: "#3b82f6", color: "#fff", padding: "4px 12px", fontWeight: 800 }}
                title="Play/Pause"
              >
                {mediaState.playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <button
                onClick={() => onMediaAction("seek", 10)}
                style={miniMediaBtn}
                title="Forward 10s"
              >
                10s ⏩
              </button>
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => onMediaAction("subtitles")} style={miniMediaBtn} title="Subtitles">
                💬 CC
              </button>
              <button onClick={() => onMediaAction("volume", -0.1)} style={miniMediaBtn} title="Vol -">
                🔉
              </button>
              <button onClick={() => onMediaAction("volume", 0.1)} style={miniMediaBtn} title="Vol +">
                🔊
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Dock Navigation & TV Session Row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#10b981",
            boxShadow: "0 0 8px #10b981",
            flexShrink: 0,
          }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              📺 {pairedDisplay?.name || "Connected TV"}
            </div>
            <div style={{ fontSize: 10, color: mirrorActive ? "#38bdf8" : "#94a3b8", fontWeight: 600 }}>
              {mirrorActive ? "⚡ Control Mirror Active" : "Remote Standby"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {/* Mirror Toggle Button */}
          <button
            onClick={onToggleMirror}
            style={{
              background: mirrorActive ? "rgba(56, 189, 248, 0.2)" : "rgba(255, 255, 255, 0.08)",
              border: `1px solid ${mirrorActive ? "rgba(56, 189, 248, 0.4)" : "rgba(255, 255, 255, 0.12)"}`,
              borderRadius: 10,
              padding: "5px 10px",
              color: mirrorActive ? "#38bdf8" : "#94a3b8",
              fontSize: 11,
              fontWeight: 800,
              cursor: "pointer",
            }}
            title="When active, tapping Play on games or movies plays them on the TV"
          >
            ⚡ Mirror: {mirrorActive ? "ON" : "OFF"}
          </button>

          {/* Open Full Remote Button */}
          <button
            onClick={onOpenRemote}
            style={{
              background: "#3b82f6",
              border: "none",
              borderRadius: 10,
              padding: "6px 12px",
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(59, 130, 246, 0.4)",
            }}
          >
            🎮 Remote
          </button>

          {/* Options / More Toggle */}
          <button
            onClick={() => setShowOptions(!showOptions)}
            style={{
              background: "rgba(255, 255, 255, 0.08)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: 10,
              padding: "6px 8px",
              color: "#cbd5e1",
              fontSize: 12,
              cursor: "pointer",
            }}
            title="Settings & Sync"
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* Expanded Quick Settings Tray */}
      {showOptions && (
        <div style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: "1px solid rgba(255,255,255,0.1)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 12,
        }}>
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
            <span style={{ color: "#cbd5e1" }}>🔄 Sync Tabs with TV (TV follows phone view)</span>
            <input
              type="checkbox"
              checked={syncTabs}
              onChange={onToggleSyncTabs}
              style={{ accentColor: "#38bdf8", width: 16, height: 16 }}
            />
          </label>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4 }}>
            <span style={{ fontSize: 11, color: "#64748b" }}>TV PIN: {pairedDisplay?.pin}</span>
            <button
              onClick={onDisconnect}
              style={{
                background: "rgba(239, 68, 68, 0.15)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                borderRadius: 8,
                padding: "3px 10px",
                color: "#fca5a5",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Disconnect TV
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * TV Remote Component:
 * - Full tactile TV remote pad with D-Pad, Mouse Scroller & Trackpad, Media bar, and Gamepad.
 * - Control Mirror Mode: browse normally on smartphone with lightweight WebSocket intent syncing (no screenshare lag).
 * - Background TV Display Listener on big screens.
 */
// A screen that can be a TV for the remote: not the remote page itself, and
// not a phone (small screen) unless it says it's a TV (Android TV, Fire TV and
// smart TVs also report "Android" or a small CSS width).
function canBeTv() {
  if (typeof window === "undefined") return false;
  const sp = new URLSearchParams(window.location.search);
  if (sp.has("remote") || window.location.hash.includes("remote")) return false;
  const ua = navigator.userAgent;
  if (/\b(tv|aft\w*|bravia|smart-?tv|googletv|crkey|web0s|tizen)\b/i.test(ua)) return true;
  const short = Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight);
  return !(/iphone|ipod|mobile/i.test(ua) || (/android/i.test(ua) && short < 600) || short < 500);
}

export function TvRemote() {
  useStyles();
  const [isOpen, setIsOpen] = useState(false);
  const [pairedDisplay, setPairedDisplay] = useState(null); // { displayId, pin, name }
  const [displays, setDisplays] = useState([]);
  const [pinInput, setPinInput] = useState("");
  const [status, setStatus] = useState("disconnected"); // "disconnected" | "connecting" | "connected"
  const [error, setError] = useState("");
  const [mode, setMode] = useState("dpad"); // "dpad" | "trackpad" | "media" | "gamepad"
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [inputText, setInputText] = useState("");
  const [mediaState, setMediaState] = useState({ playing: false, currentTime: 0, duration: 0, title: "", isVideo: false });
  const [mirrorActive, setMirrorActive] = useState(true);
  const [syncTabs, setSyncTabs] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(2);
  const [pointerMode, setPointerMode] = useState(false);
  const [toast, setToast] = useState(null); // { message, icon, actionLabel, onAction }

  const wsRef = useRef(null);
  const toastTimerRef = useRef(null);
  const pointerPosRef = useRef({ x: 0.5, y: 0.5 });

  // Show floating mobile toast notification
  const showToast = useCallback((message, icon = "📺", actionLabel = null, onAction = null) => {
    clearTimeout(toastTimerRef.current);
    setToast({ message, icon, actionLabel, onAction });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }, []);

  // Check if current device is a phone or opened via ?remote=1 / #remote
  const isMobile = typeof window !== "undefined" && (
    /iphone|ipad|ipod|android|mobile/i.test(navigator.userAgent) ||
    window.innerWidth <= 768 ||
    new URLSearchParams(window.location.search).has("remote") ||
    window.location.hash.includes("remote")
  );

  // Auto-fetch active displays on network
  const refreshDisplays = useCallback(async () => {
    try {
      const data = await api("/api/remote/active-displays");
      if (data?.displays) {
        setDisplays(data.displays);
      }
    } catch {}
  }, []);

  useEffect(() => {
    refreshDisplays();
    const t = setInterval(refreshDisplays, 10000);
    return () => clearInterval(t);
  }, [refreshDisplays]);

  // Connect to WebSocket as controller
  const connectToDisplay = useCallback((targetPin) => {
    // The old connection is silenced before it closes: its close event used to
    // land after the new one connected and mark the phone "not paired", which
    // made the page connect again, closing that one, over and over.
    const old = wsRef.current;
    if (old) {
      old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch {}
    }

    setStatus("connecting");
    setError("");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/remote?role=controller&token=${encodeURIComponent(token())}&pin=${encodeURIComponent(targetPin || "")}&name=${encodeURIComponent(navigator.userAgent.includes("Android") ? "Android Phone" : "Smartphone")}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      if (wsRef.current !== ws) return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "paired") {
          setStatus("connected");
          setPairedDisplay({ displayId: msg.displayId, pin: msg.pin, name: msg.displayDevice });
          try { localStorage.setItem("nx_tv_remote_pin", msg.pin); } catch {}
          vibrate(40);
          showToast(`Connected to ${msg.displayDevice}`, "📺");
        } else if (msg.type === "media_status") {
          setMediaState({
            playing: !!msg.playing,
            currentTime: msg.currentTime || 0,
            duration: msg.duration || 0,
            title: msg.title || "",
            isVideo: !!msg.isVideo,
          });
        } else if (msg.type === "display_disconnected" || msg.type === "error") {
          setStatus("disconnected");
          setPairedDisplay(null);
          setError(msg.error || "TV disconnected");
        }
      } catch {}
    };

    ws.onclose = () => {
      if (wsRef.current === ws) setStatus("disconnected");
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setStatus("disconnected");
      setError("Failed to connect to TV remote service");
    };
  }, [showToast]);

  // Send control command
  const send = useCallback((payload) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  // Directional actions & Scrolling
  const nav = (action) => {
    vibrate(20);
    send({ type: "nav", action });
  };

  const handleScroll = (deltaY, smooth = false) => {
    send({ type: "scroll", deltaY, smooth });
  };

  const handleStep = (stepDelta) => {
    send({ type: "scroll", deltaY: stepDelta, smooth: true });
  };

  const media = (action, value) => {
    vibrate(20);
    send({ type: "media", action, value });
  };

  // Launch on TV intent (mirror action for games)
  const launchOnTv = useCallback((game) => {
    vibrate(35);
    send({ type: "launch_game", game });
    showToast(`Launched ${game.title} on ${pairedDisplay?.name || "TV"}`, "🎮", "Open Gamepad", () => {
      setMode("gamepad");
      setIsOpen(true);
    });
  }, [send, pairedDisplay, showToast]);

  // Play on TV intent (mirror action for movies/episodes)
  const playOnTv = useCallback((item, queue = null) => {
    vibrate(35);
    send({ type: "play_media", item, queue, title: item?.name || "Media" });
    showToast(`Streaming ${item?.name ? item.name.replace(/\.[^/.]+$/, "") : "Media"} to ${pairedDisplay?.name || "TV"}`, "🎬", "Open Controls", () => {
      setMode("media");
      setIsOpen(true);
    });
  }, [send, pairedDisplay, showToast]);

  // Register global remote helper on window so PlayOverlay, MediaLibrary, and LibraryManager can route intents
  useEffect(() => {
    window.__nxTvRemote = {
      isPaired: status === "connected",
      isMirrorActive: status === "connected" && mirrorActive,
      pairedDisplay,
      send,
      launchOnTv,
      playOnTv,
      openRemote: (targetMode) => {
        setIsOpen(true);
        if (targetMode) setMode(targetMode);
      },
      syncTabs,
    };
    return () => {
      delete window.__nxTvRemote;
    };
  }, [status, mirrorActive, pairedDisplay, send, launchOnTv, playOnTv, syncTabs]);

  // Tab Syncing: notify TV when phone navigates tabs
  useEffect(() => {
    const onNavTab = (e) => {
      const tab = e?.detail?.tab;
      if (tab && mirrorActive && syncTabs && status === "connected") {
        send({ type: "navigate_tab", tab });
      }
    };
    window.addEventListener("nexus:navigate-tab", onNavTab);
    return () => window.removeEventListener("nexus:navigate-tab", onNavTab);
  }, [mirrorActive, syncTabs, status, send]);

  // Handle mobile text submission
  const handleInputSubmit = (e) => {
    e?.preventDefault?.();
    if (inputText) {
      send({ type: "input", text: inputText, replace: true, submit: true });
      setShowSearchModal(false);
      setInputText("");
    }
  };

  const handleInputLiveChange = (val) => {
    setInputText(val);
    send({ type: "input", text: val, replace: true, submit: false });
  };

  const handleSuggestionClick = (term) => {
    setInputText(term);
    send({ type: "input", text: term, replace: true, submit: true });
    setShowSearchModal(false);
  };

  // Touchpad drag handlers (Virtual pointer or Direct Pan)
  const trackpadTouchRef = useRef(null);
  const handleTrackpadStart = (e) => {
    const t = e.touches[0];
    trackpadTouchRef.current = { x: t.clientX, y: t.clientY, startX: t.clientX, startY: t.clientY, time: Date.now() };
  };

  const handleTrackpadMove = (e) => {
    if (!trackpadTouchRef.current) return;
    const t = e.touches[0];
    const dx = t.clientX - trackpadTouchRef.current.x;
    const dy = t.clientY - trackpadTouchRef.current.y;
    trackpadTouchRef.current.x = t.clientX;
    trackpadTouchRef.current.y = t.clientY;

    if (pointerMode) {
      // Relative pointer motion
      pointerPosRef.current.x = Math.max(0, Math.min(1, pointerPosRef.current.x + dx * 0.003));
      pointerPosRef.current.y = Math.max(0, Math.min(1, pointerPosRef.current.y + dy * 0.003));
      send({
        type: "pointer_move",
        x: pointerPosRef.current.x,
        y: pointerPosRef.current.y,
        dx,
        dy,
      });
    } else {
      // Direct smooth pan
      if (Math.abs(dy) > 2) {
        handleScroll(-dy * 2 * scrollSpeed, false);
      }
    }
  };

  const handleTrackpadEnd = () => {
    if (!trackpadTouchRef.current) return;
    const dist = Math.hypot(
      trackpadTouchRef.current.x - trackpadTouchRef.current.startX,
      trackpadTouchRef.current.y - trackpadTouchRef.current.startY
    );
    const duration = Date.now() - trackpadTouchRef.current.time;

    // Quick tap -> Click / Confirm
    if (dist < 8 && duration < 250) {
      vibrate(25);
      if (pointerMode) {
        send({ type: "pointer_click", x: pointerPosRef.current.x, y: pointerPosRef.current.y });
      } else {
        nav("confirm");
      }
    }
    trackpadTouchRef.current = null;
  };

  // Listen for open remote events from anywhere in the app
  useEffect(() => {
    const onOpen = (e) => {
      setIsOpen(true);
      if (e?.detail?.pin) {
        connectToDisplay(e.detail.pin);
      }
    };
    window.addEventListener("nexus:open-remote", onOpen);
    return () => window.removeEventListener("nexus:open-remote", onOpen);
  }, [connectToDisplay]);

  // If user opens ?remote=1 on phone or passes pin in URL, connect immediately
  const autoTried = useRef(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const isRemoteUrl = sp.has("remote") || window.location.hash.includes("remote");
    const pinParam = sp.get("pin");
    if (autoTried.current) return;

    if (isRemoteUrl || pinParam) {
      setIsOpen(true);
    }

    if (pinParam) {
      autoTried.current = true;
      setPinInput(pinParam);
      connectToDisplay(pinParam);
    } else if (isRemoteUrl && status === "disconnected") {
      const saved = localStorage.getItem("nx_tv_remote_pin");
      if (saved && displays.some(d => d.pin === saved)) {
        autoTried.current = true;
        setPinInput(saved);
        connectToDisplay(saved);
      } else if (displays.length === 1) {
        autoTried.current = true;
        connectToDisplay(displays[0].pin);
      }
    }
  }, [displays, status, connectToDisplay]);

  return (
    <>
      {/* TV Display sidecar: on screens that can be a TV, never on the phone
          doing the controlling. Every page used to register, phones included,
          so a phone was offered itself (and other phones) as a TV to pair. */}
      {canBeTv() && <TvDisplayListener onOpenRemote={() => setIsOpen(true)} />}

      {/* Floating Control Mirror Dock: persists at bottom while browsing app normally */}
      {status === "connected" && !isOpen && (
        <TvControlMirrorDock
          pairedDisplay={pairedDisplay}
          mediaState={mediaState}
          mirrorActive={mirrorActive}
          onToggleMirror={() => { vibrate(15); setMirrorActive(!mirrorActive); }}
          syncTabs={syncTabs}
          onToggleSyncTabs={() => { vibrate(15); setSyncTabs(!syncTabs); }}
          onOpenRemote={() => setIsOpen(true)}
          onDisconnect={() => {
            try { wsRef.current?.close(); } catch {}
            setStatus("disconnected");
            setPairedDisplay(null);
          }}
          onMediaAction={media}
        />
      )}

      {/* Toast Notification for Mirrored Intents */}
      {toast && (
        <div style={{
          position: "fixed",
          top: 18,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 100001,
          background: "rgba(15, 23, 42, 0.95)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(56, 189, 248, 0.4)",
          boxShadow: "0 10px 30px rgba(0, 0, 0, 0.6)",
          borderRadius: 24,
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "#fff",
          fontSize: 13,
          fontWeight: 700,
          maxWidth: "90%",
        }}>
          <span style={{ fontSize: 18 }}>{toast.icon}</span>
          <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {toast.message}
          </span>
          {toast.actionLabel && (
            <button
              onClick={() => { toast.onAction?.(); setToast(null); }}
              style={{
                background: "#38bdf8",
                border: "none",
                borderRadius: 12,
                padding: "4px 10px",
                color: "#0f172a",
                fontSize: 11,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {toast.actionLabel}
            </button>
          )}
        </div>
      )}

      {/* Full tactile Remote Modal Interface */}
      {isOpen && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "radial-gradient(circle at 50% 15%, #1e293b 0%, #090d16 100%)",
          zIndex: 99999,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 18px 20px",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, sans-serif",
          touchAction: "manipulation",
          userSelect: "none",
          overflowY: "auto",
        }}>
          {/* Top Bar: TV status & Control Mirror Minimizer */}
          <div style={{ width: "100%", maxWidth: 420, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: status === "connected" ? "#10b981" : status === "connecting" ? "#f59e0b" : "#ef4444",
                boxShadow: status === "connected" ? "0 0 10px #10b981" : "none",
              }} />
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {status === "connected" ? (pairedDisplay?.name || "Connected to TV") : "Not Paired"}
              </div>
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              {status === "connected" && (
                <button
                  onClick={() => setIsOpen(false)}
                  style={{
                    background: "linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(59, 130, 246, 0.25))",
                    border: "1px solid rgba(56, 189, 248, 0.4)",
                    borderRadius: 16,
                    padding: "5px 12px",
                    color: "#38bdf8",
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                  title="Browse SaveState normally on your phone while controlling TV in the background"
                >
                  <span>📱</span>
                  <span>Browse Phone</span>
                </button>
              )}

              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: "rgba(255,255,255,0.1)",
                  border: "none",
                  borderRadius: 16,
                  padding: "5px 12px",
                  color: "#cbd5e1",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                ✕ Close
              </button>
            </div>
          </div>

          {/* Pairing Screen if not connected */}
          {status !== "connected" ? (
            <div style={{ width: "100%", maxWidth: 360, textAlign: "center", margin: "auto 0" }}>
              <div style={{ fontSize: 48, marginBottom: 10 }}>📱 ➔ 📺</div>
              <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 6px" }}>Connect to TV</h2>
              <p style={{ fontSize: 14, color: "#94a3b8", margin: "0 0 20px" }}>
                Scan the QR code on your TV or enter the 6-digit PIN below.
              </p>

              {/* One-Tap Connect if exactly 1 TV detected on network */}
              {displays.length === 1 && (
                <div style={{ marginBottom: 20 }}>
                  <button
                    onClick={() => { setPinInput(displays[0].pin); connectToDisplay(displays[0].pin); }}
                    style={{
                      width: "100%",
                      padding: "16px 20px",
                      background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                      border: "none",
                      borderRadius: 16,
                      color: "#fff",
                      fontWeight: 800,
                      fontSize: 15,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 10,
                      boxShadow: "0 8px 24px rgba(59, 130, 246, 0.4)",
                    }}
                  >
                    <span>📺</span>
                    <span>1-Tap Connect: {displays[0].name}</span>
                  </button>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
                    Detected automatically on your Wi-Fi (PIN: {displays[0].pin})
                  </div>
                </div>
              )}

              {error && (
                <div style={{ background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", color: "#fca5a5", padding: "8px 12px", borderRadius: 10, fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 20 }}>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="PIN"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))}
                  style={{
                    width: 140,
                    height: 52,
                    fontSize: 26,
                    fontWeight: 800,
                    letterSpacing: 6,
                    textAlign: "center",
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 14,
                    color: "#fff",
                    outline: "none",
                  }}
                />
                <button
                  onClick={() => connectToDisplay(pinInput)}
                  disabled={pinInput.length < 6 || status === "connecting"}
                  style={{
                    padding: "0 22px",
                    height: 52,
                    background: pinInput.length === 6 ? "#3b82f6" : "rgba(255,255,255,0.1)",
                    border: "none",
                    borderRadius: 14,
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: pinInput.length === 6 ? "pointer" : "default",
                  }}
                >
                  {status === "connecting" ? "Pairing..." : "Connect"}
                </button>
              </div>

              {/* Active TVs list if multiple detected */}
              {displays.length > 1 && (
                <div style={{ marginTop: 20, textAlign: "left" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#64748b", marginBottom: 8 }}>
                    Available TVs on Wi-Fi:
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {displays.map((d) => (
                      <button
                        key={d.displayId}
                        onClick={() => { setPinInput(d.pin); connectToDisplay(d.pin); }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "12px 16px",
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 12,
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 20 }}>📺</span>
                          <span style={{ fontWeight: 600 }}>{d.name}</span>
                        </div>
                        <span style={{ fontSize: 13, background: "rgba(59, 130, 246, 0.25)", color: "#60a5fa", padding: "4px 8px", borderRadius: 6, fontWeight: 800 }}>
                          PIN: {d.pin}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Connected Remote Pad */
            <div style={{ width: "100%", maxWidth: 410, display: "flex", flexDirection: "column", gap: 12, margin: "auto 0" }}>

              {/* Mode Selector Tabs */}
              <div style={{ display: "flex", background: "rgba(255,255,255,0.08)", borderRadius: 14, padding: 4, gap: 4 }}>
                <button
                  onClick={() => setMode("dpad")}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    border: "none",
                    borderRadius: 10,
                    background: mode === "dpad" ? "#3b82f6" : "transparent",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  🎮 D-Pad
                </button>
                <button
                  onClick={() => setMode("trackpad")}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    border: "none",
                    borderRadius: 10,
                    background: mode === "trackpad" ? "#3b82f6" : "transparent",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  🖱️ Mouse & Wheel
                </button>
                <button
                  onClick={() => setMode("media")}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    border: "none",
                    borderRadius: 10,
                    background: mode === "media" ? "#3b82f6" : "transparent",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  🎬 Media
                </button>
                <button
                  onClick={() => setMode("gamepad")}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    border: "none",
                    borderRadius: 10,
                    background: mode === "gamepad" ? "#3b82f6" : "transparent",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  🕹️ Gamepad
                </button>
              </div>

              {/* Mode 1: Tactile D-Pad Controller with Companion Mouse Wheel */}
              {mode === "dpad" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                  {/* Quick Back, Search & Home Bar */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "space-between", padding: "0 6px" }}>
                    <button onClick={() => nav("cancel")} style={pillControlBtn} title="Back / Escape">
                      ◀ Back
                    </button>
                    <button onClick={() => setShowSearchModal(true)} style={{ ...pillControlBtn, background: "rgba(59,130,246,0.25)", color: "#60a5fa" }} title="Type to Search TV">
                      🔍 Search TV
                    </button>
                    <button onClick={() => nav("home")} style={pillControlBtn} title="Home / Top">
                      🏠 Home
                    </button>
                  </div>

                  {/* Dual Pad Zone: Circular D-Pad on Left + Mouse Wheel Strip on Right */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, width: "100%", padding: "4px 0" }}>
                    {/* Circular D-Pad */}
                    <div style={{
                      width: 230,
                      height: 230,
                      borderRadius: "50%",
                      background: "rgba(255, 255, 255, 0.05)",
                      border: "2px solid rgba(255, 255, 255, 0.12)",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                      flexShrink: 0,
                    }}>
                      {/* UP */}
                      <button
                        onClick={() => nav("up")}
                        style={{ ...dpadArrowStyle, top: 10, left: "50%", transform: "translateX(-50%)" }}
                        aria-label="Up"
                      >
                        ▲
                      </button>

                      {/* DOWN */}
                      <button
                        onClick={() => nav("down")}
                        style={{ ...dpadArrowStyle, bottom: 10, left: "50%", transform: "translateX(-50%)" }}
                        aria-label="Down"
                      >
                        ▼
                      </button>

                      {/* LEFT */}
                      <button
                        onClick={() => nav("left")}
                        style={{ ...dpadArrowStyle, left: 10, top: "50%", transform: "translateY(-50%)" }}
                        aria-label="Left"
                      >
                        ◀
                      </button>

                      {/* RIGHT */}
                      <button
                        onClick={() => nav("right")}
                        style={{ ...dpadArrowStyle, right: 10, top: "50%", transform: "translateY(-50%)" }}
                        aria-label="Right"
                      >
                        ▶
                      </button>

                      {/* CENTER OK / SELECT */}
                      <button
                        onClick={() => nav("confirm")}
                        style={{
                          width: 80,
                          height: 80,
                          borderRadius: "50%",
                          background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                          border: "2px solid rgba(255, 255, 255, 0.3)",
                          boxShadow: "0 4px 15px rgba(59, 130, 246, 0.4)",
                          color: "#fff",
                          fontSize: 17,
                          fontWeight: 800,
                          cursor: "pointer",
                        }}
                        aria-label="OK / Select"
                      >
                        OK
                      </button>
                    </div>

                    {/* Integrated Mouse Scroller on side */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: "#38bdf8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                        Scroll
                      </div>
                      <MouseWheelWidget
                        onScroll={handleScroll}
                        onStep={handleStep}
                        speed={scrollSpeed}
                        compact={true}
                      />
                    </div>
                  </div>

                  {/* Volume Control Rocker right under D-Pad */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "center", gap: 8 }}>
                    <button
                      onClick={() => media("volume", -0.1)}
                      style={{ ...pillControlBtn, flex: 1, padding: "10px 0" }}
                      title="Volume Down"
                    >
                      🔉 Vol -
                    </button>
                    <button
                      onClick={() => media("mute")}
                      style={{ ...pillControlBtn, flex: 1, padding: "10px 0" }}
                      title="Mute Audio"
                    >
                      🔇 Mute
                    </button>
                    <button
                      onClick={() => media("volume", 0.1)}
                      style={{ ...pillControlBtn, flex: 1, padding: "10px 0" }}
                      title="Volume Up"
                    >
                      🔊 Vol +
                    </button>
                  </div>

                  {/* Audio Track, Subtitles & Skip Intro Quick Actions */}
                  <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                    <button
                      onClick={() => media("next_audio")}
                      style={{ ...pillControlBtn, flex: 1, padding: "10px 0" }}
                      title="Cycle / Switch Audio Track"
                    >
                      🎧 Audio
                    </button>
                    <button
                      onClick={() => media("subtitles")}
                      style={{ ...pillControlBtn, flex: 1, padding: "10px 0" }}
                      title="Toggle Subtitles"
                    >
                      💬 Subs
                    </button>
                    <button
                      onClick={() => media("skip_intro")}
                      style={{ ...pillControlBtn, flex: 1, padding: "10px 0" }}
                      title="Skip Opening / Intro"
                    >
                      ⏭️ Skip Intro
                    </button>
                  </div>
                </div>
              )}

              {/* Mode 2: Multi-Touch Trackpad + Dedicated Vertical Mouse Wheel */}
              {mode === "trackpad" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Mode Bar: Pointer vs Direct Pan */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 4px" }}>
                    <button
                      onClick={() => { vibrate(15); setPointerMode(!pointerMode); }}
                      style={{
                        background: pointerMode ? "rgba(56, 189, 248, 0.25)" : "rgba(255, 255, 255, 0.08)",
                        border: `1px solid ${pointerMode ? "#38bdf8" : "rgba(255,255,255,0.15)"}`,
                        borderRadius: 10,
                        padding: "5px 12px",
                        color: pointerMode ? "#38bdf8" : "#94a3b8",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {pointerMode ? "🖱️ TV Pointer: Active" : "👆 Direct Pan: Active"}
                    </button>

                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11, color: "#64748b" }}>Speed:</span>
                      {[1, 2, 4].map((s) => (
                        <button
                          key={s}
                          onClick={() => setScrollSpeed(s)}
                          style={{
                            border: "none",
                            background: scrollSpeed === s ? "#3b82f6" : "rgba(255,255,255,0.08)",
                            color: scrollSpeed === s ? "#fff" : "#94a3b8",
                            fontSize: 10,
                            fontWeight: 800,
                            padding: "3px 7px",
                            borderRadius: 6,
                            cursor: "pointer",
                          }}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Dual Gesture Pad + Mouse Wheel */}
                  <div style={{ display: "flex", gap: 10, alignItems: "stretch", height: 260 }}>
                    {/* Gesture Touchpad (Left 75%) */}
                    <div
                      onTouchStart={handleTrackpadStart}
                      onTouchMove={handleTrackpadMove}
                      onTouchEnd={handleTrackpadEnd}
                      style={{
                        flex: 1,
                        background: "rgba(255,255,255,0.05)",
                        border: "2px dashed rgba(255,255,255,0.18)",
                        borderRadius: 18,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 16,
                        textAlign: "center",
                        touchAction: "none",
                        cursor: pointerMode ? "crosshair" : "ns-resize",
                      }}
                    >
                      <div style={{ fontSize: 32, marginBottom: 6 }}>
                        {pointerMode ? "🎯" : "👆"}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {pointerMode ? "TV Pointer Surface" : "Smooth Pan & Tap"}
                      </div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4, maxWidth: 180 }}>
                        {pointerMode
                          ? "Move thumb to guide cursor on TV. Tap to click."
                          : "Drag up/down to glide. Tap anywhere to select."}
                      </div>
                    </div>

                    {/* Dedicated Vertical Mouse Scroll Wheel (Right 25%) */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <MouseWheelWidget
                        onScroll={handleScroll}
                        onStep={handleStep}
                        speed={scrollSpeed}
                        compact={false}
                      />
                    </div>
                  </div>

                  {/* Left / Right Click Bar */}
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    <button
                      onClick={() => { vibrate(20); if (pointerMode) send({ type: "pointer_click", x: pointerPosRef.current.x, y: pointerPosRef.current.y }); else nav("confirm"); }}
                      style={{ ...pillControlBtn, flex: 2, background: "#3b82f6", padding: "12px 0" }}
                    >
                      Left Click (Select)
                    </button>
                    <button
                      onClick={() => { vibrate(20); nav("cancel"); }}
                      style={{ ...pillControlBtn, flex: 1, padding: "12px 0" }}
                    >
                      Right Click (Back)
                    </button>
                  </div>
                </div>
              )}

              {/* Mode 3: Media Playback Controller */}
              {mode === "media" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* Current Playing Card */}
                  <div style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 16,
                    padding: "16px 18px",
                    textAlign: "center",
                  }}>
                    <div style={{ fontSize: 12, color: "#60a5fa", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>
                      {mediaState.isVideo ? "Now Playing on TV" : "Active Screen"}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {mediaState.title || "SaveState TV Hub"}
                    </div>

                    {mediaState.duration > 0 && (
                      <div style={{ marginTop: 12, padding: "0 4px" }}>
                        <input
                          type="range"
                          min={0}
                          max={mediaState.duration}
                          value={mediaState.currentTime}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setMediaState((s) => ({ ...s, currentTime: val }));
                            media("seek_to", val);
                          }}
                          style={{
                            width: "100%",
                            accentColor: "#38bdf8",
                            cursor: "pointer",
                            height: 6,
                            borderRadius: 3,
                          }}
                        />
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginTop: 4, fontFamily: "monospace" }}>
                          <span>{formatTime(mediaState.currentTime)}</span>
                          <span>{formatTime(mediaState.duration)}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Playback Controls */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
                    <button onClick={() => media("seek", -10)} style={circleMediaBtn} title="Rewind 10s">
                      ⏪ 10s
                    </button>

                    <button
                      onClick={() => media("play_pause")}
                      style={{
                        ...circleMediaBtn,
                        width: 72,
                        height: 72,
                        background: "#3b82f6",
                        fontSize: 26,
                        boxShadow: "0 4px 18px rgba(59, 130, 246, 0.5)",
                      }}
                      title="Play / Pause"
                    >
                      {mediaState.playing ? "⏸" : "▶"}
                    </button>

                    <button onClick={() => media("seek", 10)} style={circleMediaBtn} title="Forward 10s">
                      10s ⏩
                    </button>
                  </div>

                  {/* Subtitles, Speed & Fullscreen */}
                  <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                    <button onClick={() => media("subtitles")} style={{ ...pillControlBtn, flex: 1 }} title="Toggle Subtitles">
                      💬 CC
                    </button>
                    <button onClick={() => media("speed")} style={{ ...pillControlBtn, flex: 1 }} title="Cycle Speed">
                      ⏩ Speed
                    </button>
                    <button onClick={() => media("fullscreen")} style={{ ...pillControlBtn, flex: 1 }} title="Toggle Fullscreen">
                      ⛶ Screen
                    </button>
                  </div>

                  {/* Volume Controls */}
                  <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                    <button onClick={() => media("volume", -0.1)} style={{ ...pillControlBtn, flex: 1 }}>
                      🔉 Vol -
                    </button>
                    <button onClick={() => media("mute")} style={{ ...pillControlBtn, flex: 1 }}>
                      🔇 Mute
                    </button>
                    <button onClick={() => media("volume", 0.1)} style={{ ...pillControlBtn, flex: 1 }}>
                      🔊 Vol +
                    </button>
                  </div>
                </div>
              )}

              {/* Mode 4: Virtual Gamepad */}
              {mode === "gamepad" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "center" }}>
                  {/* Top Bumpers L1 / R1 */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "space-between", padding: "0 10px" }}>
                    <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "L1" }); }} style={{ ...pillControlBtn, width: 85, padding: "8px 0" }}>L1</button>
                    <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "R1" }); }} style={{ ...pillControlBtn, width: 85, padding: "8px 0" }}>R1</button>
                  </div>

                  {/* Main Pad Area: Left D-Pad + Right Action Buttons */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", padding: "0 10px" }}>
                    {/* Left Cross D-Pad */}
                    <div style={{ width: 130, height: 130, position: "relative" }}>
                      <button onClick={() => nav("up")} style={{ ...gamepadDpadBtn, top: 0, left: 45 }}>▲</button>
                      <button onClick={() => nav("left")} style={{ ...gamepadDpadBtn, top: 45, left: 0 }}>◀</button>
                      <button onClick={() => nav("right")} style={{ ...gamepadDpadBtn, top: 45, right: 0 }}>▶</button>
                      <button onClick={() => nav("down")} style={{ ...gamepadDpadBtn, bottom: 0, left: 45 }}>▼</button>
                    </div>

                    {/* Right Diamond ABXY Buttons */}
                    <div style={{ width: 130, height: 130, position: "relative" }}>
                      <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "Y" }); }} style={{ ...gamepadActionBtn, top: 0, left: 45, background: "#f59e0b" }}>Y</button>
                      <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "X" }); }} style={{ ...gamepadActionBtn, top: 45, left: 0, background: "#3b82f6" }}>X</button>
                      <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "B" }); }} style={{ ...gamepadActionBtn, top: 45, right: 0, background: "#ef4444" }}>B</button>
                      <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "A" }); }} style={{ ...gamepadActionBtn, bottom: 0, left: 45, background: "#10b981" }}>A</button>
                    </div>
                  </div>

                  {/* Center Select & Start */}
                  <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
                    <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "SELECT" }); }} style={{ ...pillControlBtn, fontSize: 11, padding: "6px 14px" }}>SELECT</button>
                    <button onClick={() => { vibrate(20); send({ type: "gamepad", button: "START" }); }} style={{ ...pillControlBtn, fontSize: 11, padding: "6px 14px", background: "rgba(59,130,246,0.25)", color: "#60a5fa" }}>START</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Quick TV App Jump Bar at Bottom */}
          {status === "connected" && (
            <div style={{
              width: "100%",
              maxWidth: 420,
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 6,
              background: "rgba(255,255,255,0.06)",
              padding: 6,
              borderRadius: 16,
            }}>
              <button onClick={() => { vibrate(15); send({ type: "navigate_tab", tab: "discover" }); }} style={quickTabBtnStyle}>
                <span>🏠</span> Home
              </button>
              <button onClick={() => { vibrate(15); send({ type: "navigate_tab", tab: "games" }); }} style={quickTabBtnStyle}>
                <span>🎮</span> Games
              </button>
              <button onClick={() => { vibrate(15); send({ type: "navigate_tab", tab: "media" }); }} style={quickTabBtnStyle}>
                <span>🎬</span> Movies
              </button>
              <button onClick={() => { vibrate(15); send({ type: "navigate_tab", tab: "music" }); }} style={quickTabBtnStyle}>
                <span>🎵</span> Music
              </button>
              <button onClick={() => { vibrate(15); send({ type: "navigate_tab", tab: "library" }); }} style={quickTabBtnStyle}>
                <span>💾</span> Library
              </button>
            </div>
          )}

          {/* Quick Mobile Keyboard Search Modal */}
          {showSearchModal && (
            <div style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.85)",
              backdropFilter: "blur(16px)",
              zIndex: 100000,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              padding: 24,
            }}>
              <div style={{ width: "100%", maxWidth: 360, textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 12px" }}>Search on TV</h3>

                <form onSubmit={handleInputSubmit} style={{ marginBottom: 14 }}>
                  <input
                    type="text"
                    autoFocus
                    placeholder="Type anything to search on TV..."
                    value={inputText}
                    onChange={(e) => handleInputLiveChange(e.target.value)}
                    style={{
                      width: "100%",
                      height: 48,
                      background: "rgba(255,255,255,0.1)",
                      border: "1px solid rgba(255,255,255,0.25)",
                      borderRadius: 12,
                      padding: "0 16px",
                      color: "#fff",
                      fontSize: 16,
                      outline: "none",
                      boxSizing: "border-box",
                      marginBottom: 10,
                    }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="submit"
                      style={{
                        flex: 1,
                        height: 44,
                        background: "#3b82f6",
                        border: "none",
                        borderRadius: 10,
                        color: "#fff",
                        fontWeight: 700,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      Search
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowSearchModal(false)}
                      style={{
                        padding: "0 16px",
                        height: 44,
                        background: "rgba(255,255,255,0.1)",
                        border: "none",
                        borderRadius: 10,
                        color: "#cbd5e1",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>

                {/* Popular Search Suggestions */}
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#64748b", marginBottom: 6 }}>
                    Quick Suggestions:
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {["GTA", "Spider-Man", "Mario", "Anime", "Action", "Horror", "PS2"].map((term) => (
                      <button
                        key={term}
                        onClick={() => handleSuggestionClick(term)}
                        style={{
                          background: "rgba(255,255,255,0.08)",
                          border: "1px solid rgba(255,255,255,0.12)",
                          borderRadius: 16,
                          padding: "4px 10px",
                          color: "#cbd5e1",
                          fontSize: 12,
                          cursor: "pointer",
                        }}
                      >
                        {term}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * TV Display Listener:
 * Runs in the background on the TV screen.
 * - Registers as display on `/ws/remote?role=display`.
 * - Auto-fades corner badge during full-screen playback.
 * - Displays on-screen TV Volume & Action HUD toast.
 * - Renders sleek neon virtual mouse pointer on TV when pointer mode is active.
 * - Translates incoming remote events to gamepad nav, video playback, and smooth scrolling!
 */
export function TvDisplayListener({ onOpenRemote }) {
  const [pin, setPin] = useState(null);
  const [qrData, setQrData] = useState(null);
  const [controllerCount, setControllerCount] = useState(0);
  const [showPairModal, setShowPairModal] = useState(false);
  const [isIdle, setIsIdle] = useState(false);
  // Never over a game: every key pressed while playing woke the badge, so it
  // kept flashing in the corner of the picture (2026-11-09).
  const [inGame, setInGame] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setInGame(!!(window.__nxGameOpen || document.getElementById("ejs-game-container"))), 1000);
    return () => clearInterval(t);
  }, []);
  const [volumeHud, setVolumeHud] = useState({ visible: false, text: "", icon: "🔊" });
  const [pointer, setPointer] = useState({ visible: false, x: 0, y: 0 });

  const wsRef = useRef(null);
  const volumeTimerRef = useRef(null);
  const pointerTimerRef = useRef(null);

  // Show on-screen TV Volume / Action Toast
  const showVolumeToast = useCallback((text, icon = "🔊") => {
    clearTimeout(volumeTimerRef.current);
    setVolumeHud({ visible: true, text, icon });
    volumeTimerRef.current = setTimeout(() => {
      setVolumeHud((s) => ({ ...s, visible: false }));
    }, 2200);
  }, []);

  // Auto-fade badge during fullscreen / inactive video playback
  useEffect(() => {
    let idleTimer = null;
    const resetIdle = () => {
      setIsIdle(false);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const isFs = !!document.fullscreenElement;
        const v = document.querySelector("video");
        const isPlaying = v && !v.paused;
        if (isFs || isPlaying) {
          setIsIdle(true);
        }
      }, 3500);
    };

    window.addEventListener("mousemove", resetIdle);
    window.addEventListener("keydown", resetIdle);
    resetIdle();

    return () => {
      clearTimeout(idleTimer);
      window.removeEventListener("mousemove", resetIdle);
      window.removeEventListener("keydown", resetIdle);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let ws = null;
    let keepAlive = null;

    const pushVideoStatus = () => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const v = document.querySelector("video");
      if (!v) return;
      try {
        wsRef.current.send(JSON.stringify({
          type: "media_status",
          playing: !v.paused,
          currentTime: Math.round(v.currentTime),
          duration: Math.round(v.duration || 0),
          title: document.title,
          isVideo: true,
        }));
      } catch {}
    };

    const onPlay = () => pushVideoStatus();
    const onPause = () => pushVideoStatus();
    const onSeeked = () => pushVideoStatus();
    document.addEventListener("play", onPlay, true);
    document.addEventListener("pause", onPause, true);
    document.addEventListener("seeked", onSeeked, true);

    const connectDisplay = () => {
      // Remote control needs a signed-in TV (the server refuses others).
      if (!token()) { setTimeout(connectDisplay, 30000); return; }
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      // A name people recognise in the phone's list (the page title said
      // "SaveState | Your Media & Games Hub" for every screen).
      const ua = navigator.userAgent;
      const deviceName = /\b(aft\w*|fire ?tv)\b/i.test(ua) ? "Fire TV" : /android/i.test(ua) ? "Android TV" : /\b(web0s|tizen|smart-?tv|bravia)\b/i.test(ua) ? "Smart TV"
        : /cros/i.test(ua) ? "Chromebook" : /mac os/i.test(ua) ? "Mac" : /windows/i.test(ua) ? "Windows PC" : /linux/i.test(ua) ? "Linux PC" : "TV";
      const url = `${protocol}//${host}/ws/remote?role=display&token=${encodeURIComponent(token())}&name=${encodeURIComponent(deviceName)}`;

      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "registered") {
            setPin(msg.pin);
            if (msg.qrData) setQrData(msg.qrData);
          } else if (msg.type === "controller_joined") {
            setControllerCount(msg.controllerCount || 1);
            showVolumeToast(`Phone Connected`, "📱");
            pushVideoStatus();
          } else if (msg.type === "controller_left") {
            setControllerCount(msg.controllerCount || 0);
          } else if (msg.type === "nav") {
            // Directional gamepad navigation
            if (msg.action === "home") {
              window.scrollTo({ top: 0, behavior: "smooth" });
              const b = document.querySelector("main button, [tabindex='0']");
              b?.focus();
            } else if (window.__nxGamepadNav) {
              window.__nxGamepadNav(msg.action, {});
            }
          } else if (msg.type === "scroll") {
            // Instantaneous or smooth scroll without animation lock
            const container = document.querySelector("#nx-library, main, [role='main']") || window;
            const behavior = msg.smooth ? "smooth" : "auto";
            if (container === window) {
              window.scrollBy({ top: msg.deltaY, left: msg.deltaX || 0, behavior });
            } else {
              container.scrollBy({ top: msg.deltaY, left: msg.deltaX || 0, behavior });
            }
          } else if (msg.type === "pointer_move") {
            // Virtual Mouse Pointer on TV screen
            const clientX = Math.round(msg.x * window.innerWidth);
            const clientY = Math.round(msg.y * window.innerHeight);
            setPointer({ visible: true, x: clientX, y: clientY });
            clearTimeout(pointerTimerRef.current);
            pointerTimerRef.current = setTimeout(() => {
              setPointer((p) => ({ ...p, visible: false }));
            }, 3000);
          } else if (msg.type === "pointer_click") {
            const clientX = Math.round(msg.x * window.innerWidth);
            const clientY = Math.round(msg.y * window.innerHeight);
            const el = document.elementFromPoint(clientX, clientY);
            if (el) {
              el.focus?.();
              el.click?.();
            }
          } else if (msg.type === "launch_game") {
            // Control Mirror: Launch game intent on TV
            showVolumeToast(`Launching ${msg.game?.title || "Game"}...`, "🎮");
            window.dispatchEvent(new CustomEvent("nexus:play", {
              detail: { phase: "browser", mode: "browser", game: msg.game, _fromMirror: true }
            }));
          } else if (msg.type === "play_media") {
            // Control Mirror: Play media intent on TV
            const cleanTitle = msg.item?.name ? msg.item.name.replace(/\.[^/.]+$/, "") : (msg.title || "Media");
            showVolumeToast(`Playing ${cleanTitle}...`, "🎬");
            if (window.nxPlayMedia) {
              window.nxPlayMedia(msg.item, msg.queue);
            } else {
              try { localStorage.setItem("nx_pending_play_media", JSON.stringify({ item: msg.item, queue: msg.queue })); } catch {}
              goTab("media");
              setTimeout(() => {
                if (window.nxPlayMedia) window.nxPlayMedia(msg.item, msg.queue);
              }, 400);
            }
          } else if (msg.type === "media") {
            // Video playback & volume control
            const video = document.querySelector("video");
            if (msg.action === "volume") {
              const currentVol = video ? video.volume : 1;
              const newVol = Math.max(0, Math.min(1, currentVol + (msg.value || 0)));
              if (video) video.volume = newVol;
              showVolumeToast(`Volume: ${Math.round(newVol * 100)}%`, newVol === 0 ? "🔇" : newVol < 0.5 ? "🔉" : "🔊");
            } else if (msg.action === "mute") {
              if (video) {
                video.muted = !video.muted;
                showVolumeToast(video.muted ? "Muted" : `Volume: ${Math.round(video.volume * 100)}%`, video.muted ? "🔇" : "🔊");
              } else {
                showVolumeToast("Muted", "🔇");
              }
            } else if (video) {
              if (msg.action === "play_pause") {
                if (video.paused) video.play(); else video.pause();
              } else if (msg.action === "seek") {
                video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (msg.value || 0)));
              } else if (msg.action === "seek_to") {
                video.currentTime = Math.max(0, Math.min(video.duration || 0, Number(msg.value || 0)));
              } else if (msg.action === "subtitles") {
                let anyActive = false;
                const tracks = Array.from(video.textTracks || []);
                for (const t of tracks) {
                  if (t.mode === "showing") anyActive = true;
                }
                const newMode = anyActive ? "disabled" : "showing";
                for (const t of tracks) {
                  t.mode = newMode;
                }
                const subBtn = document.querySelector("button[title*='subtitle' i], button[aria-label*='subtitle' i]");
                if (subBtn) subBtn.click();
                showVolumeToast(`Subtitles: ${anyActive ? "Off" : "On"}`, "💬");
              } else if (msg.action === "speed") {
                const currentRate = video.playbackRate || 1;
                const nextRate = currentRate >= 2 ? 1 : currentRate >= 1.5 ? 2 : currentRate >= 1.25 ? 1.5 : currentRate >= 1 ? 1.25 : 1;
                video.playbackRate = nextRate;
                showVolumeToast(`Speed: ${nextRate}x`, "⏩");
              } else if (msg.action === "fullscreen") {
                if (document.fullscreenElement) document.exitFullscreen?.();
                else video.requestFullscreen?.() || video.parentElement?.requestFullscreen?.();
              } else if (msg.action === "skip_intro") {
                const skipBtn = document.querySelector("button[title*='skip' i], button[aria-label*='skip' i], .nx-skip-intro, [data-skip-intro]");
                if (skipBtn) {
                  skipBtn.click();
                  showVolumeToast("Skipped Intro", "⏭️");
                } else if (video && video.currentTime < 180) {
                  video.currentTime += 85;
                  showVolumeToast("Jumped +85s", "⏭️");
                }
              } else if (msg.action === "next_audio") {
                const audioBtn = document.querySelector("button[title*='audio' i], button[aria-label*='audio' i], [data-audio-track]");
                if (audioBtn) {
                  audioBtn.click();
                  showVolumeToast("Audio Track", "🎧");
                } else {
                  showVolumeToast("Audio Track Cycled", "🎧");
                }
              }
              setTimeout(pushVideoStatus, 50);
            }
          } else if (msg.type === "gamepad") {
            const btn = msg.button;
            if (btn === "A") {
              if (window.__nxGamepadNav) window.__nxGamepadNav("confirm", {});
              else document.activeElement?.click?.();
            } else if (btn === "B") {
              if (window.__nxGamepadNav) window.__nxGamepadNav("cancel", {});
              else window.history.back();
            } else if (btn === "START") {
              if (window.__nxGamepadNav) window.__nxGamepadNav("home", {});
            } else if (btn === "SELECT") {
              goTab("games");
            }
          } else if (msg.type === "input") {
            // Search / text input
            const activeInput = document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")
              ? document.activeElement
              : document.querySelector("input[type='search'], input[type='text'], input:not([type])");

            if (activeInput) {
              activeInput.focus();
              activeInput.value = msg.text;
              activeInput.dispatchEvent(new Event("input", { bubbles: true }));
              activeInput.dispatchEvent(new Event("change", { bubbles: true }));
              if (msg.submit) {
                activeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
              }
            }
          } else if (msg.type === "navigate_tab") {
            goTab(msg.tab);
          }
        } catch {}
      };

      ws.onclose = (e) => {
        // Refused (signed out, or the sign-in expired): try again much later.
        setTimeout(connectDisplay, e && e.code === 1008 ? 60000 : 5000);
      };
    };

    connectDisplay();

    keepAlive = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);

    return () => {
      clearInterval(keepAlive);
      document.removeEventListener("play", onPlay, true);
      document.removeEventListener("pause", onPause, true);
      document.removeEventListener("seeked", onSeeked, true);
      try { ws?.close(); } catch {}
    };
  }, [showVolumeToast]);

  if (!pin) return null;

  return (
    <>
      {/* Virtual TV Mouse Pointer Indicator */}
      {pointer.visible && (
        <div style={{
          position: "fixed",
          left: pointer.x,
          top: pointer.y,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "radial-gradient(circle, #38bdf8 20%, rgba(56, 189, 248, 0.4) 70%, transparent 100%)",
          border: "2px solid #fff",
          boxShadow: "0 0 15px #38bdf8, 0 0 30px #38bdf8",
          pointerEvents: "none",
          transform: "translate(-50%, -50%)",
          zIndex: 999999,
          transition: "left 0.04s ease-out, top 0.04s ease-out",
        }} />
      )}

      {/* On-Screen TV Volume & Status HUD Overlay */}
      {volumeHud.visible && (
        <div style={{
          position: "fixed",
          top: 28,
          right: 28,
          zIndex: 99999,
          background: "rgba(15, 23, 42, 0.92)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
          borderRadius: 30,
          padding: "10px 22px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          color: "#fff",
          fontSize: 16,
          fontWeight: 700,
          pointerEvents: "none",
        }}>
          <span style={{ fontSize: 22 }}>{volumeHud.icon}</span>
          <span>{volumeHud.text}</span>
        </div>
      )}

      {/* Sleek Floating TV Remote Badge in bottom corner (auto-fades during video playback) */}
      <div
        onClick={() => setShowPairModal(true)}
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 9000,
          background: controllerCount > 0 ? "rgba(16, 185, 129, 0.9)" : "rgba(30, 41, 59, 0.85)",
          backdropFilter: "blur(14px)",
          border: "1px solid rgba(255, 255, 255, 0.18)",
          borderRadius: 24,
          padding: "6px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          color: "#fff",
          fontSize: 12,
          fontWeight: 700,
          userSelect: "none",
          opacity: isIdle || inGame ? 0 : 1,
          pointerEvents: isIdle || inGame ? "none" : "auto",
          transition: "opacity 0.4s ease, transform 0.2s ease",
        }}
        title="Click to pair your cellphone as a TV remote"
      >
        <span>📱 TV Remote</span>
        <span style={{
          background: "rgba(0,0,0,0.35)",
          padding: "2px 7px",
          borderRadius: 6,
          letterSpacing: 1,
          fontFamily: "monospace",
          fontWeight: 800,
          color: "#38bdf8",
        }}>
          PIN: {pin}
        </span>
        {controllerCount > 0 && (
          <span style={{ background: "#059669", borderRadius: "50%", width: 8, height: 8 }} />
        )}
      </div>

      {/* TV Pairing Modal with Big Interactive QR Code */}
      {showPairModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0, 0, 0, 0.8)",
          backdropFilter: "blur(16px)",
          zIndex: 99998,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
        }}>
          <div style={{
            background: "#0f172a",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 24,
            maxWidth: 440,
            width: "100%",
            padding: 28,
            textAlign: "center",
            color: "#fff",
            boxShadow: "0 20px 50px rgba(0,0,0,0.7)",
          }}>
            <div style={{ fontSize: 44, marginBottom: 8 }}>📱 ➔ 📺</div>
            <h2 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 6px" }}>Use Your Phone as a TV Remote</h2>
            <p style={{ fontSize: 14, color: "#94a3b8", margin: "0 0 20px" }}>
              Control navigation, scroll shelves, seek movies, and type with your mobile keyboard.
            </p>

            <div style={{
              background: "rgba(255,255,255,0.06)",
              borderRadius: 18,
              padding: 20,
              marginBottom: 20,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}>
              {qrData ? (
                <div style={{ marginBottom: 12, textAlign: "center" }}>
                  <img
                    src={qrData}
                    alt="Scan QR Code to Pair"
                    style={{
                      width: 175,
                      height: 175,
                      borderRadius: 14,
                      background: "#fff",
                      padding: 8,
                      display: "block",
                      margin: "0 auto 8px",
                      boxShadow: "0 6px 18px rgba(0,0,0,0.5)",
                    }}
                  />
                  <div style={{ fontSize: 13, color: "#38bdf8", fontWeight: 700 }}>
                    📷 Scan with phone camera to connect instantly
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: "#cbd5e1" }}>On your phone browser, open:</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#60a5fa" }}>
                    {window.location.origin}/?remote=1
                  </div>
                </>
              )}

              <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>Or enter this 6-digit PIN:</div>
              <div style={{
                fontSize: 38,
                fontWeight: 900,
                letterSpacing: 8,
                fontFamily: "monospace",
                color: "#60a5fa",
                background: "rgba(0,0,0,0.3)",
                padding: "8px 24px",
                borderRadius: 12,
                marginTop: 4,
              }}>
                {pin}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>
                Connected phones: <strong style={{ color: controllerCount > 0 ? "#34d399" : "#fff" }}>{controllerCount}</strong>
              </div>
              <button
                onClick={() => setShowPairModal(false)}
                style={{
                  background: "#3b82f6",
                  border: "none",
                  borderRadius: 10,
                  padding: "8px 18px",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Styling helpers
const dpadArrowStyle = {
  position: "absolute",
  width: 50,
  height: 50,
  borderRadius: 14,
  background: "rgba(255, 255, 255, 0.09)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  color: "#fff",
  fontSize: 19,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  boxShadow: "0 4px 10px rgba(0,0,0,0.3)",
};

const pillControlBtn = {
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 12,
  padding: "8px 14px",
  color: "#fff",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const miniMediaBtn = {
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 8,
  padding: "4px 8px",
  color: "#cbd5e1",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
};

const circleMediaBtn = {
  width: 52,
  height: 52,
  borderRadius: "50%",
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const quickTabBtnStyle = {
  background: "transparent",
  border: "none",
  borderRadius: 10,
  padding: "8px 4px",
  color: "#cbd5e1",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
};

const gamepadDpadBtn = {
  position: "absolute",
  width: 40,
  height: 40,
  borderRadius: 10,
  background: "rgba(255, 255, 255, 0.12)",
  border: "1px solid rgba(255, 255, 255, 0.2)",
  color: "#fff",
  fontSize: 16,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  boxShadow: "0 4px 10px rgba(0,0,0,0.4)",
};

const gamepadActionBtn = {
  position: "absolute",
  width: 40,
  height: 40,
  borderRadius: "50%",
  border: "1px solid rgba(255, 255, 255, 0.3)",
  color: "#fff",
  fontSize: 16,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
};
