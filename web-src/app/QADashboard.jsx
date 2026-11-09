import React, { useState, useEffect, useCallback } from "react";
import { useStyles, api, Note } from "./lib.jsx";

export function QADashboard() {
  useStyles();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api("/api/qa/status");
      if (res?.report) {
        setReport(res.report);
      }
    } catch (err) {
      setError(err?.message || "Failed to load QA status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleRunSuite = async () => {
    setRunning(true);
    setError("");
    try {
      const res = await api("/api/qa/run", { method: "POST" });
      if (res?.report) {
        setReport(res.report);
      }
    } catch (err) {
      setError(err?.message || "QA execution failed.");
    } finally {
      setRunning(false);
    }
  };

  const results = report?.results || [];
  const filteredResults = filter === "all"
    ? results
    : results.filter((r) => r.subsystem === filter);

  return (
    <div style={{ padding: "16px 20px", color: "#f8fafc", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <span>🧪</span> Automated QA Diagnostics & Stability Suite
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
            Real automated verification tests across storage, migration, backups, streaming ladders, intro detection and security.
          </p>
        </div>

        <button
          onClick={handleRunSuite}
          disabled={running}
          style={{
            background: running ? "rgba(255,255,255,0.1)" : "#3b82f6",
            border: "none",
            borderRadius: 10,
            padding: "10px 20px",
            color: "#fff",
            fontSize: 13,
            fontWeight: 700,
            cursor: running ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
            boxShadow: running ? "none" : "0 4px 14px rgba(59, 130, 246, 0.4)",
          }}
        >
          <span>{running ? "⏳" : "⚡"}</span>
          <span>{running ? "Running Diagnostics..." : "Run Non-Destructive QA Tests"}</span>
        </button>
      </div>

      {error && (
        <div style={{ background: "rgba(239, 68, 68, 0.2)", border: "1px solid #ef4444", color: "#fca5a5", padding: "12px 16px", borderRadius: 12, marginBottom: 20, fontSize: 14, fontWeight: 600 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Overview Metric Banner */}
      {report && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 22 }}>
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>Total Tests</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", marginTop: 2 }}>{report.totalTests}</div>
          </div>
          <div style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.2)", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "#10b981", textTransform: "uppercase", fontWeight: 700 }}>Passed</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#10b981", marginTop: 2 }}>{report.passedCount}</div>
          </div>
          <div style={{ background: report.failedCount > 0 ? "rgba(239, 68, 68, 0.08)" : "rgba(255,255,255,0.03)", border: `1px solid ${report.failedCount > 0 ? "rgba(239, 68, 68, 0.3)" : "rgba(255,255,255,0.08)"}`, borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: report.failedCount > 0 ? "#ef4444" : "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>Failed</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: report.failedCount > 0 ? "#ef4444" : "#fff", marginTop: 2 }}>{report.failedCount}</div>
          </div>
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", fontWeight: 700 }}>Suite Duration</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#38bdf8", marginTop: 2 }}>{report.totalDurationMs} ms</div>
          </div>
        </div>
      )}

      {/* Subsystem Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        {["all", "storage", "migration", "backup", "streaming", "intro", "security"].map((sub) => (
          <button
            key={sub}
            onClick={() => setFilter(sub)}
            style={{
              background: filter === sub ? "rgba(56, 189, 248, 0.2)" : "rgba(255,255,255,0.04)",
              border: filter === sub ? "1px solid #38bdf8" : "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              padding: "6px 14px",
              color: filter === sub ? "#fff" : "#94a3b8",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {sub === "all" ? "All Subsystems" : sub}
          </button>
        ))}
      </div>

      {/* Test Results List */}
      {!report ? (
        <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "30px", textAlign: "center", color: "#94a3b8" }}>
          No QA tests have been executed yet. Click "Run Non-Destructive QA Tests" above to execute real tests across all platform subsystems.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filteredResults.map((r) => (
            <div
              key={r.id}
              style={{
                background: "rgba(255,255,255,0.02)",
                border: `1px solid ${r.passed ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.3)"}`,
                borderRadius: 12,
                padding: "14px 18px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 0, flex: 1, paddingRight: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 14 }}>{r.passed ? "🟢" : "🔴"}</span>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                  <span style={{ fontSize: 10, background: "rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: 4, color: "#94a3b8", textTransform: "uppercase" }}>
                    {r.subsystem}
                  </span>
                </div>
                {r.details && (
                  <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.4 }}>
                    {r.details}
                  </div>
                )}
                {r.error && (
                  <div style={{ fontSize: 12, color: "#fca5a5", marginTop: 4, fontFamily: "monospace" }}>
                    Error: {r.error}
                  </div>
                )}
              </div>

              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ fontSize: 12, fontFamily: "monospace", color: "#94a3b8", background: "rgba(255,255,255,0.05)", padding: "3px 8px", borderRadius: 6 }}>
                  {r.durationMs} ms
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
