import React, { useState, useEffect, useRef } from "react";
import { useStyles, Note, token } from "./lib.jsx";

const STANDARD_BUTTONS = [
  { index: 0, label: "A / Cross (Bottom)", short: "A", color: "#10b981", gcLabel: "GC A (Modern) / GC B (Nintendo)" },
  { index: 1, label: "B / Circle (Right)", short: "B", color: "#ef4444", gcLabel: "GC B (Modern) / GC A (Nintendo)" },
  { index: 2, label: "X / Square (Left)", short: "X", color: "#3b82f6", gcLabel: "GC X (Modern) / GC Y (Nintendo)" },
  { index: 3, label: "Y / Triangle (Top)", short: "Y", color: "#f59e0b", gcLabel: "GC Y (Modern) / GC X (Nintendo)" },
  { index: 4, label: "L1 / Left Bumper", short: "L1", color: "#94a3b8", gcLabel: "GC L (Digital)" },
  { index: 5, label: "R1 / Right Bumper", short: "R1", color: "#94a3b8", gcLabel: "GC Z (Shoulder)" },
  { index: 6, label: "L2 / Left Trigger", short: "L2", isTrigger: true, color: "#818cf8", gcLabel: "GC L-Trigger (Analog + Click)" },
  { index: 7, label: "R2 / Right Trigger", short: "R2", isTrigger: true, color: "#818cf8", gcLabel: "GC R-Trigger (Analog + Click)" },
  { index: 8, label: "Select / Back", short: "SEL", color: "#cbd5e1", gcLabel: "Triforce Coin / Pause" },
  { index: 9, label: "Start", short: "START", color: "#cbd5e1", gcLabel: "GC START" },
  { index: 10, label: "L3 / Left Stick Click", short: "L3", color: "#38bdf8", gcLabel: "Triforce Service" },
  { index: 11, label: "R3 / Right Stick Click", short: "R3", color: "#38bdf8", gcLabel: "Triforce Test" },
  { index: 12, label: "D-Pad Up", short: "UP", color: "#a855f7", gcLabel: "GC D-Pad Up" },
  { index: 13, label: "D-Pad Down", short: "DOWN", color: "#a855f7", gcLabel: "GC D-Pad Down" },
  { index: 14, label: "D-Pad Left", short: "LEFT", color: "#a855f7", gcLabel: "GC D-Pad Left" },
  { index: 15, label: "D-Pad Right", short: "RIGHT", color: "#a855f7", gcLabel: "GC D-Pad Right" },
  { index: 16, label: "Home / Guide", short: "GUIDE", color: "#ec4899", gcLabel: "SaveState Menu" },
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
  const [configuring, setConfiguring] = useState(false);
  const [configResult, setConfigResult] = useState(null);
  const [layoutMode, setLayoutMode] = useState("modern"); // "modern" | "nintendo"
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

  const autoConfigureDolphin = async (chosenLayout = layoutMode) => {
    setConfiguring(true);
    setConfigResult(null);
    try {
      const res = await fetch("/api/controllers/configure-dolphin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token() || ""}`,
        },
        body: JSON.stringify({
          layout: chosenLayout,
          deadzone: deadzone * 100,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setConfigResult({
          ok: true,
          message: data.message || "GameCube & Dolphin controllers successfully configured across all emulators!",
          count: data.pathsUpdated?.length || 0,
          controllers: data.controllersDetected || [],
        });
      } else {
        setConfigResult({
          ok: false,
          message: data.error || "Configuration failed",
        });
      }
    } catch (e) {
      setConfigResult({
        ok: false,
        message: e.message || "Failed to reach server controller configurator",
      });
    } finally {
      setConfiguring(false);
    }
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

  // Active GameCube Button Mappings
  const isNintendo = layoutMode === "nintendo";
  const gcAActive = isNintendo ? gamepadState?.buttons?.[1]?.pressed : gamepadState?.buttons?.[0]?.pressed;
  const gcBActive = isNintendo ? gamepadState?.buttons?.[0]?.pressed : gamepadState?.buttons?.[1]?.pressed;
  const gcXActive = isNintendo ? gamepadState?.buttons?.[3]?.pressed : gamepadState?.buttons?.[2]?.pressed;
  const gcYActive = isNintendo ? gamepadState?.buttons?.[2]?.pressed : gamepadState?.buttons?.[3]?.pressed;
  const gcZActive = gamepadState?.buttons?.[5]?.pressed; // R1
  const gcStartActive = gamepadState?.buttons?.[9]?.pressed; // Start
  const gcLActive = (gamepadState?.buttons?.[6]?.value ?? 0) > 0.5 || gamepadState?.buttons?.[4]?.pressed;
  const gcRActive = (gamepadState?.buttons?.[7]?.value ?? 0) > 0.5;
  const gcDpadUp = gamepadState?.buttons?.[12]?.pressed;
  const gcDpadDown = gamepadState?.buttons?.[13]?.pressed;
  const gcDpadLeft = gamepadState?.buttons?.[14]?.pressed;
  const gcDpadRight = gamepadState?.buttons?.[15]?.pressed;

  return (
    <div style={{ padding: "16px 20px", color: "#f8fafc", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <span>🎮</span> Controller Diagnostics & One-Click Setup
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
            Zero scripts required: detect, test, calibrate and auto-configure gamepads for GameCube, Wii & RetroArch with one button press.
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

      {/* ONE-CLICK AUTO-CONFIGURE HERO CARD (Zero Scripts UX) */}
      <div style={{
        background: "linear-gradient(135deg, rgba(30, 27, 75, 0.7) 0%, rgba(15, 23, 42, 0.8) 100%)",
        border: "1px solid rgba(99, 102, 241, 0.35)",
        borderRadius: 16,
        padding: "20px",
        marginBottom: 20,
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 20 }}>⚡</span>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#fff" }}>
                Auto-Configure GameCube & Dolphin Controllers
              </h3>
              <span style={{
                background: "rgba(16, 185, 129, 0.15)",
                color: "#10b981",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                borderRadius: 999,
                padding: "2px 8px",
                fontSize: 10,
                fontWeight: 800,
                textTransform: "uppercase",
              }}>
                Zero Scripts
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 }}>
              Automatically configures all 4 controller ports, sets analog stick deadzones to prevent drift, configures dual-stage triggers, and pairs standalone Dolphin, RetroArch, and SaveState Engine.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {/* Layout Mode Selector */}
            <div style={{ display: "flex", background: "rgba(0,0,0,0.35)", padding: 3, borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)" }}>
              <button
                type="button"
                onClick={() => setLayoutMode("modern")}
                style={{
                  background: layoutMode === "modern" ? "rgba(99, 102, 241, 0.5)" : "transparent",
                  color: layoutMode === "modern" ? "#fff" : "#94a3b8",
                  border: "none",
                  padding: "6px 12px",
                  borderRadius: 7,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Modern Layout (A=A, B=B)
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode("nintendo")}
                style={{
                  background: layoutMode === "nintendo" ? "rgba(99, 102, 241, 0.5)" : "transparent",
                  color: layoutMode === "nintendo" ? "#fff" : "#94a3b8",
                  border: "none",
                  padding: "6px 12px",
                  borderRadius: 7,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Nintendo Match (B=A, A=B)
              </button>
            </div>

            {/* Primary Action Button */}
            <button
              type="button"
              disabled={configuring}
              onClick={() => autoConfigureDolphin(layoutMode)}
              style={{
                background: configuring ? "rgba(99, 102, 241, 0.4)" : "linear-gradient(90deg, #6366f1, #8b5cf6)",
                border: "none",
                borderRadius: 10,
                color: "#fff",
                padding: "10px 20px",
                fontSize: 13,
                fontWeight: 800,
                cursor: configuring ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                boxShadow: "0 4px 14px rgba(99, 102, 241, 0.4)",
              }}
            >
              <span>{configuring ? "⚙️" : "🎮"}</span>
              <span>{configuring ? "Configuring Controllers…" : "Auto-Configure All Controllers Now"}</span>
            </button>
          </div>
        </div>

        {/* Configuration Result Feedback Toast */}
        {configResult && (
          <div style={{
            marginTop: 14,
            padding: "10px 14px",
            borderRadius: 10,
            background: configResult.ok ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
            border: `1px solid ${configResult.ok ? "rgba(16, 185, 129, 0.35)" : "rgba(239, 68, 68, 0.35)"}`,
            color: configResult.ok ? "#34d399" : "#f87171",
            fontSize: 13,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}>
            <span>{configResult.ok ? "✓ " : "✕ "}{configResult.message}</span>
            <button
              onClick={() => setConfigResult(null)}
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14 }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Connected Gamepads Selector */}
      {gamepads.length === 0 ? (
        <div style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: 14, padding: "24px", textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🎮</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fca5a5" }}>No Gamepad Detected in Browser</div>
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

      {/* LIVE GAMECUBE CONTROLLER HUD & RESPONSIVENESS TESTER */}
      {gamepadState && (
        <div style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          padding: "20px",
          marginBottom: 24,
        }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>🟣 Live GameCube Response HUD</span>
            <span style={{ fontSize: 12, color: "#a5b4fc" }}>Press controller buttons to verify GameCube responses live</span>
          </h3>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
            gap: 12,
            textAlign: "center",
          }}>
            {/* GC A Button */}
            <div style={{
              background: gcAActive ? "#10b981" : "rgba(16, 185, 129, 0.1)",
              border: "2px solid #10b981",
              borderRadius: "50%",
              width: 80,
              height: 80,
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcAActive ? "0 0 20px #10b981" : "none",
              color: gcAActive ? "#000" : "#10b981",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 24 }}>A</b>
              <small style={{ fontSize: 9, fontWeight: 700 }}>CONFIRM</small>
            </div>

            {/* GC B Button */}
            <div style={{
              background: gcBActive ? "#ef4444" : "rgba(239, 68, 68, 0.1)",
              border: "2px solid #ef4444",
              borderRadius: "50%",
              width: 60,
              height: 60,
              margin: "10px auto 0",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcBActive ? "0 0 16px #ef4444" : "none",
              color: gcBActive ? "#fff" : "#ef4444",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 18 }}>B</b>
              <small style={{ fontSize: 8, fontWeight: 700 }}>CANCEL</small>
            </div>

            {/* GC X Button */}
            <div style={{
              background: gcXActive ? "#94a3b8" : "rgba(148, 163, 184, 0.1)",
              border: "2px solid #94a3b8",
              borderRadius: 14,
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcXActive ? "0 0 16px #94a3b8" : "none",
              color: gcXActive ? "#000" : "#94a3b8",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 20 }}>X</b>
              <small style={{ fontSize: 10, fontWeight: 700 }}>SPECIAL</small>
            </div>

            {/* GC Y Button */}
            <div style={{
              background: gcYActive ? "#94a3b8" : "rgba(148, 163, 184, 0.1)",
              border: "2px solid #94a3b8",
              borderRadius: 14,
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcYActive ? "0 0 16px #94a3b8" : "none",
              color: gcYActive ? "#000" : "#94a3b8",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 20 }}>Y</b>
              <small style={{ fontSize: 10, fontWeight: 700 }}>JUMP</small>
            </div>

            {/* GC Z Button */}
            <div style={{
              background: gcZActive ? "#a855f7" : "rgba(168, 85, 247, 0.1)",
              border: "2px solid #a855f7",
              borderRadius: 10,
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcZActive ? "0 0 16px #a855f7" : "none",
              color: gcZActive ? "#fff" : "#a855f7",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 18 }}>Z</b>
              <small style={{ fontSize: 9, fontWeight: 700 }}>GRAB (R1)</small>
            </div>

            {/* GC Start */}
            <div style={{
              background: gcStartActive ? "#cbd5e1" : "rgba(203, 213, 225, 0.1)",
              border: "2px solid #cbd5e1",
              borderRadius: 10,
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcStartActive ? "0 0 16px #fff" : "none",
              color: gcStartActive ? "#000" : "#cbd5e1",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 16 }}>START</b>
              <small style={{ fontSize: 9, fontWeight: 700 }}>PAUSE</small>
            </div>

            {/* GC L-Trigger */}
            <div style={{
              background: gcLActive ? "#38bdf8" : "rgba(56, 189, 248, 0.1)",
              border: "2px solid #38bdf8",
              borderRadius: 10,
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcLActive ? "0 0 16px #38bdf8" : "none",
              color: gcLActive ? "#000" : "#38bdf8",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 16 }}>L-TRIG</b>
              <small style={{ fontSize: 9, fontWeight: 700 }}>SHIELD (L2)</small>
            </div>

            {/* GC R-Trigger */}
            <div style={{
              background: gcRActive ? "#38bdf8" : "rgba(56, 189, 248, 0.1)",
              border: "2px solid #38bdf8",
              borderRadius: 10,
              padding: "8px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: gcRActive ? "0 0 16px #38bdf8" : "none",
              color: gcRActive ? "#000" : "#38bdf8",
              transition: "all 0.05s ease-out",
            }}>
              <b style={{ fontSize: 16 }}>R-TRIG</b>
              <small style={{ fontSize: 9, fontWeight: 700 }}>SHIELD (R2)</small>
            </div>
          </div>
        </div>
      )}

      {/* Main Interactive Visualizer Grid */}
      {gamepadState && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
          {/* Left Column: Analog Sticks Visualizer */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "20px" }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>🕹️ 2D Analog Sticks (Main Stick & C-Stick)</span>
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
                    position: "absolute",
                    top: `${50 + (leftY * 42)}%`,
                    left: `${50 + (leftX * 42)}%`,
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: (Math.abs(leftX) > 0 || Math.abs(leftY) > 0) ? "#38bdf8" : "rgba(255,255,255,0.4)",
                    transform: "translate(-50%, -50%)",
                    boxShadow: (Math.abs(leftX) > 0 || Math.abs(leftY) > 0) ? "0 0 12px #38bdf8" : "none",
                    transition: "box-shadow 0.1s ease",
                  }} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#cbd5e1" }}>Main Control Stick</div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>X: {leftX.toFixed(2)} | Y: {leftY.toFixed(2)}</div>
              </div>

              {/* Right Stick / C-Stick Crosshair */}
              <div style={{ textAlign: "center" }}>
                <div style={{
                  width: 140,
                  height: 140,
                  borderRadius: "50%",
                  border: "2px solid rgba(234, 179, 8, 0.4)",
                  background: "radial-gradient(circle, rgba(234, 179, 8, 0.05) 0%, rgba(0,0,0,0.4) 100%)",
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
                    position: "absolute",
                    top: `${50 + (rightY * 42)}%`,
                    left: `${50 + (rightX * 42)}%`,
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: (Math.abs(rightX) > 0 || Math.abs(rightY) > 0) ? "#eab308" : "rgba(234, 179, 8, 0.5)",
                    transform: "translate(-50%, -50%)",
                    boxShadow: (Math.abs(rightX) > 0 || Math.abs(rightY) > 0) ? "0 0 12px #eab308" : "none",
                    transition: "box-shadow 0.1s ease",
                  }} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#facc15" }}>GameCube C-Stick</div>
                <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>X: {rightX.toFixed(2)} | Y: {rightY.toFixed(2)}</div>
              </div>
            </div>

            {/* Deadzone Slider */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
                <span>Stick Deadzone</span>
                <span>{Math.round(deadzone * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.02"
                max="0.30"
                step="0.01"
                value={deadzone}
                onChange={(e) => setDeadzone(parseFloat(e.target.value))}
                style={{ width: "100%", accentColor: "#6366f1", cursor: "pointer" }}
              />
            </div>
          </div>

          {/* Right Column: Trigger Gauges & Haptics */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "20px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px" }}>
                🎚️ Analog Triggers (L & R Click Threshold)
              </h3>

              {/* L2 / LT Trigger Gauge */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: "#cbd5e1" }}>Left Trigger (L)</span>
                  <span style={{ fontFamily: "monospace", color: "#38bdf8" }}>{Math.round((gamepadState?.buttons?.[6]?.value ?? 0) * 100)}%</span>
                </div>
                <div style={{ height: 12, background: "rgba(255,255,255,0.08)", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{
                    width: `${(gamepadState?.buttons?.[6]?.value ?? 0) * 100}%`,
                    height: "100%",
                    background: (gamepadState?.buttons?.[6]?.value ?? 0) > 0.85 ? "#10b981" : "#38bdf8",
                    transition: "width 0.05s ease-out",
                  }} />
                </div>
              </div>

              {/* R2 / RT Trigger Gauge */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: "#cbd5e1" }}>Right Trigger (R)</span>
                  <span style={{ fontFamily: "monospace", color: "#38bdf8" }}>{Math.round((gamepadState?.buttons?.[7]?.value ?? 0) * 100)}%</span>
                </div>
                <div style={{ height: 12, background: "rgba(255,255,255,0.08)", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{
                    width: `${(gamepadState?.buttons?.[7]?.value ?? 0) * 100}%`,
                    height: "100%",
                    background: (gamepadState?.buttons?.[7]?.value ?? 0) > 0.85 ? "#10b981" : "#38bdf8",
                    transition: "width 0.05s ease-out",
                  }} />
                </div>
              </div>
            </div>

            {/* Rumble Haptic Test Button */}
            <div>
              <button
                type="button"
                onClick={testHaptics}
                disabled={vibrationActive}
                style={{
                  width: "100%",
                  background: vibrationActive ? "rgba(16, 185, 129, 0.2)" : "rgba(255,255,255,0.06)",
                  border: vibrationActive ? "1px solid #10b981" : "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 12,
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

      {/* Button State Tiles */}
      {gamepadState && (
        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
              🔘 Real-Time Physical Controller Inputs
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 }}>
            {STANDARD_BUTTONS.map((btn) => {
              const state = gamepadState?.buttons?.[btn.index];
              const isPressed = state?.pressed;

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
                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                      Maps to: {btn.gcLabel}
                    </div>
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
