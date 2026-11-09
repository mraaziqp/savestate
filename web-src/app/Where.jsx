// "Where it plays" filter over the Games grid and hub: All Games,
// Play Together (Co-op Campaign, Split-Screen, Competitive Versus, Shared Screen),
// Browser Play, Local / PC Play, On Phones.
//
// Structured Evidence & Mode Classification:
// Local co-op, local versus, and split-screen are NEVER treated as interchangeable!
// GoldenEye 007: Single-Player + Competitive Split-Screen (NOT Co-op Campaign).
// Contra / Streets of Rage: Shared-Screen Co-Op Campaign (NOT Split-Screen).
// Street Fighter II / Tekken: Shared-Screen 1v1 Versus (NOT Split-Screen).

import React, { useState, useMemo, useEffect } from "react";
import { runsOn, playsHere, here } from "./devices.js";

const KEY = "nx_where";
const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

const CSS = `
.nxwhere{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
.nxwhere button{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:rgba(255,255,255,.8);border-radius:999px;padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;gap:7px;align-items:center;min-height:36px;transition:all .15s ease}
.nxwhere button:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.25)}
.nxwhere button[aria-pressed="true"]{border-color:rgba(34,211,238,.8);background:rgba(34,211,238,.16);color:#e6fbff;box-shadow:0 0 12px rgba(34,211,238,.2)}
.nxwhere button span{opacity:.65;font-weight:600;font-size:11.5px;background:rgba(255,255,255,.1);padding:1px 6px;border-radius:10px}
.nxwhere button[aria-pressed="true"] span{background:rgba(34,211,238,.25);color:#fff}
.nxwhere button[data-filter="splitscreen"][aria-pressed="true"],
.nxwhere button[data-filter="playtogether"][aria-pressed="true"]{border-color:rgba(192,132,252,.8);background:rgba(168,85,247,.2);color:#f5f3ff;box-shadow:0 0 14px rgba(168,85,247,.28)}
.nxwhere button[data-filter="splitscreen"][aria-pressed="true"] span,
.nxwhere button[data-filter="playtogether"][aria-pressed="true"] span{background:rgba(168,85,247,.35);color:#fff}
.nxwhere-banner{display:flex;flex-direction:column;gap:6px;padding:14px 18px;border-radius:16px;background:linear-gradient(135deg,rgba(34,211,238,.12),rgba(59,130,246,.08));border:1px solid rgba(34,211,238,.35);margin:0 0 16px}
.nxwhere-banner-tag{font-size:11.5px;font-weight:900;text-transform:uppercase;letter-spacing:.12em;color:#22d3ee;display:inline-flex;align-items:center;gap:6px}
.nxwhere-banner p{margin:0;font-size:13px;color:rgba(255,255,255,.85);line-height:1.45}
.nxwhere-split-banner{background:linear-gradient(135deg,rgba(168,85,247,.16),rgba(59,130,246,.10));border:1px solid rgba(168,85,247,.38);box-shadow:0 0 24px rgba(168,85,247,.1)}
.nxwhere-split-banner .nxwhere-banner-tag{color:#c084fc}
.nxwhere-subpills{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.nxwhere-subpill{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:rgba(255,255,255,.8);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:30px;transition:all .15s ease}
.nxwhere-subpill:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.24)}
.nxwhere-subpill[aria-pressed="true"]{border-color:rgba(192,132,252,.8);background:rgba(168,85,247,.26);color:#f5f3ff;box-shadow:0 0 10px rgba(168,85,247,.22)}
.nxwhere-subpill-count{opacity:.65;font-size:10.5px;font-weight:600;background:rgba(0,0,0,.25);padding:1px 5px;border-radius:8px}
.nxwhere-subpill[aria-pressed="true"] .nxwhere-subpill-count{background:rgba(168,85,247,.45);color:#fff}
.nxwhere-note{font-size:12.5px;color:rgba(255,255,255,.5);margin:-6px 0 12px}
.nxwhere-note button{all:unset;cursor:pointer;color:#67e8f9;text-decoration:underline}

/* Cover badges */
.nxs-multi{position:absolute;top:6px;right:6px;font-size:9.5px;font-weight:800;letter-spacing:.02em;padding:2px 7px;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.5);pointer-events:auto;cursor:pointer;backdrop-filter:blur(6px);transition:transform .12s ease}
.nxs-multi:hover{transform:scale(1.06)}
.nxs-multi-split{background:rgba(147,51,234,.85);color:#fff;border:1px solid rgba(192,132,252,.5)}
.nxs-multi-coop{background:rgba(16,185,129,.85);color:#fff;border:1px solid rgba(52,211,153,.5)}
.nxs-multi-versus{background:rgba(249,115,22,.85);color:#fff;border:1px solid rgba(251,146,60,.5)}
.nxs-multi-shared{background:rgba(59,130,246,.85);color:#fff;border:1px solid rgba(96,165,250,.5)}
.nxs-multi-hotseat{background:rgba(234,179,8,.85);color:#fff;border:1px solid rgba(250,204,21,.5)}

@media (max-width:640px){.nxwhere{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;margin:0 -4px 10px;padding:0 4px}.nxwhere::-webkit-scrollbar{display:none}.nxwhere button{flex:none}}
`;

