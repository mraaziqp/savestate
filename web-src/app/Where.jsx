// "Where it plays" filter over the Games grid and hub: All Games,
// Browser Play, Local / PC Play, On Phones.
// When "Browser Play" is selected, games launch directly in the browser
// via EmulatorJS without native emulator dependencies.
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
.nxwhere-banner{display:flex;flex-direction:column;gap:6px;padding:12px 16px;border-radius:14px;background:linear-gradient(135deg,rgba(34,211,238,.12),rgba(59,130,246,.08));border:1px solid rgba(34,211,238,.35);margin:0 0 16px}
.nxwhere-banner-tag{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.12em;color:#22d3ee;display:inline-flex;align-items:center;gap:6px}
.nxwhere-banner p{margin:0;font-size:13px;color:rgba(255,255,255,.85);line-height:1.45}
.nxwhere-note{font-size:12.5px;color:rgba(255,255,255,.5);margin:-6px 0 12px}
.nxwhere-note button{all:unset;cursor:pointer;color:#67e8f9;text-decoration:underline}
@media (max-width:640px){.nxwhere{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;margin:0 -4px 10px;padding:0 4px}.nxwhere::-webkit-scrollbar{display:none}.nxwhere button{flex:none}}
`;

const HERE_NAME = { android: "This phone", ios: "This iPhone", windows: "This PC", linux: "This computer", computer: "This Mac" };
const TESTS = {
  here: (g) => playsHere(g.platform),
  phone: (g) => { const r = runsOn(g.platform); return r.browser || !!r.phone; },
  pc: (g) => runsOn(g.platform).pc,
  browser: (g) => runsOn(g.platform).browser,
  all: () => true,
};

export function Where({ games, render }) {
  const d = here();
  const pcLike = d === "windows" || d === "linux";
  const options = pcLike
    ? [
        ["all", "🎮 All Games"],
        ["browser", "🌐 Browser Play"],
        ["pc", "⚡ Local / PC Play"],
        ["phone", "📱 On Phones"]
      ]
    : [
        ["all", "🎮 All Games"],
        ["browser", "🌐 Browser Play"],
        ["here", `📱 ${HERE_NAME[d]}`],
        ["pc", "⚡ Needs a PC"]
      ];

  const [pick, setPick] = useState(() => {
    const v = read();
    return options.some(([k]) => k === v) ? v : options[0][0];
  });

  useEffect(() => {
    window.__nxForceBrowserPlay = (pick === "browser");
    return () => { window.__nxForceBrowserPlay = false; };
  }, [pick]);

  const list = Array.isArray(games) ? games : [];
  const counts = useMemo(() => {
    const c = {};
    for (const [k] of options) c[k] = k === "all" ? list.length : list.filter(TESTS[k] ?? TESTS.all).length;
    if (c.pc != null && !pcLike) c.pc = list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc).length;
    return c;
  }, [list, d, pcLike]);

  const shown = useMemo(() => {
    if (pick === "pc" && !pcLike) return list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc);
    return pick === "all" ? list : list.filter(TESTS[pick] ?? TESTS.all);
  }, [list, pick, d, pcLike]);

  const choose = (k) => { setPick(k); write(k); };
  const hidden = list.length - shown.length;

  return (
    <>
      <style>{CSS}</style>
      {list.length > 0 && (
        <div className="nxwhere" role="group" aria-label="Game play mode and platform filters">
          {options.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={pick === k} onClick={() => choose(k)}>
              {label} <span>{(counts[k] ?? 0).toLocaleString()}</span>
            </button>
          ))}
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
