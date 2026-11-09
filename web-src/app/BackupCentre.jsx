import React, { useState, useEffect, useCallback } from "react";
import { useStyles, api, Note } from "./lib.jsx";

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "0 B";
  const b = Math.max(0, bytes);
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function BackupCentre() {
  useStyles();
  const [profiles, setProfiles] = useState([]);
  const [archives, setArchives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Restore Preview & Execution Modal
  const [restoreModal, setRestoreModal] = useState({
    open: false,
    archiveId: "",
    preview: null,
    selectedCategories: ["database", "save_files", "watch_history"],
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [pRes, aRes] = await Promise.all([
        api("/api/backup/profiles"),
        api("/api/backup/archives"),
      ]);
      if (pRes?.profiles) setProfiles(pRes.profiles);
      if (aRes?.archives) setArchives(aRes.archives);
    } catch (err) {
      setError(err?.message || "Failed to load backup data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRunBackup = async (profileId) => {
    setBusy(`Running backup profile (${profileId})...`);
    setError("");
    setSuccess("");
    try {
      const res = await api(`/api/backup/run/${encodeURIComponent(profileId)}`, { method: "POST" });
      setSuccess(`Backup completed successfully! Archive SHA-256: ${res.archive?.checksumSha256?.slice(0, 12)}...`);
      await loadData();
    } catch (err) {
      setError(err?.message || "Backup run failed.");
    } finally {
      setBusy("");
    }
  };

  const handleOpenRestorePreview = async (archiveId) => {
    setBusy("Verifying archive SHA-256 integrity...");
    setError("");
    try {
      const res = await api("/api/backup/restore/preview", {
        method: "POST",
        body: { archiveId },
      });
      setRestoreModal({
        open: true,
        archiveId,
        preview: res.preview,
        selectedCategories: res.preview?.categoriesAvailable || ["database", "save_files"],
      });
    } catch (err) {
      setError(err?.message || "Restore preview failed.");
    } finally {
      setBusy("");
    }
  };

  const handleExecuteRestore = async () => {
    if (!restoreModal.archiveId || restoreModal.selectedCategories.length === 0) return;
    setBusy("Restoring verified records non-destructively...");
    setError("");
    setSuccess("");
    try {
      const res = await api("/api/backup/restore/execute", {
        method: "POST",
        body: {
          archiveId: restoreModal.archiveId,
          categories: restoreModal.selectedCategories,
        },
      });
      setSuccess(`Restore completed: ${res.result?.restoredCount ?? 0} items recovered safely.`);
      setRestoreModal({ open: false, archiveId: "", preview: null, selectedCategories: [] });
      await loadData();
    } catch (err) {
      setError(err?.message || "Restore execution failed.");
    } finally {
      setBusy("");
    }
  };

  const toggleCategory = (cat) => {
    setRestoreModal((prev) => {
      const exists = prev.selectedCategories.includes(cat);
      const next = exists
        ? prev.selectedCategories.filter((c) => c !== cat)
        : [...prev.selectedCategories, cat];
      return { ...prev, selectedCategories: next };
    });
  };

  return (
    <div style={{ padding: "16px 20px", color: "#f8fafc", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <span>🛡️</span> Backup & Disaster Recovery Centre
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
            Transactional PostgreSQL table exports, cloud save syncing, and SHA-256 verified non-destructive restores.
          </p>
        </div>

        <button
          onClick={loadData}
          disabled={loading || !!busy}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            padding: "8px 16px",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>🔄</span> Refresh
        </button>
      </div>

      {/* Status Notifications */}
      {busy && (
        <div style={{ background: "rgba(59, 130, 246, 0.2)", border: "1px solid #3b82f6", color: "#93c5fd", padding: "12px 16px", borderRadius: 12, marginBottom: 20, fontSize: 14, fontWeight: 600 }}>
          ⏳ {busy}
        </div>
      )}
      {error && (
        <div style={{ background: "rgba(239, 68, 68, 0.2)", border: "1px solid #ef4444", color: "#fca5a5", padding: "12px 16px", borderRadius: 12, marginBottom: 20, fontSize: 14, fontWeight: 600 }}>
          ⚠️ {error}
        </div>
      )}
      {success && (
        <div style={{ background: "rgba(16, 185, 129, 0.2)", border: "1px solid #10b981", color: "#6ee7b7", padding: "12px 16px", borderRadius: 12, marginBottom: 20, fontSize: 14, fontWeight: 600 }}>
          ✅ {success}
        </div>
      )}

      {/* Profiles Grid */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8" }}>
          Active Backup Profiles
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
          {profiles.map((p) => {
            const isNasPending = p.lastRunStatus === "awaiting_destination";
            return (
              <div
                key={p.id}
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: isNasPending ? "1px dashed rgba(245, 158, 11, 0.4)" : "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 14,
                  padding: "18px 20px",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h4 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{p.name}</h4>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: 6,
                      background: isNasPending ? "rgba(245, 158, 11, 0.2)" : "rgba(16, 185, 129, 0.2)",
                      color: isNasPending ? "#f59e0b" : "#10b981",
                    }}>
                      {isNasPending ? "Awaiting Capacity" : p.schedule.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
                    Destination: <span style={{ color: "#fff", fontFamily: "monospace" }}>{p.destinationPath}</span>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                    {p.categories.map((c) => (
                      <span key={c} style={{ fontSize: 11, background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 4, color: "#cbd5e1" }}>
                        {c.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
                  <span style={{ fontSize: 12, color: "#64748b" }}>
                    Retention: {p.retentionCount} snapshots
                  </span>
                  <button
                    onClick={() => handleRunBackup(p.id)}
                    disabled={isNasPending || !!busy}
                    style={{
                      background: isNasPending ? "rgba(255,255,255,0.05)" : "#3b82f6",
                      border: "none",
                      borderRadius: 8,
                      padding: "6px 14px",
                      color: isNasPending ? "#64748b" : "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: isNasPending ? "not-allowed" : "pointer",
                    }}
                  >
                    {isNasPending ? "Storage Pending" : "Run Backup Now ⚡"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Verified Archives Table */}
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8" }}>
          Verified Backup Snapshots ({archives.length})
        </h3>

        {archives.length === 0 ? (
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "30px", textAlign: "center", color: "#94a3b8" }}>
            No backup snapshots have been created yet. Run a profile above to generate your first verified snapshot.
          </div>
        ) : (
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#94a3b8", fontSize: 11, textTransform: "uppercase" }}>
                  <th style={{ padding: "12px 16px" }}>Snapshot ID / Date</th>
                  <th style={{ padding: "12px 16px" }}>Size</th>
                  <th style={{ padding: "12px 16px" }}>Files</th>
                  <th style={{ padding: "12px 16px" }}>SHA-256 Checksum</th>
                  <th style={{ padding: "12px 16px", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {archives.map((a) => (
                  <tr key={a.archiveId} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={{ padding: "14px 16px" }}>
                      <div style={{ fontWeight: 700 }}>{new Date(a.createdAt).toLocaleString()}</div>
                      <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>{a.archiveId}</div>
                    </td>
                    <td style={{ padding: "14px 16px", fontWeight: 600 }}>{formatBytes(a.totalSizeBytes)}</td>
                    <td style={{ padding: "14px 16px", color: "#cbd5e1" }}>{a.contents?.length || 0} items</td>
                    <td style={{ padding: "14px 16px" }}>
                      <span style={{ fontSize: 11, fontFamily: "monospace", color: "#10b981", background: "rgba(16, 185, 129, 0.1)", padding: "2px 6px", borderRadius: 4 }}>
                        {a.checksumSha256 ? `${a.checksumSha256.slice(0, 16)}...` : "VERIFIED"}
                      </span>
                    </td>
                    <td style={{ padding: "14px 16px", textAlign: "right" }}>
                      <button
                        onClick={() => handleOpenRestorePreview(a.archiveId)}
                        style={{
                          background: "rgba(56, 189, 248, 0.15)",
                          border: "1px solid #38bdf8",
                          borderRadius: 8,
                          padding: "6px 12px",
                          color: "#38bdf8",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Preview Restore ➜
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Non-Destructive Restore Modal */}
      {restoreModal.open && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000, display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
          <div style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 16, width: "100%", maxWidth: 560, padding: 24, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.7)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 18, fontWeight: 800, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span>🛡️</span> Non-Destructive Restore Wizard
              </h3>
              <button
                onClick={() => setRestoreModal({ open: false, archiveId: "", preview: null, selectedCategories: [] })}
                style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.5, marginBottom: 18 }}>
              Restore verified database records and save files. All restorations execute non-destructively: original files are preserved, and conflicting database rows merge via <code style={{ color: "#38bdf8" }}>ON CONFLICT DO NOTHING</code>.
            </p>

            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 14, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#64748b", marginBottom: 8 }}>
                Select Categories to Restore:
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {restoreModal.preview?.categoriesAvailable?.map((cat) => {
                  const checked = restoreModal.selectedCategories.includes(cat);
                  return (
                    <label key={cat} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCategory(cat)}
                        style={{ accentColor: "#38bdf8", width: 16, height: 16 }}
                      />
                      <span style={{ fontWeight: 600 }}>{cat.replace(/_/g, " ").toUpperCase()}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                onClick={() => setRestoreModal({ open: false, archiveId: "", preview: null, selectedCategories: [] })}
                style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 8, padding: "8px 16px", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleExecuteRestore}
                disabled={restoreModal.selectedCategories.length === 0 || !!busy}
                style={{
                  background: "#10b981",
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 20px",
                  color: "#000",
                  fontSize: 13,
                  fontWeight: 800,
                  cursor: restoreModal.selectedCategories.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                Execute Safe Restore ⚡
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