/**
 * Multiplayer facts for a game, only as the server's classification states
 * them (server/multiplayer-classify.ts: evidence from LaunchBox, libretro and
 * curated per-console entries). There is no guessing from the title here any
 * more: "mario kart" in a name used to make a game "competitive split-screen".
 * A game the server has no evidence for shows nothing.
 */
const mpOf = (g) => (g && g.multiplayer && g.multiplayer.verificationStatus !== "UNKNOWN" ? g.multiplayer : null);
/** The server says so with evidence (not only "needs review"). */
const sure = (m) => !!m && (m.verificationStatus === "VERIFIED" || m.verificationStatus === "HIGH_CONFIDENCE");

/** Divided simultaneous viewports (GoldenEye 007 on N64). */
export function isSplitScreenGame(g) { const m = mpOf(g); return !!m && !!m.isSplitScreen; }

/** Players work together (Streets of Rage 2). GoldenEye 007 is not. */
export function isLocalCoopGame(g) { const m = mpOf(g); return !!m && !!m.isLocalCoop; }

/** The story can be played together (a curated fact; databases only say "cooperative"). */
export function hasCoopCampaign(g) { const m = mpOf(g); return !!m && !!m.hasCoopCampaign; }

/** Players compete locally (GoldenEye 007, Street Fighter II). */
export function isLocalCompetitiveGame(g) { const m = mpOf(g); return !!m && (!!m.isLocalCompetitive || !!m.isLocalVersus); }

/** One shared camera for everyone (Streets of Rage 2, Street Fighter II). */
export function isSharedScreenGame(g) { const m = mpOf(g); return !!m && !!m.isSharedScreen; }

/** Two or more people can play it, by the evidence. */
export function isPlayTogetherGame(g) {
  const m = mpOf(g);
  return !!m && (m.isLocalCoop || m.isLocalCompetitive || m.isLocalVersus || m.isSplitScreen || m.isSharedScreen || m.isHotSeat || (m.maxPlayers ?? 0) > 1);
}

/**
 * The badge for a game card: the server's own summary ("1–4 Players |
 * Competitive | Split-Screen"), so a card never says more than the evidence.
 * Single-player games and unknown ones get no badge.
 */
