import React, { useState, useEffect, useRef } from "react";
import { useStyles, Note } from "./lib.jsx";

const STANDARD_BUTTONS = [
  { index: 0, label: "A / Cross", short: "A", color: "#10b981" },
  { index: 1, label: "B / Circle", short: "B", color: "#ef4444" },
  { index: 2, label: "X / Square", short: "X", color: "#3b82f6" },
  { index: 3, label: "Y / Triangle", short: "Y", color: "#f59e0b" },
  { index: 4, label: "L1 / Left Bumper", short: "L1", color: "#94a3b8" },
  { index: 5, label: "R1 / Right Bumper", short: "R1", color: "#94a3b8" },
  { index: 6, label: "L2 / Left Trigger", short: "L2", isTrigger: true, color: "#818cf8" },
  { index: 7, label: "R2 / Right Trigger", short: "R2", isTrigger: true, color: "#818cf8" },
  { index: 8, label: "Select / Back", short: "SEL", color: "#cbd5e1" },
  { index: 9, label: "Start", short: "START", color: "#cbd5e1" },
  { index: 10, label: "L3 / Left Stick Click", short: "L3", color: "#38bdf8" },
  { index: 11, label: "R3 / Right Stick Click", short: "R3", color: "#38bdf8" },
  { index: 12, label: "D-Pad Up", short: "UP", color: "#a855f7" },
  { index: 13, label: "D-Pad Down", short: "DOWN", color: "#a855f7" },
  { index: 14, label: "D-Pad Left", short: "LEFT", color: "#a855f7" },
  { index: 15, label: "D-Pad Right", short: "RIGHT", color: "#a855f7" },
  { index: 16, label: "Home / Guide", short: "GUIDE", color: "#ec4899" },
];

