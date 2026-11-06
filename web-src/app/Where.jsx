// "Where it plays" filter over the Games grid and hub: All Games,
// Split-Screen & Local Multiplayer, Browser Play, Local / PC Play, On Phones.
// When "Browser Play" is selected, games launch directly in the browser
// via EmulatorJS without native emulator dependencies.
// When "Split-Screen" is selected, it isolates games supporting local couch
// multiplayer (2-4 players, split-screen racing/shooters, co-op beat 'em ups, versus).
//
// The shell wraps its game lists in it (build.mjs 3n):
//   <NxWhere games={list} render={(shown) => <Grid games={shown} />} />
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
.nxwhere button[data-filter="splitscreen"][aria-pressed="true"]{border-color:rgba(192,132,252,.8);background:rgba(168,85,247,.2);color:#f5f3ff;box-shadow:0 0 14px rgba(168,85,247,.28)}
.nxwhere button[data-filter="splitscreen"][aria-pressed="true"] span{background:rgba(168,85,247,.35);color:#fff}
.nxwhere-banner{display:flex;flex-direction:column;gap:6px;padding:12px 16px;border-radius:14px;background:linear-gradient(135deg,rgba(34,211,238,.12),rgba(59,130,246,.08));border:1px solid rgba(34,211,238,.35);margin:0 0 16px}
.nxwhere-banner-tag{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.12em;color:#22d3ee;display:inline-flex;align-items:center;gap:6px}
.nxwhere-banner p{margin:0;font-size:13px;color:rgba(255,255,255,.85);line-height:1.45}
.nxwhere-split-banner{background:linear-gradient(135deg,rgba(168,85,247,.16),rgba(59,130,246,.10));border:1px solid rgba(168,85,247,.38);box-shadow:0 0 24px rgba(168,85,247,.1)}
.nxwhere-split-banner .nxwhere-banner-tag{color:#c084fc}
.nxwhere-subpills{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.nxwhere-subpill{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:rgba(255,255,255,.8);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:30px;transition:all .15s ease}
.nxwhere-subpill:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.24)}
.nxwhere-subpill[aria-pressed="true"]{border-color:rgba(192,132,252,.8);background:rgba(168,85,247,.26);color:#f5f3ff;box-shadow:0 0 10px rgba(168,85,247,.22)}
.nxwhere-subpill-count{opacity:.65;font-size:10.5px;font-weight:600;background:rgba(0,0,0,.25);padding:1px 5px;border-radius:8px}
.nxwhere-subpill[aria-pressed="true"] .nxwhere-subpill-count{background:rgba(168,85,247,.45);color:#fff}
.nxwhere-note{font-size:12.5px;color:rgba(255,255,255,.5);margin:-6px 0 12px}
.nxwhere-note button{all:unset;cursor:pointer;color:#67e8f9;text-decoration:underline}
@media (max-width:640px){.nxwhere{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;margin:0 -4px 10px;padding:0 4px}.nxwhere::-webkit-scrollbar{display:none}.nxwhere button{flex:none}}
`;

export const SPLITSCREEN_KEYWORDS = [
  'mario kart', 'crash team', 'ctr', 'diddy kong', 'gran turismo', 'burnout',
  'need for speed', 'f-zero', 'wipeout', 'ridge racer', 'micro machines', 'sonic riders',
  'chocobo racing', 'blur', 'split/second', 'outrun', 'road rash', 'top gear', 'hydro thunder',
  'wave race', 'excitebike', 'rock n roll racing', 're-volt', 'destruction derby', 'flatout',
  'goldeneye', 'perfect dark', 'timesplitters', 'halo', 'battlefront', 'quake',
  'unreal', 'doom', 'duke nukem', 'medal of honor', 'turok', 'serious sam', 'red faction',
  'contra', 'metal slug', 'streets of rage', 'final fight', 'double dragon', 'turtles',
  'tmnt', 'golden axe', 'battletoads', 'sunset riders', 'gunstar', 'cadillacs and dinosaurs',
  'captain commando', 'punisher', 'x-men', 'alien vs predator', 'river city', 'simpsons',
  'super smash', 'smash bros', 'street fighter', 'tekken', 'mortal kombat', 'soulcalibur',
  'virtua fighter', 'dead or alive', 'bloody roar', 'marvel vs', 'capcom vs', 'king of fighters',
  'samurai shodown', 'fatal fury', 'garou', 'guilty gear', 'killer instinct', 'darkstalkers', 'power stone',
  'mario party', 'bomberman', 'worms', 'super monkey ball', 'fusion frenzy', 'warioware',
  'mario tennis', 'mario golf', 'mario strikers', 'virtua tennis', 'hot shots golf',
  'nba jam', 'nfl blitz', 'nba street', 'fifa street', 'tony hawk', 'ssx', 'wwf', 'wwe',
  'smackdown', 'wcw', 'def jam', 'nba 2k', 'fifa', 'pes', 'pro evolution soccer', 'madden',
  'nhl', 'sensible soccer', 'super sidekicks', 'virtua striker', 'gauntlet', 'diablo',
  'champions of norrath', 'dark alliance', 'secret of mana', 'x-men legends', 'marvel ultimate alliance',
  'twisted metal', 'vigilante 8', 'split screen', 'splitscreen', 'multiplayer', '2 player', 'two player',
  '4 player', 'four player', 'co-op', 'coop', 'vs mode', 'battle mode'
];

export function isSplitScreenGame(g) {
  if (!g) return false;
  const p = String(g.players ?? g.metadata?.players ?? '');
  if (/^[2-8]$/.test(p) || /^[1-8]-[2-8]$/.test(p) || /2 player|4 player|multiplayer|co-?op/i.test(p)) {
    return true;
  }
  const title = String(g.title ?? '').toLowerCase();
  return SPLITSCREEN_KEYWORDS.some(t => title.includes(t));
}

export const SPLIT_GENRES = [
  { id: "all", label: "All Split-Screen", icon: "👥" },
  { id: "racing", label: "Split-Screen Racing", icon: "🏎️", match: (t) => /kart|crash team|ctr|diddy kong|gran turismo|burnout|need for speed|f-zero|wipeout|ridge racer|micro machines|sonic riders|chocobo|outrun|road rash|top gear|hydro thunder|wave race|destruction derby|flatout/i.test(t) },
  { id: "shooters", label: "Split-Screen Shooters", icon: "🎯", match: (t) => /goldeneye|perfect dark|timesplitters|halo|battlefront|quake|unreal|doom|duke nukem|medal of honor|turok|serious sam|red faction/i.test(t) },
  { id: "fighting", label: "Fighting & Versus", icon: "🥊", match: (t) => /smash|street fighter|tekken|mortal kombat|soulcalibur|virtua fighter|dead or alive|bloody roar|marvel vs|capcom vs|king of fighters|samurai shodown|fatal fury|guilty gear|killer instinct|power stone/i.test(t) },
  { id: "coop", label: "Co-Op Beat 'Em Up & Action", icon: "💥", match: (t) => /contra|metal slug|streets of rage|final fight|double dragon|turtles|tmnt|golden axe|battletoads|sunset riders|gunstar|cadillacs|captain commando|punisher|x-men|river city|simpsons|gauntlet|dark alliance|secret of mana/i.test(t) },
  { id: "party", label: "Party & Sports", icon: "🎲", match: (t) => /party|bomberman|worms|monkey ball|fusion frenzy|warioware|tennis|golf|nba|nfl|fifa|tony hawk|ssx|wwf|wwe|smackdown|madden|nhl|soccer/i.test(t) },
];

const HERE_NAME = { android: "This phone", ios: "This iPhone", windows: "This PC", linux: "This computer", computer: "This Mac" };
const TESTS = {
  here: (g) => playsHere(g.platform),
  phone: (g) => { const r = runsOn(g.platform); return r.browser || !!r.phone; },
  pc: (g) => runsOn(g.platform).pc,
  browser: (g) => runsOn(g.platform).browser,
  splitscreen: (g) => isSplitScreenGame(g),
  all: () => true,
};

export function Where({ games, render }) {
  const d = here();
  const pcLike = d === "windows" || d === "linux";
  const options = pcLike
    ? [
        ["all", "🎮 All Games"],
        ["splitscreen", "👥 Split-Screen & Co-Op"],
        ["browser", "🌐 Browser Play"],
        ["pc", "⚡ Local / PC Play"],
        ["phone", "📱 On Phones"]
      ]
    : [
        ["all", "🎮 All Games"],
        ["splitscreen", "👥 Split-Screen & Co-Op"],
        ["browser", "🌐 Browser Play"],
        ["here", `📱 ${HERE_NAME[d]}`],
        ["pc", "⚡ Needs a PC"]
      ];

  const [pick, setPick] = useState(() => {
    const v = read();
    return options.some(([k]) => k === v) ? v : options[0][0];
  });
  const [splitGenre, setSplitGenre] = useState("all");

  useEffect(() => {
    window.__nxForceBrowserPlay = (pick === "browser");
    return () => { window.__nxForceBrowserPlay = false; };
  }, [pick]);

  useEffect(() => {
    const onWhere = (e) => {
      const target = e?.detail;
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
    for (const [k] of options) c[k] = k === "all" ? list.length : list.filter(TESTS[k] ?? TESTS.all).length;
    if (c.pc != null && !pcLike) c.pc = list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc).length;
    return c;
  }, [list, d, pcLike]);

  const shown = useMemo(() => {
    let base = pick === "all" ? list : list.filter(TESTS[pick] ?? TESTS.all);
    if (pick === "pc" && !pcLike) base = list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc);
    if (pick === "splitscreen" && splitGenre !== "all") {
      const gObj = SPLIT_GENRES.find((sg) => sg.id === splitGenre);
      if (gObj?.match) base = base.filter((g) => gObj.match(String(g.title ?? "")));
    }
    return base;
  }, [list, pick, splitGenre, d, pcLike]);

  const choose = (k) => { setPick(k); write(k); if (k !== "splitscreen") setSplitGenre("all"); };
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
      {pick === "splitscreen" && (
        <div className="nxwhere-banner nxwhere-split-banner">
          <div className="nxwhere-banner-tag">👥 Split-Screen & Local Multiplayer Active</div>
          <p>These games support 2 to 4 players together on one screen. Connect multiple controllers (or keyboard + gamepads) to play split-screen racing, 4-player arena battles, couch co-op campaigns, and head-to-head fighting!</p>
          <div className="nxwhere-subpills">
            {SPLIT_GENRES.map((sg) => {
              const count = sg.id === "all" ? (counts.splitscreen ?? 0) : list.filter(TESTS.splitscreen).filter((g) => sg.match(String(g.title ?? ""))).length;
              if (sg.id !== "all" && count === 0) return null;
              return (
                <button
                  key={sg.id}
                  type="button"
                  className="nxwhere-subpill"
                  aria-pressed={splitGenre === sg.id}
                  onClick={() => setSplitGenre(sg.id)}
                >
                  <span>{sg.icon}</span> {sg.label} <span className="nxwhere-subpill-count">{count}</span>
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
