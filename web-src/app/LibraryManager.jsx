import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useStyles, api, Note } from "./lib.jsx";

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return "0 B";
  const b = Math.max(0, bytes);
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
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
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("size_desc");
  const [offset, setOffset] = useState(0);
  const limit = 50;

  // Selected items: Set of item IDs
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Delete modal state
  const [deleteModal, setDeleteModal] = useState({ open: false, items: [], totalBytes: 0 });

  // Move modal state
  const [moveModal, setMoveModal] = useState({ open: false, item: null, targetDrive: "E:\\ROMS" });

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

  // Open delete dialog for selected items
  const promptDeleteSelected = () => {
    if (selectedItemsList.length === 0) return;
    setDeleteModal({
      open: true,
      items: selectedItemsList,
      totalBytes: selectedTotalBytes,
    });
  };

  // Open delete dialog for single item
  const promptDeleteSingle = (item) => {
    setDeleteModal({
      open: true,
      items: [item],
      totalBytes: item.size || 0,
    });
  };

  // Execute deletion
  const executeDelete = async () => {
    if (!deleteModal.items.length) return;
    setBusy("Deleting items and reclaiming storage space...");
    setError("");
    try {
      const payload = {
        items: deleteModal.items.map((i) => ({ id: i.id, type: i.type })),
      };
      const res = await api("/api/library/delete", { method: "POST", body: payload });
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
    if (!moveModal.item) return;
    setBusy(`Moving ${moveModal.item.title} to ${moveModal.targetDrive}...`);
    setError("");
    try {
      await api("/api/library/move", {
        method: "POST",
        body: { id: moveModal.item.id, type: moveModal.item.type, targetDrive: moveModal.targetDrive },
      });
      setMoveModal({ open: false, item: null, targetDrive: "E:\\ROMS" });
      await Promise.all([loadSummary(), loadItems()]);
    } catch (err) {
      setError(err?.message || "Failed to move item.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div style={{
      maxWidth: 1100,
      margin: "0 auto",
      padding: "24px 20px 80px",
      color: "#f8fafc",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 6px", letterSpacing: -0.5 }}>
            Installed Library Manager
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: "#94a3b8" }}>
            Inspect disk space, move ROMs and media between drives, and reclaim storage.
          </p>
        </div>

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
          }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* Busy or Error Banner */}
      {busy && (
        <div style={{ background: "rgba(59, 130, 246, 0.2)", border: "1px solid #3b82f6", color: "#93c5fd", padding: "12px 16px", borderRadius: 10, marginBottom: 20, fontSize: 14, fontWeight: 600 }}>
          ⏳ {busy}
        </div>
      )}
      {error && (
        <div style={{ background: "rgba(239, 68, 68, 0.2)", border: "1px solid #ef4444", color: "#fca5a5", padding: "12px 16px", borderRadius: 10, marginBottom: 20, fontSize: 14, fontWeight: 600 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Storage Dashboard: Drive Capacity Cards */}
      {summary?.drives && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14, marginBottom: 24 }}>
          {summary.drives.map((d) => (
            <div
              key={d.drive}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 14,
                padding: "16px 18px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{d.label}</span>
                <span style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace" }}>{d.drive}</span>
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
                <span>Total: {d.totalFormatted}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filter and Control Bar */}
      <div style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,
        padding: "14px 18px",
        marginBottom: 20,
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        {/* Type selector */}
        <div style={{ display: "flex", background: "rgba(255,255,255,0.06)", borderRadius: 10, padding: 3, gap: 3 }}>
          <button
            onClick={() => { setTypeFilter("all"); setOffset(0); }}
            style={{ ...filterTabBtn, background: typeFilter === "all" ? "#3b82f6" : "transparent" }}
          >
            All Items
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

        {/* Drive selector */}
        <select
          value={driveFilter}
          onChange={(e) => { setDriveFilter(e.target.value); setOffset(0); }}
          style={selectStyle}
        >
          <option value="all">All Storage Drives</option>
          <option value="E:">Drive E: (Local ROMs)</option>
          <option value="C:">Drive C: (Local SSD)</option>
          <option value="I:">Google Drive (Cloud I:)</option>
        </select>

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

        {/* Search */}
        <input
          type="text"
          placeholder="Filter by title or file path..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          style={{
            height: 36,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            padding: "0 12px",
            color: "#fff",
            fontSize: 13,
            outline: "none",
            minWidth: 200,
            flex: 1,
          }}
        />
      </div>

      {/* Items Table */}
      <div style={{
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,
        overflow: "hidden",
      }}>
        {/* Table Header */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "40px 60px 1fr 120px 140px 140px",
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
          <div>Type</div>
          <div>Title & Path</div>
          <div>File Size</div>
          <div>Location</div>
          <div style={{ textAlign: "right" }}>Actions</div>
        </div>

        {/* Loading Spinner */}
        {loading && (
          <div style={{ padding: "40px 0", textAlign: "center", color: "#94a3b8", fontSize: 14 }}>
            ⏳ Loading library items...
          </div>
        )}

        {/* Empty State */}
        {!loading && items.length === 0 && (
          <div style={{ padding: "50px 0", textAlign: "center", color: "#64748b" }}>
            No items matched your current filter.
          </div>
        )}

        {/* Rows */}
        {!loading && items.map((item) => {
          const isSelected = selectedIds.has(item.id);
          return (
            <div
              key={item.id}
              style={{
                display: "grid",
                gridTemplateColumns: "40px 60px 1fr 120px 140px 140px",
                padding: "12px 16px",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
                background: isSelected ? "rgba(59, 130, 246, 0.12)" : "transparent",
                alignItems: "center",
                fontSize: 13,
                transition: "background 0.15s ease",
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

              {/* Type Badge */}
              <div>
                <span style={{
                  padding: "2px 6px",
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
              <div style={{ minWidth: 0, paddingRight: 12 }}>
                <div style={{ fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace" }}>
                  {item.path}
                </div>
              </div>

              {/* File Size */}
              <div style={{ fontWeight: 700, color: "#38bdf8" }}>
                {item.sizeFormatted}
              </div>

              {/* Storage Location */}
              <div>
                <span style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 6,
                  background: item.isCloud ? "rgba(59, 130, 246, 0.2)" : "rgba(255,255,255,0.08)",
                  color: item.isCloud ? "#60a5fa" : "#cbd5e1",
                  fontWeight: 600,
                }}>
                  {item.isCloud ? "☁️ Google Drive" : `💾 ${item.drive}`}
                </span>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                {item.type === "game" && (
                  <button
                    onClick={() => setMoveModal({ open: true, item, targetDrive: item.drive.startsWith("E") ? "I:\\My Drive\\NexusArchive\\roms" : "E:\\ROMS" })}
                    style={smallActionBtn}
                    title="Move ROM across drives"
                  >
                    🚚 Move
                  </button>
                )}
                <button
                  onClick={() => promptDeleteSingle(item)}
                  style={{ ...smallActionBtn, color: "#f87171" }}
                  title="Permanently delete from disk"
                >
                  🗑️ Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, fontSize: 13, color: "#94a3b8" }}>
        <div>
          Showing {items.length > 0 ? offset + 1 : 0} to {Math.min(totalItems, offset + items.length)} of {totalItems} items
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setOffset((o) => Math.max(0, o - limit))}
            disabled={offset === 0}
            style={{ ...paginationBtn, opacity: offset === 0 ? 0.4 : 1 }}
          >
            ◀ Previous
          </button>
          <button
            onClick={() => setOffset((o) => o + limit)}
            disabled={offset + limit >= totalItems}
            style={{ ...paginationBtn, opacity: offset + limit >= totalItems ? 0.4 : 1 }}
          >
            Next ▶
          </button>
        </div>
      </div>

      {/* Floating Batch Action Bar (Appears when items are selected) */}
      {selectedIds.size > 0 && (
        <div style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(15, 23, 42, 0.95)",
          backdropFilter: "blur(16px)",
          border: "1px solid rgba(255, 255, 255, 0.2)",
          borderRadius: 16,
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          gap: 20,
          boxShadow: "0 10px 30px rgba(0, 0, 0, 0.6)",
          zIndex: 9000,
        }}>
          <div>
            <strong style={{ color: "#fff" }}>{selectedIds.size}</strong> items selected
            <span style={{ color: "#38bdf8", marginLeft: 8, fontWeight: 700 }}>
              ({formatBytes(selectedTotalBytes)})
            </span>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setSelectedIds(new Set())}
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                color: "#cbd5e1",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Deselect All
            </button>

            <button
              onClick={promptDeleteSelected}
              style={{
                background: "#ef4444",
                border: "none",
                borderRadius: 8,
                padding: "8px 16px",
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              🗑️ Delete Selected (Reclaim {formatBytes(selectedTotalBytes)})
            </button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal.open && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🗑️</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px", color: "#ef4444" }}>
              Permanently Delete Items?
            </h2>
            <p style={{ fontSize: 14, color: "#cbd5e1", margin: "0 0 16px" }}>
              Are you sure you want to permanently delete <strong>{deleteModal.items.length}</strong> file(s)?
              This will remove the physical ROM/media files from disk and clean up the library records.
            </p>

            <div style={{
              background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              borderRadius: 10,
              padding: "12px 16px",
              marginBottom: 20,
              fontSize: 14,
              color: "#fca5a5",
              textAlign: "left",
            }}>
              <div>⚡ <strong>Space to be reclaimed:</strong> {formatBytes(deleteModal.totalBytes)}</div>
              <div style={{ fontSize: 12, marginTop: 4, color: "#f87171" }}>
                This action cannot be undone.
              </div>
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

      {/* Move Modal */}
      {moveModal.open && moveModal.item && (
        <div style={modalBackdropStyle}>
          <div style={modalCardStyle}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🚚</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>
              Move {moveModal.item.title}
            </h2>
            <p style={{ fontSize: 14, color: "#94a3b8", margin: "0 0 16px" }}>
              Relocate this ROM file to another storage root. The database relative path will update automatically.
            </p>

            <div style={{ textAlign: "left", marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", display: "block", marginBottom: 6 }}>
                Target Storage Root:
              </label>
              <select
                value={moveModal.targetDrive}
                onChange={(e) => setMoveModal((s) => ({ ...s, targetDrive: e.target.value }))}
                style={{ ...selectStyle, width: "100%", height: 42 }}
              >
                <option value="E:\ROMS">Drive E: (Local ROMs: E:\ROMS)</option>
                <option value="I:\My Drive\NexusArchive\roms">Google Drive (Cloud: NexusArchive/roms)</option>
                <option value="F:\SaveState\client-roms">Drive F: (Client ROMs)</option>
              </select>
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setMoveModal({ open: false, item: null, targetDrive: "E:\\ROMS" })}
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
                Move File
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
  height: 36,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "0 10px",
  color: "#fff",
  fontSize: 13,
  outline: "none",
  cursor: "pointer",
};

const smallActionBtn = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  padding: "4px 8px",
  color: "#cbd5e1",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const paginationBtn = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "6px 14px",
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
  borderRadius: 18,
  maxWidth: 460,
  width: "100%",
  padding: 24,
  textAlign: "center",
  color: "#fff",
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.6)",
};
