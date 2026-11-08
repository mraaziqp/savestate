import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useStyles, api, goTab, Note } from "./lib.jsx";

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
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  // Filters
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

  // Delete modal state
  const [deleteModal, setDeleteModal] = useState({ open: false, items: [], totalBytes: 0 });

  // Move modal state (supports both single and bulk moves)
  const [moveModal, setMoveModal] = useState({ open: false, items: [], targetDrive: "E:\\ROMS" });

  // Load storage summary
  const loadSummary = useCallback(async () => {
    try {
      const data = await api("/api/library/storage-summary");
      setSummary(data);
    } catch (err) {
      console.error("Storage summary error:", err);
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
  }, [loadSummary]);

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

  // Compute selected items info
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
      await api("/api/library/delete", { method: "POST", body: payload });
      setDeleteModal({ open: false, items: [], totalBytes: 0 });
      setSelectedIds(new Set());
      await Promise.all([loadSummary(), loadItems()]);
    } catch (err) {
      setError(err?.message || "Failed to delete items.");
    } finally {
      setBusy("");
    }
  };

  // Execute move
  const executeMove = async () => {
    if (!moveModal.items.length) return;
    setBusy(`Moving ${moveModal.items.length} item(s) to ${moveModal.targetDrive}...`);
    setError("");
    try {
      await api("/api/library/move", {
        method: "POST",
        body: {
          items: moveModal.items.map((i) => ({ id: i.id, type: i.type })),
          targetDrive: moveModal.targetDrive,
        },
      });
      setMoveModal({ open: false, items: [], targetDrive: "E:\\ROMS" });
      setSelectedIds(new Set());
      await Promise.all([loadSummary(), loadItems()]);
    } catch (err) {
      setError(err?.message || "Failed to move items.");
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

  // Drive card click: toggle filter
  const handleDriveCardClick = (driveKey) => {
    setDriveFilter((prev) => (prev === driveKey ? "all" : driveKey));
    setOffset(0);
  };

  return (
    <div style={{
      maxWidth: 1140,
      margin: "0 auto",
      padding: "24px 20px 100px",
      color: "#f8fafc",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* Top Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 28 }}>💾</span>
            <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>
              Installed Library & Storage
            </h1>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "#94a3b8" }}>
            Inspect physical SSDs and Google Drive cloud space, move titles between drives, and reclaim disk space.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={() => { loadSummary(); loadItems(); }}
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
        borderRadius: 14,
        padding: "14px 16px",
        marginBottom: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}>
        {/* Row 1: Search & Type Tabs */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          {/* Type selector */}
          <div style={{ display: "flex", background: "rgba(255,255,255,0.06)", borderRadius: 10, padding: 3, gap: 3 }}>
            <button
              onClick={() => { setTypeFilter("all"); setOffset(0); }}
              style={{ ...filterTabBtn, background: typeFilter === "all" ? "#3b82f6" : "transparent" }}
            >
              All Items ({totalItems})
            </button>
            <button
              onClick={() => { setTypeFilter("games"); setOffset(0); }}
              style={{ ...filterTabBtn, background: typeFilter === "games" ? "#3b82f6" : "transparent" }}
            >
              🎮 Games ({summary?.stats?.games?.count ?? 0})
            </button>
            <button
              onClick={() => { setTypeFilter("media"); setOffset(0); }}
              style={{ ...filterTabBtn, background: typeFilter === "media" ? "#3b82f6" : "transparent" }}
            >
              🎬 Media ({summary?.stats?.media?.count ?? 0})
            </button>
          </div>

          {/* Search Input */}
          <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
            <input
              type="text"
              placeholder="Search titles, games, platforms or paths..."
              value={searchInput}
              onChange={(e) => { setSearchInput(e.target.value); setOffset(0); }}
              style={{
                width: "100%",
                height: 38,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 10,
                padding: "0 34px 0 14px",
                color: "#fff",
                fontSize: 13,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput("")}
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: "none",
                  color: "#94a3b8",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Sort selector */}
          <select
            value={sort}
            onChange={(e) => { setSort(e.target.value); setOffset(0); }}
            style={selectStyle}
          >
            <option value="size_desc">Largest Size First</option>
            <option value="size_asc">Smallest Size First</option>
            <option value="title_asc">Title (A - Z)</option>
            <option value="date_desc">Recently Added</option>
          </select>
        </div>

        {/* Row 2: Quick Preset Filter Chips */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" }}>Quick Presets:</span>
          
          <button
            onClick={() => { setDriveFilter("all"); setTypeFilter("all"); setSort("size_desc"); setOffset(0); }}
            style={{ ...presetChipStyle, background: driveFilter === "all" && typeFilter === "all" ? "rgba(59,130,246,0.25)" : "rgba(255,255,255,0.05)" }}
          >
            ✨ Default
          </button>
          
          <button
            onClick={() => { setDriveFilter("I:"); setOffset(0); }}
            style={{ ...presetChipStyle, background: driveFilter === "I:" ? "rgba(56,189,248,0.25)" : "rgba(255,255,255,0.05)", color: driveFilter === "I:" ? "#38bdf8" : "#cbd5e1" }}
          >
            ☁️ Cloud Storage Only
          </button>

          <button
            onClick={() => { setDriveFilter("E:"); setOffset(0); }}
            style={{ ...presetChipStyle, background: driveFilter === "E:" ? "rgba(16,185,129,0.25)" : "rgba(255,255,255,0.05)", color: driveFilter === "E:" ? "#34d399" : "#cbd5e1" }}
          >
            💾 External E: Only
          </button>

          <button
            onClick={() => { setDriveFilter("C:"); setOffset(0); }}
            style={{ ...presetChipStyle, background: driveFilter === "C:" ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.05)", color: driveFilter === "C:" ? "#c084fc" : "#cbd5e1" }}
          >
            ⚡ SSD C: Only
          </button>

          <button
            onClick={() => { setSort("size_desc"); setOffset(0); }}
            style={{ ...presetChipStyle, background: sort === "size_desc" ? "rgba(245,158,11,0.25)" : "rgba(255,255,255,0.05)", color: sort === "size_desc" ? "#fbbf24" : "#cbd5e1" }}
          >
            🐘 Heavy Files (&gt; 4 GB)
          </button>
        </div>
      </div>

      {/* Items Table Container */}
      <div style={{
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,
        overflow: "hidden",
      }}>
        {/* Table Header */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "36px 68px 1fr 110px 130px 170px",
          padding: "12px 16px",
          background: "rgba(255,255,255,0.04)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "#94a3b8",
          alignItems: "center",
        }}>
          <div>
            <input
              type="checkbox"
              checked={selectedIds.size > 0 && selectedIds.size === items.length}
              onChange={selectAllCurrent}
              style={{ cursor: "pointer" }}
            />
          </div>
          <div>Category</div>
          <div>Title & Path</div>
          <div>Size</div>
          <div>Storage Drive</div>
          <div style={{ textAlign: "right" }}>Actions</div>
        </div>

        {/* Loading State */}
        {loading && (
          <div style={{ padding: "50px 0", textAlign: "center", color: "#94a3b8", fontSize: 14 }}>
            ⏳ Loading library items...
          </div>
        )}

        {/* Empty State */}
        {!loading && items.length === 0 && (
          <div style={{ padding: "60px 0", textAlign: "center", color: "#64748b" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>No matching items found</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Try clearing the drive filter or search term.</div>
          </div>
        )}

        {/* Rows */}
        {!loading && items.map((item) => {
          const isSelected = selectedIds.has(item.id);
          const isDriveCloud = item.isCloud || item.drive === "Google Drive" || item.drive === "I:";
          return (
            <div
              key={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "36px 68px 1fr 110px 130px 170px",
                padding: "12px 16px",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
                background: isSelected ? "rgba(59, 130, 246, 0.15)" : "transparent",
                alignItems: "center",
                fontSize: 13,
                transition: "background 0.12s ease",
              }}
            >
              {/* Checkbox */}
              <div>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(item.id)}
                  style={{ cursor: "pointer" }}
                />
              </div>

              {/* Type / Platform Badge */}
              <div>
                <span style={{
                  padding: "3px 7px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  background: item.type === "game" ? "rgba(168, 85, 247, 0.2)" : "rgba(34, 197, 94, 0.2)",
                  color: item.type === "game" ? "#c084fc" : "#4ade80",
                }}>
                  {item.platform || item.category || item.type}
                </span>
              </div>

              {/* Title & Path */}
              <div style={{ minWidth: 0, paddingRight: 14 }}>
                <div style={{ fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace" }}>
                  {item.path}
                </div>
              </div>

              {/* Size */}
              <div style={{ fontWeight: 700, color: "#38bdf8" }}>
                {item.sizeFormatted}
              </div>

              {/* Storage Location Badge */}
              <div>
                <span style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 8px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  background: isDriveCloud
                    ? "rgba(56, 189, 248, 0.15)"
                    : item.drive === "E:"
                    ? "rgba(16, 185, 129, 0.15)"
                    : item.drive === "C:"
                    ? "rgba(168, 85, 247, 0.15)"
                    : "rgba(245, 158, 11, 0.15)",
                  color: isDriveCloud
                    ? "#38bdf8"
                    : item.drive === "E:"
                    ? "#34d399"
                    : item.drive === "C:"
                    ? "#c084fc"
                    : "#fbbf24",
                }}>
                  <span>{isDriveCloud ? "☁️" : "💾"}</span>
                  <span>{item.drive}</span>
                </span>
              </div>

              {/* Quick Action Buttons */}
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button
                  onClick={() => handleLaunchOrPlay(item)}
                  style={{
                    ...smallActionBtn,
                    background: "rgba(59, 130, 246, 0.2)",
                    color: "#60a5fa",
                    borderColor: "rgba(59, 130, 246, 0.4)",
                  }}
                  title={item.type === "game" ? "Launch Game" : "Watch Media"}
                >
                  {item.type === "game" ? "🎮 Launch" : "▶ Play"}
                </button>

                <button
                  onClick={() => promptMoveSingle(item)}
                  style={smallActionBtn}
                  title="Move to another drive"
                >
                  📦 Move
                </button>

                <button
                  onClick={() => promptDeleteSingle(item)}
                  style={{ ...smallActionBtn, color: "#f87171" }}
                  title="Delete file permanently"
                >
                  🗑️
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination Footer */}
      {totalItems > limit && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
          <div style={{ fontSize: 13, color: "#94a3b8" }}>
            Showing {offset + 1}–{Math.min(offset + limit, totalItems)} of {totalItems} items
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setOffset((o) => Math.max(0, o - limit))}
              disabled={offset === 0}
              style={{ ...paginationBtn, opacity: offset === 0 ? 0.4 : 1, cursor: offset === 0 ? "default" : "pointer" }}
            >
              ← Previous Page
            </button>
            <button
              onClick={() => setOffset((o) => o + limit)}
              disabled={offset + limit >= totalItems}
              style={{ ...paginationBtn, opacity: offset + limit >= totalItems ? 0.4 : 1, cursor: offset + limit >= totalItems ? "default" : "pointer" }}
            >
              Next Page →
            </button>
          </div>
        </div>
      )}

      {/* Floating Selection Bottom Action Dock */}
      {selectedIds.size > 0 && (
        <div style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(15, 23, 42, 0.95)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(56, 189, 248, 0.4)",
          borderRadius: 20,
          boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          zIndex: 8999,
          color: "#fff",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>✓</span>
            <span style={{ fontWeight: 700, fontSize: 14 }}>
              {selectedIds.size} selected
            </span>
            <span style={{ color: "#38bdf8", fontWeight: 700, fontSize: 14 }}>
              ({formatBytes(selectedTotalBytes)})
            </span>
          </div>

          <div style={{ height: 24, width: 1, background: "rgba(255,255,255,0.15)" }} />

          <button
            onClick={promptMoveSelected}
            style={{
              background: "#3b82f6",
              border: "none",
              borderRadius: 10,
              padding: "8px 16px",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            📦 Move Selected ({selectedIds.size})
          </button>

          <button
            onClick={promptDeleteSelected}
            style={{
              background: "#ef4444",
              border: "none",
              borderRadius: 10,
              padding: "8px 16px",
              color: "#fff",
              fontWeight: 700,
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            🗑️ Delete & Free Space
          </button>

          <button
            onClick={() => setSelectedIds(new Set())}
            style={{
              background: "rgba(255,255,255,0.1)",
              border: "none",
              borderRadius: 10,
              padding: "8px 12px",
              color: "#cbd5e1",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            ✕ Clear
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal.open && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px", color: "#f87171" }}>
              Delete {deleteModal.items.length} Item(s)?
            </h2>
            <p style={{ fontSize: 14, color: "#94a3b8", margin: "0 0 16px" }}>
              This will permanently delete the selected files from storage and reclaim <strong>{formatBytes(deleteModal.totalBytes)}</strong>.
            </p>

            <div style={{
              maxHeight: 160,
              overflowY: "auto",
              background: "rgba(0,0,0,0.3)",
              borderRadius: 8,
              padding: 10,
              textAlign: "left",
              marginBottom: 20,
              fontSize: 12,
              fontFamily: "monospace",
              color: "#cbd5e1",
            }}>
              {deleteModal.items.map((i) => (
                <div key={i.id} style={{ marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  • {i.title} ({i.sizeFormatted})
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setDeleteModal({ open: false, items: [], totalBytes: 0 })}
                style={{
                  background: "rgba(255,255,255,0.1)",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 18px",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={executeDelete}
                style={{
                  background: "#ef4444",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 20px",
                  color: "#fff",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Yes, Delete & Reclaim Space
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move Confirmation Modal (Single or Bulk) */}
      {moveModal.open && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🚚</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>
              Move {moveModal.items.length} Item(s)
            </h2>
            <p style={{ fontSize: 14, color: "#94a3b8", margin: "0 0 16px" }}>
              Relocate {moveModal.items.length === 1 ? `"${moveModal.items[0]?.title}"` : `${moveModal.items.length} selected items`} to another storage drive. Database paths update automatically.
            </p>

            <div style={{ textAlign: "left", marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", display: "block", marginBottom: 6 }}>
                Target Storage Drive:
              </label>
              <select
                value={moveModal.targetDrive}
                onChange={(e) => setMoveModal((s) => ({ ...s, targetDrive: e.target.value }))}
                style={{ ...selectStyle, width: "100%", height: 42 }}
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
                style={{
                  background: "rgba(255,255,255,0.1)",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 18px",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={executeMove}
                style={{
                  background: "#3b82f6",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 20px",
                  color: "#fff",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
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

const presetChipStyle = {
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 20,
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.15s ease",
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