export function ControllerTester() {
  useStyles();
  const [gamepads, setGamepads] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [gamepadState, setGamepadState] = useState(null);
  const [pollingHz, setPollingHz] = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);
  const [deadzone, setDeadzone] = useState(0.1);
  const [vibrationActive, setVibrationActive] = useState(false);
  const [customRemaps, setCustomRemaps] = useState(() => {
    try {
      const saved = localStorage.getItem("nx_gamepad_remaps");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const animRef = useRef(null);
  const frameCountRef = useRef(0);
  const lastSampleRef = useRef(performance.now());
  const lastTimestampRef = useRef(0);

  // Poll connected gamepads
  useEffect(() => {
    const scan = () => {
      const gps = (navigator.getGamepads ? Array.from(navigator.getGamepads()) : []).filter(Boolean);
      setGamepads(gps);
    };

    scan();
    window.addEventListener("gamepadconnected", scan);
    window.addEventListener("gamepaddisconnected", scan);
    return () => {
      window.removeEventListener("gamepadconnected", scan);
      window.removeEventListener("gamepaddisconnected", scan);
    };
  }, []);

  // Main polling loop for real-time button & axis state
  useEffect(() => {
    const loop = () => {
      const gps = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const active = gps[selectedIdx];

      if (active) {
        const now = performance.now();
        frameCountRef.current++;
        if (now - lastSampleRef.current >= 1000) {
          const hz = Math.round((frameCountRef.current * 1000) / (now - lastSampleRef.current));
          setPollingHz(hz);
          frameCountRef.current = 0;
          lastSampleRef.current = now;
        }

        // Calculate approximate input latency from hardware timestamp
        if (active.timestamp && lastTimestampRef.current) {
          const delta = active.timestamp - lastTimestampRef.current;
          if (delta > 0 && delta < 100) {
            setLatencyMs(Number(delta.toFixed(1)));
          }
        }
        lastTimestampRef.current = active.timestamp || performance.now();

        // Extract button states
        const btns = active.buttons.map((b) => ({
          pressed: b.pressed,
          value: Number(b.value.toFixed(2)),
        }));

        // Extract axes with deadzone
        const axes = (active.axes || []).map((v) => {
          const raw = Number(v.toFixed(3));
          return Math.abs(raw) < deadzone ? 0 : raw;
        });

        setGamepadState({
          id: active.id,
          buttons: btns,
          axes,
          mapping: active.mapping || "standard",
        });
      } else {
        setGamepadState(null);
      }

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [selectedIdx, deadzone]);

  const testHaptics = async () => {
    const gps = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    const active = gps[selectedIdx];
    if (active && active.vibrationActuator) {
      setVibrationActive(true);
      try {
        await active.vibrationActuator.playEffect("dual-rumble", {
          startDelay: 0,
          duration: 400,
          weakMagnitude: 0.7,
          strongMagnitude: 0.9,
        });
      } catch {}
      setTimeout(() => setVibrationActive(false), 450);
    }
  };

  const saveRemap = (btnIndex, mappedTo) => {
    const next = { ...customRemaps, [btnIndex]: mappedTo };
    setCustomRemaps(next);
    try {
      localStorage.setItem("nx_gamepad_remaps", JSON.stringify(next));
    } catch {}
  };

  const clearRemaps = () => {
    setCustomRemaps({});
    try {
      localStorage.removeItem("nx_gamepad_remaps");
    } catch {}
  };

  const leftX = gamepadState?.axes?.[0] ?? 0;
  const leftY = gamepadState?.axes?.[1] ?? 0;
  const rightX = gamepadState?.axes?.[2] ?? 0;
  const rightY = gamepadState?.axes?.[3] ?? 0;

  return (
    <div style={{ padding: "16px 20px", color: "#f8fafc", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <span>🎮</span> Controller Diagnostics & Remapping
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
            Hardware input polling, analog stick deflection, trigger pressure gauges & deadzone calibration.
          </p>
        </div>

        {/* Polling & Latency Telemetry */}
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "6px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>Polling Rate</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: pollingHz > 120 ? "#10b981" : pollingHz > 50 ? "#38bdf8" : "#f59e0b" }}>
              {pollingHz} Hz
            </div>
          </div>
          <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, padding: "6px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>Latency</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: latencyMs < 8 ? "#10b981" : latencyMs < 16 ? "#38bdf8" : "#f59e0b" }}>
              {latencyMs > 0 ? `${latencyMs} ms` : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Connected Gamepads Selector */}
      {gamepads.length === 0 ? (
        <div style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: 14, padding: "24px", textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🎮</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fca5a5" }}>No Gamepad Detected</div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
            Connect a USB or Bluetooth controller and press any button to awaken the browser Gamepad API.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginBottom: 20, overflowX: "auto", paddingBottom: 4 }}>
          {gamepads.map((g, i) => (
            <button
              key={i}
              onClick={() => setSelectedIdx(i)}
              style={{
                background: selectedIdx === i ? "rgba(56, 189, 248, 0.2)" : "rgba(255,255,255,0.04)",
                border: selectedIdx === i ? "1px solid #38bdf8" : "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                padding: "8px 16px",
                color: selectedIdx === i ? "#fff" : "#94a3b8",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                whiteSpace: "nowrap",
              }}
            >
              <span>{selectedIdx === i ? "🟢" : "⚪"}</span>
              <span>{g?.id?.split("(")[0]?.trim() || `Controller #${i + 1}`}</span>
            </button>
          ))}
        </div>
      )}

      {/* Main Interactive Visualizer Grid */}
      {gamepadState && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
          {/* Left Column: Analog Sticks Visualizer */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "20px" }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>🕹️ 2D Analog Sticks</span>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>Deadzone: {Math.round(deadzone * 100)}%</span>
            </h3>

            <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", marginBottom: 16 }}>
              {/* Left Stick Crosshair */}
              <div style={{ textAlign: "center" }}>
                <div style={{
                  width: 140,
                  height: 140,
                  borderRadius: "50%",
                  border: "2px solid rgba(255,255,255,0.2)",
                  background: "radial-gradient(circle, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.4) 100%)",
                  position: "relative",
                  margin: "0 auto 8px",
                  overflow: "hidden",
                }}>
                  {/* Deadzone boundary circle */}
                  <div style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: `${deadzone * 140}px`,
                    height: `${deadzone * 140}px`,
                    borderRadius: "50%",
                    border: "1px dashed rgba(239, 68, 68, 0.4)",
                    transform: "translate(-50%, -50%)",
                  }} />
                  {/* Center axes lines */}
                  <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.1)" }} />
                  <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.1)" }} />
                  {/* Thumbstick Puck */}
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: gamepadState?.buttons?.[10]?.pressed ? "#38bdf8" : "rgba(255,255,255,0.85)",
                    boxShadow: "0 0 12px rgba(56, 189, 248, 0.6)",
                    position: "absolute",
                    top: `calc(50% + ${leftY * 50}px)`,
                    left: `calc(50% + ${leftX * 50}px)`,
                    transform: "translate(-50%, -50%)",
                    transition: "all 0.04s ease-out",
                  }} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Left Stick (L3)</div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
                  X: {leftX.toFixed(2)} | Y: {leftY.toFixed(2)}
                </div>
              </div>

              {/* Right Stick Crosshair */}
              <div style={{ textAlign: "center" }}>
                <div style={{
                  width: 140,
                  height: 140,
                  borderRadius: "50%",
                  border: "2px solid rgba(255,255,255,0.2)",
                  background: "radial-gradient(circle, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.4) 100%)",
                  position: "relative",
                  margin: "0 auto 8px",
                  overflow: "hidden",
                }}>
                  {/* Deadzone boundary circle */}
                  <div style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: `${deadzone * 140}px`,
                    height: `${deadzone * 140}px`,
                    borderRadius: "50%",
                    border: "1px dashed rgba(239, 68, 68, 0.4)",
                    transform: "translate(-50%, -50%)",
                  }} />
                  {/* Center axes lines */}
                  <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.1)" }} />
                  <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.1)" }} />
                  {/* Thumbstick Puck */}
                  <div style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: gamepadState?.buttons?.[11]?.pressed ? "#38bdf8" : "rgba(255,255,255,0.85)",
                    boxShadow: "0 0 12px rgba(56, 189, 248, 0.6)",
                    position: "absolute",
                    top: `calc(50% + ${rightY * 50}px)`,
                    left: `calc(50% + ${rightX * 50}px)`,
                    transform: "translate(-50%, -50%)",
                    transition: "all 0.04s ease-out",
                  }} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Right Stick (R3)</div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
                  X: {rightX.toFixed(2)} | Y: {rightY.toFixed(2)}
                </div>
              </div>
            </div>

            {/* Deadzone Slider */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "nowrap" }}>Deadzone:</span>
              <input
                type="range"
                min="0"
                max="0.35"
                step="0.01"
                value={deadzone}
                onChange={(e) => setDeadzone(Number(e.target.value))}
                style={{ flex: 1, accentColor: "#38bdf8" }}
              />
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace" }}>{(deadzone * 100).toFixed(0)}%</span>
            </div>
          </div>

          {/* Right Column: Analog Triggers (L2 / R2) & Haptics */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "20px" }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px" }}>
              ⚡ Analog Triggers & Haptics
            </h3>

            {/* L2 / R2 Gauges */}
            <div style={{ display: "flex", gap: 20, marginBottom: 20 }}>
              {/* L2 Trigger Gauge */}
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  <span>Left Trigger (L2)</span>
                  <span style={{ color: "#818cf8", fontFamily: "monospace" }}>
                    {((gamepadState?.buttons?.[6]?.value ?? 0) * 100).toFixed(0)}%
                  </span>
                </div>
                <div style={{ height: 16, background: "rgba(255,255,255,0.1)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${(gamepadState?.buttons?.[6]?.value ?? 0) * 100}%`,
                    background: "linear-gradient(90deg, #6366f1, #818cf8)",
                    borderRadius: 8,
                    transition: "width 0.05s ease-out",
                  }} />
                </div>
              </div>

              {/* R2 Trigger Gauge */}
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  <span>Right Trigger (R2)</span>
                  <span style={{ color: "#818cf8", fontFamily: "monospace" }}>
                    {((gamepadState?.buttons?.[7]?.value ?? 0) * 100).toFixed(0)}%
                  </span>
                </div>
                <div style={{ height: 16, background: "rgba(255,255,255,0.1)", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${(gamepadState?.buttons?.[7]?.value ?? 0) * 100}%`,
                    background: "linear-gradient(90deg, #6366f1, #818cf8)",
                    borderRadius: 8,
                    transition: "width 0.05s ease-out",
                  }} />
                </div>
              </div>
            </div>

            {/* Haptic Rumble Test Button */}
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16 }}>
              <button
                onClick={testHaptics}
                disabled={vibrationActive}
                style={{
                  width: "100%",
                  background: vibrationActive ? "rgba(16, 185, 129, 0.3)" : "rgba(255,255,255,0.06)",
                  border: `1px solid ${vibrationActive ? "#10b981" : "rgba(255,255,255,0.12)"}`,
                  borderRadius: 10,
                  padding: "10px",
                  color: vibrationActive ? "#10b981" : "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>📳</span>
                <span>{vibrationActive ? "Testing Dual-Rumble Haptics..." : "Test Vibration / Dual-Rumble Motors"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Button State Tiles & Remapping Matrix */}
      {gamepadState && (
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
              🔘 Real-Time Button Matrix & Custom Remapping
            </h3>
            {Object.keys(customRemaps).length > 0 && (
              <button
                onClick={clearRemaps}
                style={{ background: "none", border: "none", color: "#fca5a5", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
              >
                Reset Custom Remaps ✕
              </button>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }}>
            {STANDARD_BUTTONS.map((btn) => {
              const state = gamepadState?.buttons?.[btn.index];
              const isPressed = state?.pressed;
              const mappedTarget = customRemaps[btn.index];

              return (
                <div
                  key={btn.index}
                  style={{
                    background: isPressed ? `${btn.color}25` : "rgba(255,255,255,0.03)",
                    border: isPressed ? `2px solid ${btn.color}` : "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 12,
                    padding: "10px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    boxShadow: isPressed ? `0 0 16px ${btn.color}40` : "none",
                    transition: "all 0.05s ease-out",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: isPressed ? "#fff" : "#cbd5e1" }}>
                      {btn.label}
                    </div>
                    {mappedTarget && (
                      <div style={{ fontSize: 10, color: "#38bdf8", fontWeight: 600 }}>
                        ➜ Remapped to: {mappedTarget}
                      </div>
                    )}
                  </div>

                  <span style={{
                    fontSize: 11,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: isPressed ? btn.color : "rgba(255,255,255,0.1)",
                    color: isPressed ? "#000" : "#94a3b8",
                  }}>
                    {isPressed ? "ON" : "OFF"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
