import React, { useState, useEffect } from "react";
import { SYSTEMS } from "./systems.js";
import { norm } from "./devices.js";
import { token } from "./lib.jsx";

// Every request signed in: without it the details call answered 401 and the
// window quietly showed the card's shorter data instead.
const authed = (extra = {}) => { const t = token(); return { ...extra, ...(t ? { Authorization: `Bearer ${t}` } : {}) }; };

const NAMES = Object.fromEntries(SYSTEMS.map((s) => [s.id, s.name]));
const sysName = (p) => NAMES[norm(p)] ?? String(p ?? "").toUpperCase();

export function PlayTogetherModal() {
  const [game, setGame] = useState(null);
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [adminMode, setAdminMode] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [remoteSession, setRemoteSession] = useState(null);
  const [remoteCopied, setRemoteCopied] = useState(false);

  useEffect(() => {
    const onOpen = (e) => {
      const g = e?.detail?.game;
      if (g) {
        setGame(g);
        setRemoteSession(null);
        setRemoteCopied(false);
        loadDetails(g.id);
      }
    };
    window.addEventListener("nexus:play-together-modal", onOpen);
    return () => window.removeEventListener("nexus:play-together-modal", onOpen);
  }, []);

  const loadDetails = async (id) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/multiplayer/details/${encodeURIComponent(id)}`, { headers: authed() });
      const data = await res.json();
      if (data.ok && data.details) {
        setDetails(data.details);
        setEditForm({ ...data.details });
      }
    } catch {
      // fallback to game.multiplayer if API fails
      if (game?.multiplayer) {
        setDetails(game.multiplayer);
        setEditForm({ ...game.multiplayer });
      }
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    setGame(null);
    setDetails(null);
    setAdminMode(false);
    setRemoteSession(null);
  };

  // Remote play starts from the game itself: Play, then its menu > Play on my phone or tablet.
  const startRemotePlay = () => { setRemoteSession("started"); };

  const copyRemoteLink = () => {
    if (!remoteSession) return;
    try {
      navigator.clipboard.writeText(remoteSession);
      setRemoteCopied(true);
      setTimeout(() => setRemoteCopied(false), 2500);
    } catch {
      /* fallback */
    }
  };

  const saveAdminOverride = async () => {
    if (!game || !editForm) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/multiplayer/override/${encodeURIComponent(game.id)}`, {
        method: "PUT",
        headers: authed({ "Content-Type": "application/json" }),
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (data.ok && data.details) {
        setDetails(data.details);
        setAdminMode(false);
      }
    } catch (err) {
      alert("Failed to save override: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!game) return null;

  const m = details || game.multiplayer || {};
  const maxP = m.max_players ?? m.maxPlayers ?? 1;
  const isCoop = m.has_coop_campaign ?? m.hasCoopCampaign ?? m.is_local_coop ?? m.isLocalCoop;
  const isSplit = m.is_split_screen ?? m.isSplitScreen;
  const isVersus = m.is_local_competitive ?? m.isLocalCompetitive ?? m.is_local_versus;
  const screenType = m.screen_type ?? m.screenType ?? "none";
  const status = m.verification_status ?? m.verificationStatus ?? "UNVERIFIED";
  const summary = m.gameplay_summary ?? m.summary ?? (maxP > 1 ? `${maxP} Players Supported` : "Player info not known yet");
  // Only VERIFIED or HIGH_CONFIDENCE answers are stated as facts; otherwise a
  // "no" is shown as "not confirmed" (the databases didn't say).
  const known = status === "VERIFIED" || status === "HIGH_CONFIDENCE";
  const no = (text) => (known ? text : "? Not confirmed");
  const reviewReason = m.review_reason ?? m.reviewReason ?? "";
  let claims = [];
  try { claims = JSON.parse(m.evidence_detail ?? "[]"); } catch { claims = []; }
  const remoteOk = m.is_remote_play_compatible ?? m.isRemotePlayCompatible;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in" onClick={close}>
      <div
        className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/40">
          <div className="flex items-center gap-3">
            <span className="text-xl">👥</span>
            <div>
              <h3 className="text-lg font-bold text-white leading-tight">{game.title}</h3>
              <span className="text-xs text-zinc-400 font-medium">{sysName(game.platform)} · Play Together Guide</span>
            </div>
          </div>
          <button
            type="button"
            className="w-8 h-8 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center transition-colors"
            onClick={close}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6">
          {/* Summary Banner */}
          <div className="p-4 rounded-xl bg-gradient-to-r from-purple-950/40 via-indigo-950/30 to-zinc-900 border border-purple-500/30 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider font-extrabold text-purple-400">Classified Gameplay Mode</div>
              <div className="text-base font-bold text-white mt-0.5">{summary}</div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`text-xs font-bold px-2.5 py-1 rounded-full border ${
                  status === "VERIFIED"
                    ? "bg-emerald-950/60 border-emerald-500/50 text-emerald-300"
                    : status === "HIGH_CONFIDENCE"
                    ? "bg-blue-950/60 border-blue-500/50 text-blue-300"
                    : "bg-amber-950/60 border-amber-500/50 text-amber-300"
                }`}
              >
                {status === "VERIFIED" ? "✓ Verified by an admin" : status === "HIGH_CONFIDENCE" ? "From game databases" : status === "UNKNOWN" ? "Not known yet" : "Needs review"}
              </span>
            </div>
          </div>

          {/* Mode Matrix Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className={`p-3 rounded-xl border ${m.is_single_player || m.isSinglePlayer ? "bg-zinc-800/80 border-zinc-700" : "bg-zinc-900/40 border-zinc-800/60 opacity-60"}`}>
              <div className="text-xs text-zinc-400">Story Campaign</div>
              <div className="text-sm font-bold text-white mt-1">
                {m.is_single_player || m.isSinglePlayer ? "✓ 1P Solo" : no("✕ None")}
              </div>
            </div>
            <div className={`p-3 rounded-xl border ${isCoop ? "bg-emerald-950/30 border-emerald-500/40" : "bg-zinc-900/40 border-zinc-800/60 opacity-60"}`}>
              <div className="text-xs text-zinc-400">Local Co-op</div>
              <div className="text-sm font-bold text-white mt-1">
                {isCoop ? `✓ Up to ${m.max_local_coop_players || maxP}P` : no("✕ No Co-op")}
              </div>
            </div>
            <div className={`p-3 rounded-xl border ${isSplit ? "bg-purple-950/30 border-purple-500/40" : "bg-zinc-900/40 border-zinc-800/60 opacity-60"}`}>
              <div className="text-xs text-zinc-400">Split-Screen</div>
              <div className="text-sm font-bold text-white mt-1">
                {isSplit ? `✓ ${m.max_split_screen_players || maxP} Viewports` : no("✕ No Split")}
              </div>
            </div>
            <div className={`p-3 rounded-xl border ${isVersus ? "bg-orange-950/30 border-orange-500/40" : "bg-zinc-900/40 border-zinc-800/60 opacity-60"}`}>
              <div className="text-xs text-zinc-400">Competitive / PvP</div>
              <div className="text-sm font-bold text-white mt-1">
                {isVersus ? `✓ Up to ${m.max_local_competitive_players || maxP}P` : no("✕ None")}
              </div>
            </div>
          </div>

          {/* Screen Layout & Controls Advice */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Presentation & Controllers</h4>
            <div className="p-4 rounded-xl bg-zinc-950/50 border border-zinc-800 text-sm text-zinc-300 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-zinc-400 font-medium">Screen Type:</span>
                <span className="font-semibold text-white capitalize">
                  {screenType === "split_screen"
                    ? "Simultaneous Split-Screen (Divided Viewports)"
                    : screenType === "shared_screen"
                    ? "Single Shared Camera Viewport"
                    : screenType === "turn_based"
                    ? "Turn-Based Alternating Turns (Hot-Seat)"
                    : "Single View"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-zinc-400 font-medium">Controllers Needed:</span>
                <span className="font-semibold text-white">
                  {maxP > 1 ? `One per player, up to ${maxP} (the keyboard can be player 1)` : maxP === 1 ? "1 controller or the keyboard" : "Not known yet"}
                </span>
              </div>
              {m.notes && <p className="text-xs text-zinc-400 italic pt-1">{m.notes}</p>}
            </div>
          </div>

          {/* Where this comes from */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Where this comes from</h4>
            <div className="p-4 rounded-xl bg-zinc-950/50 border border-zinc-800 text-xs text-zinc-300 space-y-1.5">
              {claims.length ? claims.map((c, i) => (
                <div key={i}><b className="text-zinc-200">{c.source}:</b> {c.says}{c.ref ? <span className="text-zinc-500"> ({c.ref})</span> : null}</div>
              )) : <div className="text-zinc-500">No game database lists this game for this console yet.</div>}
              {reviewReason && <div className="text-amber-300/90 pt-1">{reviewReason}</div>}
            </div>
          </div>

          {/* SaveState Remote Play Integration */}
          <div className="p-4 rounded-xl bg-gradient-to-br from-cyan-950/30 to-blue-950/30 border border-cyan-500/30 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <span>🌐</span> SaveState Remote Play Ready
                </h4>
                <p className="text-xs text-zinc-300 mt-0.5">
                  {remoteOk
                    ? "Start the game, open its menu (Esc or the menu button) and choose \"Play on my phone or tablet\". A friend opens the link or code on their device and plays as player 2. They need nothing installed."
                    : "Not offered for this game: SaveState only shares games it knows support more than one player."}
                </p>
              </div>
              {!remoteOk ? null : !remoteSession ? (
                <button
                  type="button"
                  className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-bold text-xs transition-colors shadow-lg shadow-cyan-500/20"
                  onClick={startRemotePlay}
                >
                  How to share it
                </button>
              ) : (
                <button
                  type="button"
                  className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-xs transition-colors"
                  onClick={copyRemoteLink}
                >
                  {"Press Play, then menu > Play on my phone or tablet"}
                </button>
              )}
            </div>

          </div>

          {/* Admin Override Section */}
          <div className="pt-2 border-t border-zinc-800">
            <button
              type="button"
              className="text-xs font-bold text-zinc-400 hover:text-white flex items-center gap-1.5 transition-colors"
              onClick={() => setAdminMode(!adminMode)}
            >
              <span>⚙️</span> {adminMode ? "Hide Admin Editor" : "Admin Classification Override"}
            </button>

            {adminMode && editForm && (
              <div className="mt-4 p-4 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-4 text-xs">
                <div className="font-bold text-zinc-300">Manual Classification Override & Verification</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={Boolean(editForm.has_coop_campaign)}
                      onChange={(e) => setEditForm({ ...editForm, has_coop_campaign: e.target.checked })}
                    />
                    Co-Op Campaign
                  </label>
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={Boolean(editForm.is_local_coop)}
                      onChange={(e) => setEditForm({ ...editForm, is_local_coop: e.target.checked })}
                    />
                    Local Co-Op
                  </label>
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={Boolean(editForm.is_split_screen)}
                      onChange={(e) => setEditForm({ ...editForm, is_split_screen: e.target.checked })}
                    />
                    Split-Screen
                  </label>
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={Boolean(editForm.is_local_competitive)}
                      onChange={(e) => setEditForm({ ...editForm, is_local_competitive: e.target.checked })}
                    />
                    Competitive
                  </label>
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={Boolean(editForm.is_shared_screen)}
                      onChange={(e) => setEditForm({ ...editForm, is_shared_screen: e.target.checked })}
                    />
                    Shared Screen
                  </label>
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={Boolean(editForm.is_hot_seat)}
                      onChange={(e) => setEditForm({ ...editForm, is_hot_seat: e.target.checked })}
                    />
                    Hot-Seat (Alternating)
                  </label>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <span className="text-zinc-400 block mb-1">Max Players</span>
                    <input
                      type="number"
                      min="1"
                      max="16"
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-white"
                      value={editForm.max_players || 1}
                      onChange={(e) => setEditForm({ ...editForm, max_players: parseInt(e.target.value, 10) || 1 })}
                    />
                  </div>
                  <div>
                    <span className="text-zinc-400 block mb-1">Screen Type</span>
                    <select
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-white"
                      value={editForm.screen_type || "none"}
                      onChange={(e) => setEditForm({ ...editForm, screen_type: e.target.value })}
                    >
                      <option value="none">None / 1P</option>
                      <option value="split_screen">Split-Screen</option>
                      <option value="shared_screen">Shared Screen</option>
                      <option value="turn_based">Turn-Based</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <span className="text-zinc-400 block mb-1">Summary</span>
                    <input
                      type="text"
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-white"
                      value={editForm.gameplay_summary || ""}
                      onChange={(e) => setEditForm({ ...editForm, gameplay_summary: e.target.value })}
                      placeholder="e.g. 1P Story | 2–4P Split-Screen Deathmatch"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold"
                    onClick={() => setAdminMode(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold disabled:opacity-50"
                    disabled={saving}
                    onClick={saveAdminOverride}
                  >
                    {saving ? "Saving…" : "Save & Mark Verified"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
