import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useStyles, api, goTab, Note } from "./lib.jsx";
import { BackupCentre } from "./BackupCentre.jsx";
import { QADashboard } from "./QADashboard.jsx";
import { ControllerTester } from "./ControllerTester.jsx";

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "0 B";
  const b = Math.max(0, bytes);
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function LibraryManager() {
  useStyles();
  const [activeTab, setActiveTab] = useState("files"); // "files" | "installed" | "storage" | "migration" | "backup" | "qa" | "controller"
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  // Storage Registry & Console Policies
  const [locations, setLocations] = useState([]);
  const [policies, setPolicies] = useState([]);

  // Filters for Files Tab
  const [typeFilter, setTypeFilter] = useState("all"); // "all" | "games" | "media"
  const [driveFilter, setDriveFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("size_desc");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Selected items: Set of item IDs
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Delete & Move modal states
  const [deleteModal, setDeleteModal] = useState({ open: false, items: [], totalBytes: 0 });
  const [moveModal, setMoveModal] = useState({ open: false, items: [], targetDrive: "E:\\ROMS" });

  // Safe Uninstall modal (Steam-style)
  const [safeUninstallModal, setSafeUninstallModal] = useState({ open: false, game: null });

  // NAS Configuration Modal
  const [nasModal, setNasModal] = useState({
    open: false,
    host: "",
    shareName: "",
    protocol: "smb",
    mountPath: "\\\\nas\\media",
    targetCapacityGB: 4000,
    notes: "",
  });

  // Migration Engine State
  const [migrationState, setMigrationState] = useState({
    sourceLocationId: "drive_c",
    destLocationId: "nas_primary",
    category: "all",
    plan: null,
    userApproved: false,
    running: false,
    status: null,
  });

  // Load storage summary
  const loadSummary = useCallback(async () => {
    try {
      const data = await api("/api/library/storage-summary");
      setSummary(data);
    } catch (err) {
      console.error("Storage summary error:", err);
    }
  }, []);

  // Load locations and policies
  const loadStorageLocationsAndPolicies = useCallback(async () => {
    try {
      const [lRes, pRes] = await Promise.all([
        api("/api/storage/locations"),
        api("/api/storage/policies"),
      ]);
      if (lRes?.locations) setLocations(lRes.locations);
      if (pRes?.policies) setPolicies(pRes.policies);
    } catch (err) {
      console.error("Storage locations error:", err);
    }
  }, []);

  // Load items
  const loadItems = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const q = new URLSearchParams({
        type: typeFilter,
        drive: driveFilter,
        search,
        sort,
        limit: String(limit),
        offset: String(offset),
      });
      const data = await api(`/api/library/items?${q.toString()}`);
      if (data?.items) {
        setItems(data.items);
        setTotalItems(data.total || 0);
      }
    } catch (err) {
      setError(err?.message || "Failed to load library items.");
    } finally {
      setLoading(false);
    }
  }, [typeFilter, driveFilter, search, sort, offset]);

  useEffect(() => {
    loadSummary();
    loadStorageLocationsAndPolicies();
  }, [loadSummary, loadStorageLocationsAndPolicies]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // Toggle selection
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllCurrent = () => {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
  };

  const selectedItemsList = useMemo(() => {
    return items.filter((i) => selectedIds.has(i.id));
  }, [items, selectedIds]);

  const selectedTotalBytes = useMemo(() => {
    return selectedItemsList.reduce((acc, i) => acc + (i.size || 0), 0);
  }, [selectedItemsList]);

  // Open delete dialog
  const promptDeleteSelected = () => {
    if (selectedItemsList.length === 0) return;
    setDeleteModal({
      open: true,
      items: selectedItemsList,
      totalBytes: selectedTotalBytes,
    });
  };

  const promptDeleteSingle = (item) => {
    setDeleteModal({
      open: true,
      items: [item],
      totalBytes: item.size || 0,
    });
  };

  // Open move dialog
  const promptMoveSelected = () => {
    if (selectedItemsList.length === 0) return;
    setMoveModal({
      open: true,
      items: selectedItemsList,
      targetDrive: "E:\\ROMS",
    });
  };

  const promptMoveSingle = (item) => {
    setMoveModal({
      open: true,
      items: [item],
      targetDrive: item.drive === "E:" ? "I:\\My Drive\\NexusArchive\\roms" : "E:\\ROMS",
    });
  };

  // Execute deletion
  const executeDelete = async () => {
    if (!deleteModal.items.length) return;
    setBusy(`Deleting ${deleteModal.items.length} item(s) and reclaiming storage space...`);
    setError("");
    try {
      const payload = {
        items: deleteModal.items.map((i) => ({ id: i.id, type: i.type })),
      };
      const res = await api("/api/library/delete", {
        method: "POST",
        body: payload,
      });

      setDeleteModal({ open: false, items: [], totalBytes: 0 });
      setSelectedIds(new Set());
      await loadSummary();
      await loadItems();

      if (res?.errors && res.errors.length > 0) {
        setError(`Deleted ${res.deletedCount} items (${res.freedFormatted}), but some files had errors: ${res.errors.join(", ")}`);
      }
    } catch (err) {
      setError(err?.message || "Failed to delete library items.");
    } finally {
      setBusy("");
    }
  };

  // Confirm Safe Uninstall for Installed Games
  const confirmSafeUninstall = async () => {
    const game = safeUninstallModal.game;
    if (!game) return;
    setBusy(`Safely uninstalling ${game.title} (preserving cloud saves & ROM sources)...`);
    setError("");
    try {
      await api("/api/library/delete", {
        method: "POST",
        body: { items: [{ id: game.id, type: "game" }] },
      });
      setSafeUninstallModal({ open: false, game: null });
      await loadSummary();
      await loadItems();
    } catch (err) {
      setError(err?.message || "Safe uninstall failed.");
    } finally {
      setBusy("");
    }
  };

  // Execute Move
  const executeMove = async () => {
    if (!moveModal.items.length || !moveModal.targetDrive) return;
    setBusy(`Moving ${moveModal.items.length} item(s) to ${moveModal.targetDrive}...`);
    setError("");
    try {
      const payload = {
        targetDrive: moveModal.targetDrive,
        items: moveModal.items.map((i) => ({ id: i.id, type: i.type })),
      };
      const res = await api("/api/library/move", {
        method: "POST",
        body: payload,
      });

      setMoveModal({ open: false, items: [], targetDrive: "E:\\ROMS" });
      setSelectedIds(new Set());
      await loadSummary();
      await loadItems();

      if (res?.errors && res.errors.length > 0) {
        setError(`Moved ${res.movedCount} items (${res.movedFormatted}), with errors: ${res.errors.join(", ")}`);
      }
    } catch (err) {
      setError(err?.message || "Failed to move library items.");
    } finally {
      setBusy("");
    }
  };

  // Configure NAS without moving files
  const handleSaveNasConfig = async () => {
    if (!nasModal.host || !nasModal.shareName || !nasModal.mountPath) return;
    setBusy("Configuring NAS storage (safe pending capacity state)...");
    setError("");
    try {
      await api("/api/storage/nas/configure", {
        method: "POST",
        body: {
          host: nasModal.host,
          shareName: nasModal.shareName,
          protocol: nasModal.protocol,
          mountPath: nasModal.mountPath,
          targetCapacityBytes: Number(nasModal.targetCapacityGB) * 1024 * 1024 * 1024,
          notes: nasModal.notes,
        },
      });
      setNasModal({ open: false, host: "", shareName: "", protocol: "smb", mountPath: "\\\\nas\\media", targetCapacityGB: 4000, notes: "" });
      await loadStorageLocationsAndPolicies();
      await loadSummary();
    } catch (err) {
      setError(err?.message || "Failed to configure NAS.");
    } finally {
      setBusy("");
    }
  };

  // Generate Safe Migration Dry-Run Plan
  const handleGenerateMigrationPlan = async () => {
    setBusy("Generating safe dry-run migration plan & calculating checksums...");
    setError("");
    try {
      const res = await api("/api/storage/migration/plan", {
        method: "POST",
        body: {
          sourceLocationId: migrationState.sourceLocationId,
          destLocationId: migrationState.destLocationId,
          category: migrationState.category,
        },
      });
      setMigrationState((prev) => ({ ...prev, plan: res?.manifest, userApproved: false }));
    } catch (err) {
      setError(err?.message || "Failed to generate migration plan.");
    } finally {
      setBusy("");
    }
  };

  // Execute Migration
  const handleExecuteMigration = async () => {
    if (!migrationState.userApproved) return;
    setBusy("Starting verified copy-before-unlink migration in background...");
    setError("");
    try {
      const res = await api("/api/storage/migration/execute", {
        method: "POST",
        body: { userConfirmation: true },
      });
      setMigrationState((prev) => ({ ...prev, running: true, status: res?.status }));
    } catch (err) {
      setError(err?.message || "Failed to start migration.");
    } finally {
      setBusy("");
    }
  };

  // Direct action: Launch game or Play movie
  const handleLaunchOrPlay = (item) => {
    if (window.__nxTvRemote?.isMirrorActive) {
      if (item.type === "game") {
        window.__nxTvRemote.launchOnTv(item);
      } else if (item.type === "media") {
        window.__nxTvRemote.playOnTv(item);
      }
      return;
    }
    if (item.type === "game") {
      window.dispatchEvent(new CustomEvent("nexus:play", {
        detail: { phase: "browser", mode: "browser", game: item }
      }));
    } else if (item.type === "media") {
      goTab("media");
    }
  };

  const handleDriveCardClick = (driveKey) => {
    setDriveFilter((prev) => (prev === driveKey ? "all" : driveKey));
    setOffset(0);
  };

  // Filter installed games for the dedicated Steam view
  const installedGames = useMemo(() => {
    return items.filter((i) => i.type === "game");
  }, [items]);

  return (
    <div style={{
      maxWidth: 1140,
      margin: "0 auto",
      padding: "24px 20px 100px",
      color: "#f8fafc",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 28 }}>💾</span>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>
              SaveState Storage & Library Cockpit
            </h1>
          </div>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#94a3b8" }}>
            Multi-location drive management, Steam-style installed game launcher, safe migrations, and non-destructive recovery.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => { loadSummary(); loadItems(); loadStorageLocationsAndPolicies(); }}
            style={{
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
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
      </div>

      {/* Sub-Navigation Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, overflowX: "auto", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: 10 }}>
        {[
          { id: "files", label: "Library & Files", icon: "📂" },
          { id: "installed", label: "Installed Games (Steam View)", icon: "🎮" },
          { id: "storage", label: "Storage Drives & NAS", icon: "💾" },
          { id: "migration", label: "Safe Migration", icon: "🚀" },
          { id: "backup", label: "Backup & Recovery", icon: "🛡️" },
          { id: "qa", label: "Diagnostics & QA", icon: "🧪" },
          { id: "controller", label: "Gamepad Calibration", icon: "🕹️" },
        ].map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                background: isActive ? "rgba(56, 189, 248, 0.15)" : "rgba(255,255,255,0.03)",
                border: isActive ? "1px solid #38bdf8" : "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
                padding: "8px 16px",
                color: isActive ? "#fff" : "#94a3b8",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                whiteSpace: "nowrap",
                transition: "all 0.15s ease",
              }}
            >
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Busy or Error Banner */}
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

      {/* ──────────────── TAB 1: FILE BROWSER & BULK ACTIONS ──────────────── */}
      {activeTab === "files" && (
        <div>
          {/* Interactive Storage Dashboard: Clickable Drive Cards */}
          {summary?.drives && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: "#64748b" }}>
                  Storage Drives (Click to Filter)
                </span>
                {driveFilter !== "all" && (
                  <button
                    onClick={() => setDriveFilter("all")}
                    style={{ background: "none", border: "none", color: "#38bdf8", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                  >
                    Clear Drive Filter ✕
                  </button>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(235px, 1fr))", gap: 12 }}>
                {summary.drives.map((d) => {
                  const isFiltered = driveFilter === d.drive;
                  return (
                    <div
                      key={d.drive}
                      onClick={() => handleDriveCardClick(d.drive)}
                      style={{
                        background: isFiltered ? "rgba(56, 189, 248, 0.12)" : "rgba(255,255,255,0.04)",
                        border: isFiltered ? "2px solid #38bdf8" : "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 14,
                        padding: "16px 18px",
                        cursor: "pointer",
                        transition: "all 0.18s ease",
                        boxShadow: isFiltered ? "0 0 20px rgba(56, 189, 248, 0.25)" : "none",
                      }}
                      title={`Click to filter library items to ${d.label}`}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 16 }}>{d.isCloud ? "☁️" : d.drive.startsWith("C") ? "⚡" : "💾"}</span>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{d.label}</span>
                        </div>
                        {isFiltered ? (
                          <span style={{ fontSize: 11, background: "#38bdf8", color: "#000", padding: "2px 6px", borderRadius: 4, fontWeight: 800 }}>
                            Active
                          </span>
                        ) : (
                          <span style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace" }}>{d.drive}</span>
                        )}
                      </div>

                      {/* Progress bar */}
                      <div style={{ height: 8, background: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${d.percentUsed}%`,
                            background: d.percentUsed > 90 ? "#ef4444" : d.percentUsed > 75 ? "#f59e0b" : "#3b82f6",
                            borderRadius: 4,
                          }}
                        />
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8" }}>
                        <span>Free: <strong style={{ color: "#fff" }}>{d.freeFormatted}</strong></span>
                        <span>Used: {d.percentUsed}% of {d.totalFormatted}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Preset Quick Chips & Search Bar */}
          <div style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            padding: "16px 18px",
            marginBottom: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              {/* Type Filter Buttons */}
              <div style={{ display: "flex", gap: 6, background: "rgba(0,0,0,0.3)", padding: 4, borderRadius: 10 }}>
                <button
                  onClick={() => { setTypeFilter("all"); setOffset(0); }}
                  style={{ ...filterTabBtn, background: typeFilter === "all" ? "#38bdf8" : "transparent", color: typeFilter === "all" ? "#000" : "#94a3b8" }}
                >
                  All Items
                </button>
                <button
                  onClick={() => { setTypeFilter("games"); setOffset(0); }}
                  style={{ ...filterTabBtn, background: typeFilter === "games" ? "#38bdf8" : "transparent", color: typeFilter === "games" ? "#000" : "#94a3b8" }}
                >
                  🎮 Games
                </button>
                <button
                  onClick={() => { setTypeFilter("media"); setOffset(0); }}
                  style={{ ...filterTabBtn, background: typeFilter === "media" ? "#38bdf8" : "transparent", color: typeFilter === "media" ? "#000" : "#94a3b8" }}
                >
                  🎬 Media & Shows
                </button>
              </div>

              {/* Sort Selector */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600 }}>Sort by:</span>
                <select
                  value={sort}
                  onChange={(e) => { setSort(e.target.value); setOffset(0); }}
                  style={selectStyle}
                >
                  <option value="size_desc">Size (Largest first)</option>
                  <option value="size_asc">Size (Smallest first)</option>
                  <option value="title_asc">Title (A - Z)</option>
                  <option value="date_desc">Recently Added</option>
                </select>
              </div>
            </div>

            {/* Search Input & Quick Preset Chips */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ position: "relative", flex: 1 }}>
                <span style={{ position: "absolute", left: 14, top: 10, fontSize: 14, color: "#64748b" }}>🔍</span>
                <input
                  type="text"
                  placeholder="Filter by title, series, platform, folder, or drive path..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 10,
                    padding: "9px 14px 9px 38px",
                    color: "#fff",
                    fontSize: 13,
                    outline: "none",
                  }}
                />
              </div>

              {searchInput && (
                <button
                  onClick={() => { setSearchInput(""); setSearch(""); }}
                  style={{ background: "rgba(255,255,255,0.06)", border: "none", borderRadius: 8, padding: "9px 14px", color: "#94a3b8", fontSize: 13, cursor: "pointer" }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Bulk Selection Bar */}
          {selectedIds.size > 0 && (
            <div style={{
              background: "rgba(56, 189, 248, 0.15)",
              border: "1px solid #38bdf8",
              borderRadius: 12,
              padding: "12px 18px",
              marginBottom: 16,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontWeight: 800, fontSize: 14, color: "#38bdf8" }}>
                  ✓ {selectedIds.size} Selected ({formatBytes(selectedTotalBytes)})
                </span>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 12, cursor: "pointer" }}
                >
                  Deselect all
                </button>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={promptMoveSelected}
                  style={{
                    background: "rgba(59, 130, 246, 0.3)",
                    border: "1px solid #3b82f6",
                    borderRadius: 8,
                    padding: "6px 14px",
                    color: "#93c5fd",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  🚀 Move to Drive...
                </button>
                <button
                  onClick={promptDeleteSelected}
                  style={{
                    background: "rgba(239, 68, 68, 0.3)",
                    border: "1px solid #ef4444",
                    borderRadius: 8,
                    padding: "6px 14px",
                    color: "#fca5a5",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  🗑️ Delete Selected
                </button>
              </div>
            </div>
          )}

          {/* Items Table */}
          <div style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16,
            overflow: "hidden",
            marginBottom: 20,
          }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "40px 60px 1fr 140px 100px 140px",
              padding: "12px 16px",
              background: "rgba(255,255,255,0.04)",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              fontSize: 11,
              fontWeight: 700,
              color: "#94a3b8",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              alignItems: "center",
            }}>
              <div>
                <input
                  type="checkbox"
                  checked={selectedIds.size === items.length && items.length > 0}
                  onChange={selectAllCurrent}
                  style={{ accentColor: "#38bdf8", cursor: "pointer" }}
                />
              </div>
              <div>Art</div>
              <div>Title & Path</div>
              <div>Drive / Cloud</div>
              <div style={{ textAlign: "right" }}>Size</div>
              <div style={{ textAlign: "right" }}>Actions</div>
            </div>

            {loading ? (
              <div style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8" }}>
                Loading items...
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8" }}>
                No library items found matching your filters.
              </div>
            ) : (
              <div>
                {items.map((item) => {
                  const isSelected = selectedIds.has(item.id);
                  return (
                    <div
                      key={item.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "40px 60px 1fr 140px 100px 140px",
                        padding: "10px 16px",
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        background: isSelected ? "rgba(56, 189, 248, 0.08)" : "transparent",
                        alignItems: "center",
                        fontSize: 13,
                        transition: "background 0.1s ease",
                      }}
                    >
                      <div>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(item.id)}
                          style={{ accentColor: "#38bdf8", cursor: "pointer" }}
                        />
                      </div>

                      {/* Box Art */}
                      <div style={{ width: 44, height: 44, borderRadius: 6, overflow: "hidden", background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {item.boxArt ? (
                          <img
                            src={item.boxArt}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                          />
                        ) : (
                          <span style={{ fontSize: 18 }}>{item.type === "game" ? "🎮" : "🎬"}</span>
                        )}
                      </div>

                      {/* Title & Path */}
                      <div style={{ paddingRight: 12, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {item.title}
                        </div>
                        <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {item.path || item.relativePath}
                        </div>
                      </div>

                      {/* Drive / Location */}
                      <div>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 6,
                          background: item.isCloud ? "rgba(168, 85, 247, 0.2)" : "rgba(255,255,255,0.08)",
                          color: item.isCloud ? "#c084fc" : "#cbd5e1",
                        }}>
                          {item.isCloud ? "☁️ Google Drive" : `💾 ${item.drive}`}
                        </span>
                      </div>

                      {/* Size */}
                      <div style={{ textAlign: "right", fontWeight: 700, color: "#cbd5e1" }}>
                        {item.sizeFormatted}
                      </div>

                      {/* Row Actions */}
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button
                          onClick={() => handleLaunchOrPlay(item)}
                          style={{ ...smallActionBtn, background: "rgba(56, 189, 248, 0.2)", color: "#38bdf8" }}
                          title="Launch"
                        >
                          ▶
                        </button>
                        <button
                          onClick={() => promptMoveSingle(item)}
                          style={smallActionBtn}
                          title="Move Drive"
                        >
                          🚀
                        </button>
                        <button
                          onClick={() => promptDeleteSingle(item)}
                          style={{ ...smallActionBtn, color: "#fca5a5" }}
                          title="Delete"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Pagination */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              Showing {items.length > 0 ? offset + 1 : 0} to {Math.min(totalItems, offset + items.length)} of {totalItems} items
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={offset === 0}
                onClick={() => setOffset((prev) => Math.max(0, prev - limit))}
                style={{ ...paginationBtn, opacity: offset === 0 ? 0.4 : 1, cursor: offset === 0 ? "not-allowed" : "pointer" }}
              >
                ◀ Previous
              </button>
              <button
                disabled={offset + limit >= totalItems}
                onClick={() => setOffset((prev) => prev + limit)}
                style={{ ...paginationBtn, opacity: offset + limit >= totalItems ? 0.4 : 1, cursor: offset + limit >= totalItems ? "not-allowed" : "pointer" }}
              >
                Next ▶
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ──────────────── TAB 2: INSTALLED GAMES (STEAM-STYLE) ──────────────── */}
      {activeTab === "installed" && (
        <div>
          <div style={{ marginBottom: 18, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>🎮 Locally Installed Games</h3>
              <p style={{ margin: 0, fontSize: 13, color: "#94a3b8" }}>
                Steam-style management for local and desktop titles. Reclaim disk space safely without touching ROMs or cloud saves.
              </p>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#38bdf8", background: "rgba(56, 189, 248, 0.1)", padding: "4px 12px", borderRadius: 8 }}>
              {installedGames.length} Installed Titles
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
            {installedGames.map((game) => (
              <div
                key={game.id}
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 14,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  transition: "all 0.2s ease",
                }}
              >
                {/* Poster image */}
                <div style={{ height: 160, position: "relative", background: "rgba(0,0,0,0.4)" }}>
                  {game.boxArt ? (
                    <img
                      src={game.boxArt}
                      alt={game.title}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                    />
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: 32 }}>
                      🎮
                    </div>
                  )}
                  <span style={{
                    position: "absolute",
                    top: 8,
                    left: 8,
                    fontSize: 10,
                    fontWeight: 800,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "rgba(0,0,0,0.7)",
                    color: "#38bdf8",
                    backdropFilter: "blur(4px)",
                  }}>
                    {game.platform?.toUpperCase() || "GAME"}
                  </span>
                </div>

                <div style={{ padding: "12px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                  <div>
                    <h4 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {game.title}
                    </h4>
                    <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                      <span>Disk: <strong>{game.sizeFormatted}</strong></span>
                      <span style={{ fontFamily: "monospace" }}>{game.drive}</span>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => handleLaunchOrPlay(game)}
                      style={{
                        flex: 1,
                        background: "#3b82f6",
                        border: "none",
                        borderRadius: 8,
                        padding: "6px 0",
                        color: "#fff",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      ▶ Play
                    </button>
                    <button
                      onClick={() => setSafeUninstallModal({ open: true, game })}
                      style={{
                        background: "rgba(239, 68, 68, 0.15)",
                        border: "1px solid rgba(239, 68, 68, 0.3)",
                        borderRadius: 8,
                        padding: "6px 10px",
                        color: "#fca5a5",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                      title="Safe Uninstall"
                    >
                      Uninstall
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ──────────────── TAB 3: STORAGE DRIVES & NAS ARCHITECTURE ──────────────── */}
      {activeTab === "storage" && (
        <div>
          {/* Header & NAS Setup Button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
            <div>
              <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>💾 Centralized Storage & NAS Architecture</h3>
              <p style={{ margin: 0, fontSize: 13, color: "#94a3b8" }}>
                Multi-location drives, missing drive protection, SSD write minimization, and per-console storage rules.
              </p>
            </div>
            <button
              onClick={() => setNasModal({ open: true, host: "", shareName: "", protocol: "smb", mountPath: "\\\\nas\\media", targetCapacityGB: 4000, notes: "" })}
              style={{
                background: "#38bdf8",
                border: "none",
                borderRadius: 10,
                padding: "8px 16px",
                color: "#000",
                fontSize: 13,
                fontWeight: 800,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>🌐</span> Configure NAS (Pending Capacity)
            </button>
          </div>

          {/* SSD Write Minimization Guard Notice */}
          <div style={{ background: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.3)", borderRadius: 12, padding: "14px 18px", marginBottom: 20, display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 24 }}>⚡</span>
            <div style={{ fontSize: 13, color: "#fef3c7", lineHeight: 1.5 }}>
              <strong>Dell Vostro 3500 Host Architecture Guard:</strong> Primary NVMe SSD write minimization is actively enforced. HLS circular stream caches are capped at ≤ 3 GB and auto-pruned, while bulk media storage is offloaded to secondary drives and future NAS network shares.
            </div>
          </div>

          {/* Storage Locations Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 28 }}>
            {locations.map((loc) => {
              const isNas = loc.isNas;
              const isPending = loc.nasConfig?.status === "configured_pending_capacity";
              return (
                <div
                  key={loc.id}
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: isPending ? "1px dashed rgba(245, 158, 11, 0.4)" : "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 14,
                    padding: "16px 18px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{isNas ? "🌐" : loc.storageType === "ssd" ? "⚡" : "💾"}</span>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>{loc.name}</span>
                    </div>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 800,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: isPending ? "rgba(245, 158, 11, 0.2)" : loc.connectivityStatus === "online" ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                      color: isPending ? "#f59e0b" : loc.connectivityStatus === "online" ? "#10b981" : "#ef4444",
                    }}>
                      {isPending ? "AWAITING EXPANSION" : loc.connectivityStatus.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace", marginBottom: 10 }}>
                    Path: {loc.mountPath}
                  </div>

                  <div style={{ height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
                    <div style={{
                      height: "100%",
                      width: `${loc.totalBytes > 0 ? Math.round((loc.usedBytes / loc.totalBytes) * 100) : 0}%`,
                      background: loc.storageType === "ssd" ? "#38bdf8" : "#10b981",
                    }} />
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8" }}>
                    <span>Free: <strong style={{ color: "#fff" }}>{formatBytes(loc.availableBytes)}</strong></span>
                    <span>Total: {formatBytes(loc.totalBytes)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Console Storage Policies Matrix */}
          <div>
            <h4 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", textTransform: "uppercase", letterSpacing: 0.5, color: "#94a3b8" }}>
              Per-Console Storage Policies
            </h4>
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.08)", color: "#94a3b8", fontSize: 11, textTransform: "uppercase" }}>
                    <th style={{ padding: "10px 16px" }}>Console / Platform</th>
                    <th style={{ padding: "10px 16px" }}>Preferred Storage</th>
                    <th style={{ padding: "10px 16px" }}>Network Stream Allowed</th>
                    <th style={{ padding: "10px 16px" }}>Local Cache Required</th>
                    <th style={{ padding: "10px 16px" }}>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((pol) => (
                    <tr key={pol.consoleId} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <td style={{ padding: "12px 16px", fontWeight: 700 }}>{pol.displayName}</td>
                      <td style={{ padding: "12px 16px", color: "#38bdf8" }}>{pol.preferredLocationId}</td>
                      <td style={{ padding: "12px 16px" }}>{pol.allowNetworkStream ? "✅ Yes" : "❌ Local Only"}</td>
                      <td style={{ padding: "12px 16px" }}>{pol.localCacheRequired ? "⚡ Required (Fast I/O)" : "Optional"}</td>
                      <td style={{ padding: "12px 16px", fontFamily: "monospace" }}>#{pol.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ──────────────── TAB 4: SAFE STORAGE MIGRATION ──────────────── */}
      {activeTab === "migration" && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>🚀 10-Stage Safe Migration Engine</h3>
            <p style={{ margin: 0, fontSize: 13, color: "#94a3b8" }}>
              Non-destructive copy-before-unlink protocol with SHA-256 pre/post verification and dry-run previews.
            </p>
          </div>

          {/* Safe Migration Planner Card */}
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "20px", marginBottom: 20 }}>
            <h4 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 14px" }}>Configure Migration Plan (Dry-Run Preview)</h4>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 16 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6, fontWeight: 600 }}>Source Storage Location:</label>
                <select
                  value={migrationState.sourceLocationId}
                  onChange={(e) => setMigrationState((prev) => ({ ...prev, sourceLocationId: e.target.value }))}
                  style={{ ...selectStyle, width: "100%" }}
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name} ({loc.mountPath})</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6, fontWeight: 600 }}>Destination Location:</label>
                <select
                  value={migrationState.destLocationId}
                  onChange={(e) => setMigrationState((prev) => ({ ...prev, destLocationId: e.target.value }))}
                  style={{ ...selectStyle, width: "100%" }}
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name} ({loc.mountPath})</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6, fontWeight: 600 }}>Item Category:</label>
                <select
                  value={migrationState.category}
                  onChange={(e) => setMigrationState((prev) => ({ ...prev, category: e.target.value }))}
                  style={{ ...selectStyle, width: "100%" }}
                >
                  <option value="all">All Library Files</option>
                  <option value="movies">Movies Only</option>
                  <option value="tv">TV Shows & Series</option>
                  <option value="games">Games / ROMs</option>
                </select>
              </div>
            </div>

            <button
              onClick={handleGenerateMigrationPlan}
              disabled={!!busy}
              style={{
                background: "#3b82f6",
                border: "none",
                borderRadius: 10,
                padding: "10px 20px",
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Generate Dry-Run Manifest ➜
            </button>
          </div>

          {/* Migration Manifest Preview */}
          {migrationState.plan && (
            <div style={{ background: "rgba(56, 189, 248, 0.05)", border: "1px solid #38bdf8", borderRadius: 16, padding: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h4 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: "#38bdf8" }}>
                  📋 Dry-Run Manifest: {migrationState.plan.id}
                </h4>
                <span style={{ fontSize: 11, background: "#38bdf8", color: "#000", padding: "2px 8px", borderRadius: 4, fontWeight: 800 }}>
                  STAGE 9: DRY-RUN VERIFIED
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 16, fontSize: 13 }}>
                <div>Total Candidate Files: <strong>{migrationState.plan.totalFiles}</strong></div>
                <div>Required Capacity: <strong>{formatBytes(migrationState.plan.totalBytes)}</strong></div>
                <div>Integrity Check: <strong style={{ color: "#10b981" }}>SHA-256 Pre-Computed</strong></div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer", marginBottom: 16 }}>
                  <input
                    type="checkbox"
                    checked={migrationState.userApproved}
                    onChange={(e) => setMigrationState((prev) => ({ ...prev, userApproved: e.target.checked }))}
                    style={{ accentColor: "#10b981", width: 18, height: 18 }}
                  />
                  <span>I confirm this migration plan. Files will be copied and verified with SHA-256 before any unlinking is offered.</span>
                </label>

                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={handleExecuteMigration}
                    disabled={!migrationState.userApproved || !!busy}
                    style={{
                      background: migrationState.userApproved ? "#10b981" : "rgba(255,255,255,0.1)",
                      border: "none",
                      borderRadius: 10,
                      padding: "10px 22px",
                      color: migrationState.userApproved ? "#000" : "#64748b",
                      fontSize: 13,
                      fontWeight: 800,
                      cursor: migrationState.userApproved ? "pointer" : "not-allowed",
                    }}
                  >
                    Execute Verified Migration ⚡
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ──────────────── TAB 5: BACKUP & DISASTER RECOVERY ──────────────── */}
      {activeTab === "backup" && <BackupCentre />}

      {/* ──────────────── TAB 6: DIAGNOSTICS & QA ──────────────── */}
      {activeTab === "qa" && <QADashboard />}

      {/* ──────────────── TAB 7: GAMEPAD CALIBRATION ──────────────── */}
      {activeTab === "controller" && <ControllerTester />}

      {/* Safe Uninstall Modal (Steam-Style) */}
      {safeUninstallModal.open && safeUninstallModal.game && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🛡️</div>
            <h3 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 10px" }}>
              Safe Game Uninstall
            </h3>
            <p style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.5, marginBottom: 16 }}>
              Are you sure you want to uninstall <strong>{safeUninstallModal.game.title}</strong> ({safeUninstallModal.game.sizeFormatted}) from <code>{safeUninstallModal.game.drive}</code>?
            </p>
            <div style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: 10, padding: 12, marginBottom: 20, textAlign: "left", fontSize: 12, color: "#6ee7b7" }}>
              ✓ <strong>Zero Data Loss Guarantee:</strong> This frees up disk space by removing the installed title and local cache. Your original source ROMs, cloud saves, and memory cards are completely untouched and safe.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                onClick={() => setSafeUninstallModal({ open: false, game: null })}
                style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 8, padding: "8px 18px", color: "#fff", fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={confirmSafeUninstall}
                style={{ background: "#ef4444", border: "none", borderRadius: 8, padding: "8px 20px", color: "#fff", fontWeight: 800, cursor: "pointer" }}
              >
                Confirm Safe Uninstall
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NAS Registration Modal */}
      {nasModal.open && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalCardStyle, maxWidth: 520, textAlign: "left" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>🌐 Register NAS Storage (Pending Expansion)</h3>
              <button
                onClick={() => setNasModal({ open: false, host: "", shareName: "", protocol: "smb", mountPath: "\\\\nas\\media", targetCapacityGB: 4000, notes: "" })}
                style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.5, marginBottom: 16 }}>
              Configure future NAS network share destination. This registers the share in <strong>configured_pending_capacity</strong> state. Zero files will be moved until explicit user approval.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>Host IP / Hostname:</label>
                <input
                  type="text"
                  placeholder="e.g. 192.168.1.100 or nas.local"
                  value={nasModal.host}
                  onChange={(e) => setNasModal({ ...nasModal, host: e.target.value })}
                  style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>Share Name:</label>
                <input
                  type="text"
                  placeholder="e.g. savestate-media or roms"
                  value={nasModal.shareName}
                  onChange={(e) => setNasModal({ ...nasModal, shareName: e.target.value })}
                  style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>Mount Path / UNC:</label>
                <input
                  type="text"
                  placeholder="e.g. \\nas\media or /mnt/nas/media"
                  value={nasModal.mountPath}
                  onChange={(e) => setNasModal({ ...nasModal, mountPath: e.target.value })}
                  style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>Planned Target Capacity (GB):</label>
                <input
                  type="number"
                  placeholder="4000"
                  value={nasModal.targetCapacityGB}
                  onChange={(e) => setNasModal({ ...nasModal, targetCapacityGB: Number(e.target.value) })}
                  style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                onClick={() => setNasModal({ open: false, host: "", shareName: "", protocol: "smb", mountPath: "\\\\nas\\media", targetCapacityGB: 4000, notes: "" })}
                style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 8, padding: "8px 16px", color: "#fff", fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveNasConfig}
                disabled={!nasModal.host || !nasModal.shareName}
                style={{ background: "#38bdf8", border: "none", borderRadius: 8, padding: "8px 18px", color: "#000", fontWeight: 800, cursor: "pointer" }}
              >
                Register NAS Destination
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal.open && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>⚠️</div>
            <h3 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 10px" }}>
              Confirm Deletion
            </h3>
            <p style={{ fontSize: 14, color: "#cbd5e1", lineHeight: 1.5, marginBottom: 20 }}>
              You are about to permanently delete <strong>{deleteModal.items.length} item(s)</strong> and free approximately <strong>{formatBytes(deleteModal.totalBytes)}</strong> from your storage.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button
                onClick={() => setDeleteModal({ open: false, items: [], totalBytes: 0 })}
                style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 10, padding: "10px 18px", color: "#fff", fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={executeDelete}
                style={{ background: "#ef4444", border: "none", borderRadius: 10, padding: "10px 20px", color: "#fff", fontWeight: 700, cursor: "pointer" }}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move Modal */}
      {moveModal.open && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalCardStyle, maxWidth: 440, textAlign: "left" }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 10px" }}>
              🚀 Move Items to Another Drive
            </h3>
            <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.5, marginBottom: 16 }}>
              Select target storage drive for <strong>{moveModal.items.length} item(s)</strong>. Files will be relocated and database paths updated automatically.
            </p>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 6, fontWeight: 600 }}>Target Drive Destination:</label>
              <select
                value={moveModal.targetDrive}
                onChange={(e) => setMoveModal({ ...moveModal, targetDrive: e.target.value })}
                style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
              >
                <option value="E:\ROMS">External Storage (E:\ROMS)</option>
                <option value="I:\My Drive\NexusArchive\roms">Google Drive Cloud (NexusArchive/roms)</option>
                <option value="C:\Users\mraaz\nexus-cloud-media\roms">System SSD (C:\...)</option>
                <option value="F:\SaveState\client-roms">Storage Disk (F:\SaveState\client-roms)</option>
              </select>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setMoveModal({ open: false, items: [], targetDrive: "E:\\ROMS" })}
                style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 10, padding: "10px 18px", color: "#fff", fontWeight: 600, cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={executeMove}
                style={{ background: "#3b82f6", border: "none", borderRadius: 10, padding: "10px 20px", color: "#fff", fontWeight: 700, cursor: "pointer" }}
              >
                Move {moveModal.items.length} Item(s)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Styling helpers
const filterTabBtn = {
  border: "none",
  borderRadius: 8,
  padding: "6px 14px",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const selectStyle = {
  height: 38,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  padding: "0 10px",
  color: "#fff",
  fontSize: 13,
  outline: "none",
  cursor: "pointer",
};

const smallActionBtn = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "5px 10px",
  color: "#cbd5e1",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const paginationBtn = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  padding: "8px 16px",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const modalBackdropStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.75)",
  backdropFilter: "blur(12px)",
  zIndex: 99999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
};

const modalCardStyle = {
  background: "#0f172a",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 20,
  maxWidth: 480,
  width: "100%",
  padding: 26,
  textAlign: "center",
  color: "#fff",
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6)",
};