export function getMultiplayerBadge(g) {
  const m = mpOf(g);
  if (!m || !isPlayTogetherGame(g)) return null;
  const count = (m.maxPlayers ?? 0) > 1 ? `1–${m.maxPlayers}P` : "";
  const label = m.summary || (count ? `${count} | Mode not confirmed` : "");
  if (!label) return null;
  const type = !sure(m) ? "review" : m.isLocalCoop ? "coop" : m.isSplitScreen ? "split" : m.isLocalCompetitive || m.isLocalVersus ? "versus" : m.isHotSeat ? "hotseat" : "shared";
  const short = !sure(m) ? `${count || "Multi"} · unconfirmed`
    : m.isLocalCoop ? `${count} Co-op` : m.isSplitScreen ? `${count} Split-Screen` : m.isLocalCompetitive || m.isLocalVersus ? `${count} Versus` : m.isHotSeat ? `${count} Take Turns` : `${count} Players`;
  return { label, type, short: short.trim(), full: m.reviewReason && !sure(m) ? `${label} (${m.reviewReason})` : label };
}

export const PLAY_TOGETHER_SUBMODES = [
  { id: "all", label: "All Multiplayer", icon: "👥", filter: (g) => isPlayTogetherGame(g) },
  { id: "coop", label: "Local Co-op", icon: "🤝", filter: (g) => isLocalCoopGame(g) },
  { id: "versus", label: "Competitive & Versus", icon: "🥊", filter: (g) => isLocalCompetitiveGame(g) },
  { id: "splitscreen", label: "Split-Screen", icon: "🏁", filter: (g) => isSplitScreenGame(g) },
  { id: "shared", label: "Shared Screen", icon: "📺", filter: (g) => isSharedScreenGame(g) },
  { id: "hotseat", label: "Take Turns", icon: "🔁", filter: (g) => !!mpOf(g)?.isHotSeat },
  { id: "online", label: "Online", icon: "🌍", filter: (g) => !!mpOf(g)?.isOnlineMultiplayer },
  { id: "lan", label: "LAN", icon: "🔌", filter: (g) => !!mpOf(g)?.isLanMultiplayer },
  { id: "remote", label: "Remote Play Ready", icon: "🌐", filter: (g) => !!mpOf(g)?.isRemotePlayCompatible },
  { id: "fourplus", label: "4+ Players", icon: "🎮", filter: (g) => (mpOf(g)?.maxPlayers ?? 0) >= 4 },
  { id: "review", label: "Mode Not Confirmed", icon: "❔", filter: (g) => isPlayTogetherGame(g) && !sure(mpOf(g)) },
];

const HERE_NAME = { android: "This phone", ios: "This iPhone", windows: "This PC", linux: "This computer", computer: "This Mac" };
const TESTS = {
  here: (g) => playsHere(g.platform),
  phone: (g) => { const r = runsOn(g.platform); return r.browser || !!r.phone; },
  pc: (g) => runsOn(g.platform).pc,
  browser: (g) => runsOn(g.platform).browser,
  splitscreen: (g) => isPlayTogetherGame(g),
  playtogether: (g) => isPlayTogetherGame(g),
  all: () => true,
};

