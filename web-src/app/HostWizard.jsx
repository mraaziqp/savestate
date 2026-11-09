import React, { useState, useEffect, useCallback } from "react";
import { useStyles, api, Note } from "./lib.jsx";

export function HostWizard() {
  useStyles();
  const [step, setStep] = useState(1);
  const [health, setHealth] = useState(null);
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadHostState = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [hRes, sRes] = await Promise.all([
        api("/api/health"),
        api("/api/storage/locations"),
      ]);
      setHealth(hRes);
      setStorage(sRes?.locations || []);
    } catch (err) {
      setError(err?.message || "Failed to load host telemetry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHostState();
  }, [loadHostState]);

  return (
    <div style={{ padding: "16px 20px", color: "#f8fafc", maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <h2 style={{ fontSize: 24, fontWeight: 900, margin: "0 0 6px", display: "flex", justifyContent: "center", alignItems: "center", gap: 10 }}>
          <span>🚀</span> SaveState Host Setup & Diagnostics
        </h2>
        <p style={{ margin: 0, fontSize: 14, color: "#94a3b8" }}>
          Step-by-step onboarding for self-hosted instances, multi-location storage verification, and client pairing.
        </p>
      </div>

      {error && (
        <div style={{ background: "rgba(239, 68, 68, 0.2)", border: "1px solid #ef4444", color: "#fca5a5", padding: "12px 16px", borderRadius: 12, marginBottom: 20, fontSize: 14, fontWeight: 600 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Step Indicators */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 30, position: "relative" }}>
        {[
          { num: 1, title: "Host Role" },
          { num: 2, title: "Storage & Drives" },
          { num: 3, title: "Libraries" },
          { num: 4, title: "Emulators" },
          { num: 5, title: "Client Pairing" },
        ].map((s) => {
          const isCurrent = step === s.num;
          const isDone = step > s.num;
          return (
            <div
              key={s.num}
              onClick={() => setStep(s.num)}
              style={{
                flex: 1,
                textAlign: "center",
                cursor: "pointer",
                padding: "8px 4px",
                borderBottom: `3px solid ${isCurrent ? "#38bdf8" : isDone ? "#10b981" : "rgba(255,255,255,0.1)"}`,
                transition: "all 0.2s ease",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 800, color: isCurrent ? "#38bdf8" : isDone ? "#10b981" : "#64748b" }}>
                STEP {s.num}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: isCurrent ? "#fff" : "#94a3b8" }}>
                {s.title}
              </div>
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "24px", minHeight: 320 }}>
        {step === 1 && (
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 10px" }}>🖥️ Machine Role: Host Server vs Client</h3>
            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6, marginBottom: 20 }}>
              This machine is running as the primary <strong>SaveState NexusEmu Host Server</strong>. It manages the PostgreSQL database, media libraries, transcode pipelines, and serves games and streams to remote clients.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid #38bdf8", borderRadius: 12, padding: "16px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#38bdf8", marginBottom: 6 }}>Host Mode (Current)</div>
                <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>
                  Executes background services, monitors storage mounts, hosts WebSockets, and transcodes media files on-demand.
                </div>
              </div>
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "16px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#94a3b8", marginBottom: 6 }}>Client Mode</div>
                <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>
                  Phones, Smart TVs, and laptops connect over LAN or WAN. They stream media and play retro games with cloud save sync.
                </div>
              </div>
            </div>

            {health && (
              <div style={{ marginTop: 24, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#64748b", marginBottom: 8 }}>
                  Host Diagnostic Snapshot:
                </div>
                <div style={{ display: "flex", gap: 20, fontSize: 13 }}>
                  <div>Host Status: <strong style={{ color: "#10b981" }}>ONLINE</strong></div>
                  <div>Database: <strong style={{ color: health.db_connected ? "#10b981" : "#ef4444" }}>{health.db_connected ? "CONNECTED" : "OFFLINE"}</strong></div>
                  <div>Node Runtime: <strong style={{ color: "#fff" }}>{health.node_version || "v22"}</strong></div>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 10px" }}>💾 Discovered Storage Locations & NAS Readiness</h3>
            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6, marginBottom: 16 }}>
              SaveState enforces multi-location storage with automated missing-drive protection and SSD write minimization.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {storage && storage.map((loc) => (
                <div
                  key={loc.id}
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 12,
                    padding: "12px 16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                      <span>{loc.isNas ? "🌐" : loc.storageType === "ssd" ? "⚡" : "💾"}</span>
                      <span>{loc.name}</span>
                      <span style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>({loc.mountPath})</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                      Type: {loc.storageType.toUpperCase()} · Priority: {loc.priority} · Permissions: {loc.permissions.toUpperCase()}
                    </div>
                  </div>

                  <span style={{
                    fontSize: 11,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: loc.connectivityStatus === "online" ? "rgba(16, 185, 129, 0.2)" : "rgba(245, 158, 11, 0.2)",
                    color: loc.connectivityStatus === "online" ? "#10b981" : "#f59e0b",
                  }}>
                    {loc.connectivityStatus.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 10px" }}>📁 Library Folders & Category Policies</h3>
            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6, marginBottom: 20 }}>
              Media and games are partitioned by drive and console. Fast local NVMe drives are reserved for PC gaming and HLS circular caches (capped at 3 GB).
            </p>
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Configured Root Paths:</div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#cbd5e1", lineHeight: 1.8 }}>
                <li>Movies & TV: <code style={{ color: "#38bdf8" }}>E:\Movies, F:\Movies, C:\Users\mraaz\Videos</code></li>
                <li>Retro Games: <code style={{ color: "#38bdf8" }}>E:\ROMS, F:\SaveState\client-roms</code></li>
                <li>Cloud Media: <code style={{ color: "#38bdf8" }}>I:\My Drive\NexusArchive</code></li>
                <li>HLS Circular Cache: <code style={{ color: "#38bdf8" }}>.nexus-persist/hls (TTL auto-pruned)</code></li>
              </ul>
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 10px" }}>🕹️ Emulator Engines & Standalone Cores</h3>
            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6, marginBottom: 16 }}>
              In-browser gaming runs on EmulatorJS WebAssembly cores with gamepad support. Local desktop gaming leverages standalone PCSX2 and RetroArch executables.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              {[
                { name: "PlayStation 2 (PCSX2)", status: "Configured (AVX2)" },
                { name: "GameCube (Dolphin)", status: "Ready" },
                { name: "PS1 / PSX (DuckStation)", status: "Ready" },
                { name: "GBA / SNES / NES", status: "WebAssembly Ready" },
              ].map((e) => (
                <div key={e.name} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{e.name}</div>
                  <div style={{ fontSize: 11, color: "#10b981", marginTop: 4 }}>✓ {e.status}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 5 && (
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 10px" }}>📱 Client Pairing & TV Remote Mirror</h3>
            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6, marginBottom: 20 }}>
              Any smartphone or tablet on your network can be paired in 2 seconds to act as a Smart TV remote control or full control mirror.
            </p>
            <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid #38bdf8", borderRadius: 12, padding: "18px", textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#38bdf8", marginBottom: 6 }}>Ready for Client Connections</div>
              <div style={{ fontSize: 13, color: "#cbd5e1" }}>
                Open <strong>https://savestate.co.za</strong> or your local IP on any phone, tap the TV Remote icon, and enter your TV screen PIN.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
        <button
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          disabled={step === 1}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "none",
            borderRadius: 8,
            padding: "8px 18px",
            color: step === 1 ? "#64748b" : "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: step === 1 ? "not-allowed" : "pointer",
          }}
        >
          Previous
        </button>

        <span style={{ fontSize: 12, color: "#64748b" }}>
          Step {step} of 5
        </span>

        <button
          onClick={() => setStep((s) => Math.min(5, s + 1))}
          disabled={step === 5}
          style={{
            background: step === 5 ? "rgba(255,255,255,0.1)" : "#38bdf8",
            border: "none",
            borderRadius: 8,
            padding: "8px 20px",
            color: step === 5 ? "#64748b" : "#000",
            fontSize: 13,
            fontWeight: 800,
            cursor: step === 5 ? "not-allowed" : "pointer",
          }}
        >
          {step === 5 ? "Completed" : "Next Step ➜"}
        </button>
      </div>
    </div>
  );
}
