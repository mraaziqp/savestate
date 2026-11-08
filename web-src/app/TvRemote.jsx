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
 * TV Remote Component:
 * - When in Remote mode (on phone or when explicitly opened): Full tactile TV remote pad.
 * - When on TV / desktop: Floating listener & pairing pill that executes remote actions with auto-fade on video playback.
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
  const [showSearchModal, setShowSearchModal] = useState(false);
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
          background: "radial-gradient(circle at 50% 20%, #1e293b 0%, #090d16 100%)",
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
          {/* Top Bar: TV status & Actions */}
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
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {status === "connected" ? (pairedDisplay?.name || "Connected to TV") : "Not Paired"}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              {status === "connected" && (
                <button
                  onClick={() => {
                    try { wsRef.current?.close(); } catch {}
                    setStatus("disconnected");
                    setPairedDisplay(null);
                  }}
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    border: "none",
                    borderRadius: 16,
                    padding: "5px 12px",
                    color: "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  📺 Switch TV
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
                Scan the QR code on your TV or enter the 4-digit PIN below.
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
                  maxLength={4}
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
                  disabled={pinInput.length < 4 || status === "connecting"}
                  style={{
                    padding: "0 22px",
                    height: 52,
                    background: pinInput.length === 4 ? "#3b82f6" : "rgba(255,255,255,0.1)",
                    border: "none",
                    borderRadius: 14,
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: pinInput.length === 4 ? "pointer" : "default",
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
            <div style={{ width: "100%", maxWidth: 390, display: "flex", flexDirection: "column", gap: 14, margin: "auto 0" }}>

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
                  🖱️ Swipe
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

              {/* Mode 1: Tactile D-Pad Controller */}
              {mode === "dpad" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
                  {/* Quick Back & Home Bar */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "space-between", padding: "0 10px" }}>
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

                  {/* Circular D-Pad */}
                  <div style={{
                    width: 250,
                    height: 250,
                    borderRadius: "50%",
                    background: "rgba(255, 255, 255, 0.05)",
                    border: "2px solid rgba(255, 255, 255, 0.12)",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                  }}>
                    {/* UP */}
                    <button
                      onClick={() => nav("up")}
                      style={{ ...dpadArrowStyle, top: 12, left: "50%", transform: "translateX(-50%)" }}
                      aria-label="Up"
                    >
                      ▲
                    </button>

                    {/* DOWN */}
                    <button
                      onClick={() => nav("down")}
                      style={{ ...dpadArrowStyle, bottom: 12, left: "50%", transform: "translateX(-50%)" }}
                      aria-label="Down"
                    >
                      ▼
                    </button>

                    {/* LEFT */}
                    <button
                      onClick={() => nav("left")}
                      style={{ ...dpadArrowStyle, left: 12, top: "50%", transform: "translateY(-50%)" }}
                      aria-label="Left"
                    >
                      ◀
                    </button>

                    {/* RIGHT */}
                    <button
                      onClick={() => nav("right")}
                      style={{ ...dpadArrowStyle, right: 12, top: "50%", transform: "translateY(-50%)" }}
                      aria-label="Right"
                    >
                      ▶
                    </button>

                    {/* CENTER OK / SELECT */}
                    <button
                      onClick={() => nav("confirm")}
                      style={{
                        width: 86,
                        height: 86,
                        borderRadius: "50%",
                        background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                        border: "2px solid rgba(255, 255, 255, 0.3)",
                        boxShadow: "0 4px 15px rgba(59, 130, 246, 0.4)",
                        color: "#fff",
                        fontSize: 18,
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                      aria-label="OK / Select"
                    >
                      OK
                    </button>
                  </div>

                  {/* Volume Control Rocker right under D-Pad */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "center", gap: 10 }}>
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
                </div>
              )}

              {/* Mode 2: Swipe / Trackpad */}
              {mode === "trackpad" && (
                <div
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  style={{
                    height: 270,
                    background: "rgba(255,255,255,0.05)",
                    border: "2px dashed rgba(255,255,255,0.18)",
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
                  <div style={{ fontSize: 36, marginBottom: 8 }}>👆</div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>Smooth Swipe Surface</div>
                  <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4, maxWidth: 260 }}>
                    Swipe up / down to scroll shelves smoothly on the TV screen. Tap to select.
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                    <button onClick={() => scroll(-300)} style={pillControlBtn}>▲ Scroll Up</button>
                    <button onClick={() => nav("confirm")} style={{ ...pillControlBtn, background: "#3b82f6" }}>Tap (OK)</button>
                    <button onClick={() => scroll(300)} style={pillControlBtn}>▼ Scroll Down</button>
                  </div>
                </div>
              )}

              {/* Mode 3: Media Playback Controller */}
              {mode === "media" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
                <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
                  {/* Top Bumpers L1 / R1 */}
                  <div style={{ display: "flex", width: "100%", justifyContent: "space-between", padding: "0 10px" }}>
                    <button onClick={() => send({ type: "gamepad", button: "L1" })} style={{ ...pillControlBtn, width: 85, padding: "8px 0" }}>L1</button>
                    <button onClick={() => send({ type: "gamepad", button: "R1" })} style={{ ...pillControlBtn, width: 85, padding: "8px 0" }}>R1</button>
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
                      <button onClick={() => send({ type: "gamepad", button: "Y" })} style={{ ...gamepadActionBtn, top: 0, left: 45, background: "#f59e0b" }}>Y</button>
                      <button onClick={() => send({ type: "gamepad", button: "X" })} style={{ ...gamepadActionBtn, top: 45, left: 0, background: "#3b82f6" }}>X</button>
                      <button onClick={() => send({ type: "gamepad", button: "B" })} style={{ ...gamepadActionBtn, top: 45, right: 0, background: "#ef4444" }}>B</button>
                      <button onClick={() => send({ type: "gamepad", button: "A" })} style={{ ...gamepadActionBtn, bottom: 0, left: 45, background: "#10b981" }}>A</button>
                    </div>
                  </div>

                  {/* Center Select & Start */}
                  <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
                    <button onClick={() => send({ type: "gamepad", button: "SELECT" })} style={{ ...pillControlBtn, fontSize: 11, padding: "6px 14px" }}>SELECT</button>
                    <button onClick={() => send({ type: "gamepad", button: "START" })} style={{ ...pillControlBtn, fontSize: 11, padding: "6px 14px", background: "rgba(59,130,246,0.25)", color: "#60a5fa" }}>START</button>
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
              <button onClick={() => send({ type: "navigate_tab", tab: "discover" })} style={quickTabBtnStyle}>
                <span>🏠</span> Home
              </button>
              <button onClick={() => send({ type: "navigate_tab", tab: "games" })} style={quickTabBtnStyle}>
                <span>🎮</span> Games
              </button>
              <button onClick={() => send({ type: "navigate_tab", tab: "media" })} style={quickTabBtnStyle}>
                <span>🎬</span> Movies
              </button>
              <button onClick={() => send({ type: "navigate_tab", tab: "music" })} style={quickTabBtnStyle}>
                <span>🎵</span> Music
              </button>
              <button onClick={() => send({ type: "navigate_tab", tab: "library" })} style={quickTabBtnStyle}>
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
 * - Displays on-screen TV Volume HUD toast when volume changes.
 * - Translates incoming remote events to gamepad nav, video playback, and smooth scrolling!
 */
export function TvDisplayListener({ onOpenRemote }) {
  const [pin, setPin] = useState(null);
  const [qrData, setQrData] = useState(null);
  const [controllerCount, setControllerCount] = useState(0);
  const [showPairModal, setShowPairModal] = useState(false);
  const [isIdle, setIsIdle] = useState(false);
  const [volumeHud, setVolumeHud] = useState({ visible: false, text: "", icon: "🔊" });
  const wsRef = useRef(null);
  const volumeTimerRef = useRef(null);

  // Show on-screen TV Volume Toast
  const showVolumeToast = useCallback((text, icon = "🔊") => {
    clearTimeout(volumeTimerRef.current);
    setVolumeHud({ visible: true, text, icon });
    volumeTimerRef.current = setTimeout(() => {
      setVolumeHud((s) => ({ ...s, visible: false }));
    }, 1800);
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
            // Smooth scroll active window
            window.scrollBy({ top: msg.deltaY, behavior: "smooth" });
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

      ws.onclose = () => {
        setTimeout(connectDisplay, 5000);
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
          opacity: isIdle ? 0 : 1,
          pointerEvents: isIdle ? "none" : "auto",
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

              <div style={{ fontSize: 13, color: "#cbd5e1", marginTop: 4 }}>Or enter this 4-digit PIN:</div>
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
  width: 52,
  height: 52,
  borderRadius: 14,
  background: "rgba(255, 255, 255, 0.09)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  color: "#fff",
  fontSize: 20,
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