export function Where({ games, render }) {
  const d = here();
  const pcLike = d === "windows" || d === "linux";
  const options = pcLike
    ? [
        ["all", "🎮 All Games"],
        ["playtogether", "👥 Play Together"],
        ["browser", "🌐 Browser Play"],
        ["pc", "⚡ Local / PC Play"],
        ["phone", "📱 On Phones"]
      ]
    : [
        ["all", "🎮 All Games"],
        ["playtogether", "👥 Play Together"],
        ["browser", "🌐 Browser Play"],
        ["here", `📱 ${HERE_NAME[d]}`],
        ["pc", "⚡ Needs a PC"]
      ];

  const [pick, setPick] = useState(() => {
    const v = read();
    if (v === "splitscreen") return "playtogether";
    return options.some(([k]) => k === v) ? v : options[0][0];
  });
  const [subMode, setSubMode] = useState("all");

  useEffect(() => {
    window.__nxForceBrowserPlay = (pick === "browser");
    return () => { window.__nxForceBrowserPlay = false; };
  }, [pick]);

  useEffect(() => {
    const onWhere = (e) => {
      let target = e?.detail;
      if (target === "splitscreen") target = "playtogether";
      if (target && options.some(([k]) => k === target)) {
        choose(target);
      }
    };
    window.addEventListener("nexus:where", onWhere);
    return () => window.removeEventListener("nexus:where", onWhere);
  }, [options]);

  const list = Array.isArray(games) ? games : [];
  const counts = useMemo(() => {
    const c = {};
    for (const [k] of options) {
      c[k] = k === "all" ? list.length : list.filter(TESTS[k] ?? TESTS.all).length;
    }
    if (c.pc != null && !pcLike) c.pc = list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc).length;
    return c;
  }, [list, d, pcLike]);

  const shown = useMemo(() => {
    let base = pick === "all" ? list : list.filter(TESTS[pick] ?? TESTS.all);
    if (pick === "pc" && !pcLike) base = list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc);
    if ((pick === "playtogether" || pick === "splitscreen") && subMode !== "all") {
      const modeObj = PLAY_TOGETHER_SUBMODES.find((sm) => sm.id === subMode);
      if (modeObj?.filter) base = base.filter(modeObj.filter);
    }
    return base;
  }, [list, pick, subMode, d, pcLike]);

  const choose = (k) => { setPick(k); write(k); if (k !== "playtogether" && k !== "splitscreen") setSubMode("all"); };
  const hidden = list.length - shown.length;

  return (
    <>
      <style>{CSS}</style>
      {list.length > 0 && (
        <div className="nxwhere" role="group" aria-label="Game play mode and platform filters">
          {options.map(([k, label]) => (
            <button key={k} type="button" data-filter={k} aria-pressed={pick === k} onClick={() => choose(k)}>
              {label} <span>{(counts[k] ?? 0).toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
      {(pick === "playtogether" || pick === "splitscreen") && (
        <div className="nxwhere-banner nxwhere-split-banner">
          <div className="nxwhere-banner-tag">👥 Play Together Hub Active</div>
          <p>
            Experience authentic local multiplayer and co-op gaming. Unlike generic scanners, SaveState strictly separates
            <strong> Co-Op Campaigns</strong> (e.g. Contra, Halo), <strong>Competitive Split-Screen</strong> (e.g. GoldenEye 007, Mario Kart),
            and <strong>Shared-Screen Versus</strong> (e.g. Street Fighter II, Smash Bros).
          </p>
          <div className="nxwhere-subpills">
            {PLAY_TOGETHER_SUBMODES.map((sm) => {
              const count = sm.id === "all" 
                ? (counts.playtogether ?? counts.splitscreen ?? 0)
                : list.filter(TESTS.playtogether).filter(sm.filter).length;
              if (sm.id !== "all" && count === 0) return null;
              return (
                <button
                  key={sm.id}
                  type="button"
                  className="nxwhere-subpill"
                  aria-pressed={subMode === sm.id}
                  onClick={() => setSubMode(sm.id)}
                >
                  <span>{sm.icon}</span> {sm.label} <span className="nxwhere-subpill-count">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {pick === "browser" && (
        <div className="nxwhere-banner">
          <div className="nxwhere-banner-tag">🌐 Browser Play Active</div>
          <p>All games shown below launch directly inside your browser with cloud save sync and instant loading. No emulator install needed.</p>
        </div>
      )}
      {pick === "here" && hidden > 0 && (
        <p className="nxwhere-note">
          {hidden.toLocaleString()} more need a PC (or stream from the host). <button type="button" onClick={() => choose("all")}>Show them too</button>
        </p>
      )}
      {pick === "pc" && !pcLike && shown.length > 0 && (
        <p className="nxwhere-note">These don't run on {d === "android" ? "this phone" : d === "ios" ? "an iPhone" : "this computer"}: play them on a Windows PC, or open one and choose Stream from the host PC.</p>
      )}
      {render(shown)}
    </>
  );
}
