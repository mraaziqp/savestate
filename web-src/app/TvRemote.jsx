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

/**
 * TV Remote Component:
 * - When in Remote mode (on phone or when explicitly opened): Full tactile TV remote pad.
 * - When on TV / desktop: Floating listener & pairing pill that executes remote actions.
 */
export function TvRemote() {
  useStyles();
  const [isOpen, setIsOpen] = useState(false);
  const [pairedDisplay, setPairedDisplay] = useState(null); // { displayId, pin, name }
  const [displays, setDisplays] = useState([]);
  const [pinInput, setPinInput] = useState("");
  const [status, setStatus] = useState("disconnected"); // "disconnected" | "connecting" | "connected"
  const [error, setError] = useState("");
  const [mode, setMode] = useState("dpad"); // "dpad" | "trackpad" | "media"
  const [inputText, setInputText] = useState("");
  const [mediaState, setMediaState] = useState({ playing: false, currentTime: 0, duration: 0, title: "", isVideo: false });
  const wsRef = useRef(null);
  const touchStartRef = useRef(null);

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
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
    }

    setStatus("connecting");
    setError("");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/remote?role=controller&pin=${encodeURIComponent(targetPin || "")}&name=${encodeURIComponent(navigator.userAgent.includes("Android") ? "Android Phone" : "Smartphone")}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // connected
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "paired") {
          setStatus("connected");
          setPairedDisplay({ displayId: msg.displayId, pin: msg.pin, name: msg.displayDevice });
          try { localStorage.setItem("nx_tv_remote_pin", msg.pin); } catch {}
          vibrate(40);
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
      setStatus("disconnected");
    };

    ws.onerror = () => {
      setStatus("disconnected");
      setError("Failed to connect to TV remote service");
    };
  }, []);

  // Send control command
  const send = useCallback((payload) => {
    vibrate(20);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  // Directional actions
  const nav = (action) => send({ type: "nav", action });
  const scroll = (deltaY) => send({ type: "scroll", deltaY, smooth: true });
  const media = (action, value) => send({ type: "media", action, value });

  // Handle mobile text submission
  const handleInputSubmit = (e) => {
    e.preventDefault();
    if (inputText) {
      send({ type: "input", text: inputText, replace: true, submit: true });
      setInputText("");
    }
  };

  const handleInputLiveChange = (val) => {
    setInputText(val);
    send({ type: "input", text: val, replace: true, submit: false });
  };

  // Touchpad drag handlers
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    touchStartRef.current = { y: t.clientY, time: Date.now() };
  };

  const handleTouchMove = (e) => {
    if (!touchStartRef.current) return;
    const t = e.touches[0];
    const dy = touchStartRef.current.y - t.clientY;
    if (Math.abs(dy) > 10) {
      scroll(dy * 1.5);
      touchStartRef.current.y = t.clientY;
    }
  };

  const handleTouchEnd = () => {
    touchStartRef.current = null;
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
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const isRemoteUrl = sp.has("remote") || window.location.hash.includes("remote");
    const pinParam = sp.get("pin");

    if (isRemoteUrl || pinParam) {
      setIsOpen(true);
    }

    if (pinParam) {
      setPinInput(pinParam);
      connectToDisplay(pinParam);
    } else if (isRemoteUrl && status === "disconnected") {
      const saved = localStorage.getItem("nx_tv_remote_pin");
      if (saved && displays.some(d => d.pin === saved)) {
        setPinInput(saved);
        connectToDisplay(saved);
      } else if (displays.length === 1) {
        connectToDisplay(displays[0].pin);
      }
    }
  }, [displays, status, connectToDisplay]);

  return (
    <>
      {/* TV Display sidecar: always active on big screens to receive commands */}
      <TvDisplayListener onOpenRemote={() => setIsOpen(true)} />

      {/* Controller Modal / Interface */}
      {isOpen && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(10, 10, 15, 0.96)",
          backdropFilter: "blur(20px)",
          zIndex: 99999,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px 24px",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, sans-serif",
          touchAction: "manipulation",
          userSelect: "none",
        }}>
          {/* Top Bar: TV status & Close */}
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
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {status === "connected" ? (pairedDisplay?.name || "Connected to TV") : "Not Paired"}
              </div>
            </div>

            <button
              onClick={() => setIsOpen(false)}
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "none",
                borderRadius: 20,
                padding: "6px 14px",
                color: "#cbd5e1",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              ✕ Close
            </button>
          </div>

          {/* Pairing Screen if not connected */}
          {status !== "connected" ? (
            <div style={{ width: "100%", maxWidth: 360, textAlign: "center", margin: "auto 0" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📱 ➔ 📺</div>
              <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Pair with TV Screen</h2>
              <p style={{ fontSize: 14, color: "#94a3b8", margin: "0 0 24px" }}>
                Enter the 4-digit PIN displayed on your TV screen to start controlling it.
              </p>

              {error && (
                <div style={{ background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", color: "#fca5a5", padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 20 }}>
                <input
                  type="text"
                  maxLength={4}
                  placeholder="PIN"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))}
                  style={{
                    width: 140,
                    height: 52,
                    fontSize: 26,
                    fontWeight: 700,
                    letterSpacing: 6,
                    textAlign: "center",
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 12,
                    color: "#fff",
                    outline: "none",
                  }}
                />
                <button
                  onClick={() => connectToDisplay(pinInput)}
                  disabled={pinInput.length < 4 || status === "connecting"}
                  style={{
                    padding: "0 20px",
                    height: 52,
                    background: pinInput.length === 4 ? "#3b82f6" : "rgba(255,255,255,0.1)",
                    border: "none",
                    borderRadius: 12,
                    color: "#fff",
                    fontWeight: 600,
                    cursor: pinInput.length === 4 ? "pointer" : "default",
                  }}
                >
                  {status === "connecting" ? "Pairing..." : "Connect"}
                </button>
              </div>

              {/* Active TVs detected */}
              {displays.length > 0 && (
                <div style={{ marginTop: 24, textAlign: "left" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, color: "#64748b", marginBottom: 10 }}>
                    Detected TVs on Network
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
                          borderRadius: 10,
                          color: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 18 }}>📺</span>
                          <span style={{ fontWeight: 600 }}>{d.name}</span>
                        </div>
                        <span style={{ fontSize: 13, background: "rgba(59, 130, 246, 0.2)", color: "#60a5fa", padding: "4px 8px", borderRadius: 6, fontWeight: 700 }}>
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
            <div style={{ width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 16, margin: "auto 0" }}>

              {/* Mode Selector */}
              <div style={{ display: "flex", background: "rgba(255,255,255,0.08)", borderRadius: 12, padding: 4, gap: 4 }}>
                <button
                  onClick={() => setMode("dpad")}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    border: "none",
                    borderRadius: 8,
                    background: mode === "dpad" ? "#3b82f6" : "transparent",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: 13,
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
                    borderRadius: 8,
                    background: mode === "trackpad" ? "#3b82f6" : "transparent",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  🖱️ Swipe Pad
                </button>
                <button
                  onClick={() => setMode("media")}
                  style={{
                    flex: 1,
                    padding: "8px 0",
                    border: "none",
                    borderRadius: 8,
                    background: mode === "media" ? "#3b82f6" : "transparent",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  🎬 Playback
                </button>
              </div>

              {/* Mode 1: D-PAD & Core TV Navigation */}
              {mode === "dpad" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
                  {/* Top utility row: Back, Home, Menu */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "space-between", padding: "0 16px" }}>
                    <button
                      onClick={() => nav("cancel")}
                      style={utilityBtnStyle}
                      title="Back / Escape"
                    >
                      ↩ Back
                    </button>
                    <button
                      onClick={() => nav("home")}
                      style={utilityBtnStyle}
                      title="Home"
                    >
                      🏠 Home
                    </button>
                    <button
                      onClick={() => nav("menu")}
                      style={utilityBtnStyle}
                      title="Menu"
                    >
                      ☰ Menu
                    </button>
                  </div>

                  {/* Circular D-Pad Container */}
                  <div style={{
                    position: "relative",
                    width: 250,
                    height: 250,
                    borderRadius: "50%",
                    background: "radial-gradient(circle, rgba(30, 41, 59, 0.8) 0%, rgba(15, 23, 42, 0.95) 100%)",
                    border: "2px solid rgba(255, 255, 255, 0.12)",
                    boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}>
                    {/* UP */}
                    <button
                      onClick={() => nav("up")}
                      style={{ ...dpadArrowStyle, top: 12, left: "50%", transform: "translateX(-50%)" }}
                    >
                      ▲
                    </button>

                    {/* DOWN */}
                    <button
                      onClick={() => nav("down")}
                      style={{ ...dpadArrowStyle, bottom: 12, left: "50%", transform: "translateX(-50%)" }}
                    >
                      ▼
                    </button>

                    {/* LEFT */}
                    <button
                      onClick={() => nav("left")}
                      style={{ ...dpadArrowStyle, left: 12, top: "50%", transform: "translateY(-50%)" }}
                    >
                      ◀
                    </button>

                    {/* RIGHT */}
                    <button
                      onClick={() => nav("right")}
                      style={{ ...dpadArrowStyle, right: 12, top: "50%", transform: "translateY(-50%)" }}
                    >
                      ▶
                    </button>

                    {/* CENTER OK / SELECT */}
                    <button
                      onClick={() => nav("confirm")}
                      style={{
                        width: 90,
                        height: 90,
                        borderRadius: "50%",
                        background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                        border: "2px solid rgba(255, 255, 255, 0.3)",
                        boxShadow: "0 4px 15px rgba(59, 130, 246, 0.4)",
                        color: "#fff",
                        fontSize: 18,
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                    >
                      OK
                    </button>
                  </div>
                </div>
              )}

              {/* Mode 2: Swipe / Trackpad */}
              {mode === "trackpad" && (
                <div
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  style={{
                    height: 280,
                    background: "rgba(255,255,255,0.05)",
                    border: "2px dashed rgba(255,255,255,0.15)",
                    borderRadius: 20,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 20,
                    textAlign: "center",
                    touchAction: "none",
                  }}
                >
                  <div style={{ fontSize: 32, marginBottom: 8 }}>👆</div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>Swipe & Scroll Surface</div>
                  <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
                    Swipe up / down to scroll shelves smoothly on the TV screen. Tap to select.
                  </div>
                  <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
                    <button onClick={() => scroll(-300)} style={pillStyle}>▲ Scroll Up</button>
                    <button onClick={() => nav("confirm")} style={{ ...pillStyle, background: "#3b82f6" }}>Tap (OK)</button>
                    <button onClick={() => scroll(300)} style={pillStyle}>▼ Scroll Down</button>
                  </div>
                </div>
              )}

              {/* Mode 3: Media Controller */}
              {mode === "media" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "8px 0" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>Now Playing on TV</div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {mediaState.title || "Video Player"}
                    </div>
                  </div>

                  {/* Playback Controls */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18 }}>
                    <button onClick={() => media("seek", -10)} style={mediaBtnStyle}>⏪ 10s</button>
                    <button
                      onClick={() => media("play_pause")}
                      style={{
                        ...mediaBtnStyle,
                        width: 72,
                        height: 72,
                        borderRadius: "50%",
                        background: "#3b82f6",
                        fontSize: 26,
                      }}
                    >
                      {mediaState.playing ? "⏸" : "▶"}
                    </button>
                    <button onClick={() => media("seek", 10)} style={mediaBtnStyle}>10s ⏩</button>
                  </div>

                  {/* Volume & Fullscreen */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                    <button onClick={() => media("mute")} style={pillStyle}>🔇 Mute</button>
                    <button onClick={() => media("fullscreen")} style={pillStyle}>⛶ Fullscreen</button>
                  </div>
                </div>
              )}

              {/* Mobile Keyboard / Search Input Streamer */}
              <form onSubmit={handleInputSubmit} style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  type="text"
                  placeholder="Type to search on TV..."
                  value={inputText}
                  onChange={(e) => handleInputLiveChange(e.target.value)}
                  style={{
                    flex: 1,
                    height: 44,
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 10,
                    padding: "0 12px",
                    color: "#fff",
                    fontSize: 14,
                    outline: "none",
                  }}
                />
                <button
                  type="submit"
                  style={{
                    padding: "0 16px",
                    height: 44,
                    background: "rgba(255,255,255,0.15)",
                    border: "none",
                    borderRadius: 10,
                    color: "#fff",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Send
                </button>
              </form>
            </div>
          )}

          {/* Bottom Bar: Quick tab navigation */}
          <div style={{ display: "flex", gap: 10, justifyContent: "center", width: "100%", maxWidth: 400 }}>
            <button onClick={() => send({ type: "navigate_tab", tab: "games" })} style={bottomTabStyle}>🎮 Games</button>
            <button onClick={() => send({ type: "navigate_tab", tab: "media" })} style={bottomTabStyle}>🎬 Movies</button>
            <button onClick={() => send({ type: "navigate_tab", tab: "library" })} style={bottomTabStyle}>💾 Library</button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * TV Display Listener:
 * Runs in the background on the TV/browser.
 * Registers as display on `/ws/remote?role=display`, displays pairing pill with PIN,
 * and translates incoming remote events to gamepad nav, video controls, and scrolling!
 */
export function TvDisplayListener({ onOpenRemote }) {
  const [pin, setPin] = useState(null);
  const [qrData, setQrData] = useState(null);
  const [controllerCount, setControllerCount] = useState(0);
  const [showPairModal, setShowPairModal] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    // Only connect as display on non-mobile devices or wide screens
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

    // Attach video status listeners across DOM
    const onPlay = () => pushVideoStatus();
    const onPause = () => pushVideoStatus();
    const onSeeked = () => pushVideoStatus();
    document.addEventListener("play", onPlay, true);
    document.addEventListener("pause", onPause, true);
    document.addEventListener("seeked", onSeeked, true);

    const connectDisplay = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const url = `${protocol}//${host}/ws/remote?role=display&name=${encodeURIComponent(document.title || "SaveState TV")}`;

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
            // Smooth scroll active window
            window.scrollBy({ top: msg.deltaY, behavior: "smooth" });
          } else if (msg.type === "media") {
            // Video playback control
            const video = document.querySelector("video");
            if (video) {
              if (msg.action === "play_pause") {
                if (video.paused) video.play(); else video.pause();
              } else if (msg.action === "seek") {
                video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (msg.value || 0)));
              } else if (msg.action === "mute") {
                video.muted = !video.muted;
              } else if (msg.action === "fullscreen") {
                if (document.fullscreenElement) document.exitFullscreen?.();
                else video.requestFullscreen?.() || video.parentElement?.requestFullscreen?.();
              }
              setTimeout(pushVideoStatus, 50);
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

      ws.onclose = () => {
        // Reconnect after 5 seconds
        setTimeout(connectDisplay, 5000);
      };
    };

    connectDisplay();

    // Ping loop
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
  }, []);

  if (!pin) return null;

  return (
    <>
      {/* Sleek Floating TV Remote Badge in bottom corner */}
      <div
        onClick={() => setShowPairModal(true)}
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 9000,
          background: controllerCount > 0 ? "rgba(16, 185, 129, 0.9)" : "rgba(30, 41, 59, 0.85)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255, 255, 255, 0.15)",
          borderRadius: 24,
          padding: "6px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          userSelect: "none",
        }}
        title="Click to pair your smartphone as a TV remote"
      >
        <span>📱 TV Remote</span>
        <span style={{
          background: "rgba(0,0,0,0.3)",
          padding: "2px 6px",
          borderRadius: 6,
          letterSpacing: 1,
          fontFamily: "monospace",
          fontWeight: 700,
        }}>
          PIN: {pin}
        </span>
        {controllerCount > 0 && (
          <span style={{ background: "#059669", borderRadius: "50%", width: 8, height: 8 }} />
        )}
      </div>

      {/* TV Pairing Modal */}
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
            borderRadius: 20,
            maxWidth: 440,
            width: "100%",
            padding: 28,
            textAlign: "center",
            color: "#fff",
            boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
          }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>📱 ➔ 📺</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px" }}>Use Your Phone as a Remote</h2>
            <p style={{ fontSize: 14, color: "#94a3b8", margin: "0 0 20px" }}>
              Control navigation, scroll shelves, seek movies, and type with your mobile keyboard.
            </p>

            <div style={{
              background: "rgba(255,255,255,0.06)",
              borderRadius: 16,
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
                      width: 170,
                      height: 170,
                      borderRadius: 12,
                      background: "#fff",
                      padding: 8,
                      display: "block",
                      margin: "0 auto 6px",
                      boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
                    }}
                  />
                  <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 600 }}>
                    📷 Scan with phone camera to connect
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

              <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>Or enter this 4-digit PIN:</div>
              <div style={{
                fontSize: 38,
                fontWeight: 900,
                letterSpacing: 8,
                color: "#10b981",
                fontFamily: "monospace",
                background: "rgba(0,0,0,0.3)",
                padding: "8px 20px",
                borderRadius: 12,
              }}>
                {pin}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                onClick={() => { setShowPairModal(false); onOpenRemote?.(); }}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "none",
                  background: "#3b82f6",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Open Remote on this PC
              </button>
              <button
                onClick={() => setShowPairModal(false)}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "none",
                  background: "rgba(255,255,255,0.1)",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Styling helpers
const utilityBtnStyle = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: "8px 16px",
  color: "#e2e8f0",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const dpadArrowStyle = {
  position: "absolute",
  width: 54,
  height: 54,
  borderRadius: 14,
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#fff",
  fontSize: 18,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const pillStyle = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 20,
  padding: "8px 16px",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const mediaBtnStyle = {
  width: 58,
  height: 58,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const bottomTabStyle = {
  flex: 1,
  padding: "8px 0",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  color: "#94a3b8",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
