// "Where it plays" filter over the Games grid and hub: This phone / This PC,
// Phone, PC, In the browser, All. On a phone it starts on This phone, so a
// PS2 game only shows there when this phone has an app for it, instead of
// failing after Play. The choice is remembered on this device.
//
// The shell wraps its game lists in it (build.mjs 3n):
//   <NxWhere games={list} render={(shown) => <Grid games={shown} />} />
import React, { useState, useMemo } from "react";
import { runsOn, playsHere, here } from "./devices.js";

const KEY = "nx_where";
const read = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

const CSS = `
.nxwhere{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
.nxwhere button{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:rgba(255,255,255,.75);border-radius:999px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:34px}
.nxwhere button[aria-pressed="true"]{border-color:rgba(34,211,238,.7);background:rgba(34,211,238,.14);color:#e6fbff}
.nxwhere button span{opacity:.6;font-weight:600}
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
  // A Windows or Linux PC plays everything, so "This PC" would equal All there.
  const pcLike = d === "windows" || d === "linux";
  const options = pcLike
    ? [["all", "All"], ["browser", "In the browser"], ["phone", "Also on phones"]]
    : [["here", HERE_NAME[d]], ["all", "All"], ["browser", "In the browser"], ...(d === "android" ? [] : [["phone", "On phones"]]), ["pc", "Needs a PC"]];
  const [pick, setPick] = useState(() => { const v = read(); return options.some(([k]) => k === v) ? v : options[0][0]; });
  const list = Array.isArray(games) ? games : [];
  const counts = useMemo(() => {
    const c = {};
    for (const [k] of options) c[k] = k === "all" ? list.length : list.filter(TESTS[k] ?? TESTS.all).length;
    // "Needs a PC": games that don't play here.
    if (c.pc != null) c.pc = list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc).length;
    return c;
  }, [list, d]);
  const shown = useMemo(() => {
    if (pick === "pc" && !pcLike) return list.filter((g) => !playsHere(g.platform) && runsOn(g.platform).pc);
    return pick === "all" ? list : list.filter(TESTS[pick] ?? TESTS.all);
  }, [list, pick, d]);
  const choose = (k) => { setPick(k); write(k); };
  const hidden = list.length - shown.length;

  return (
    <>
      <style>{CSS}</style>
      {list.length > 0 && (
        <div className="nxwhere" role="group" aria-label="Where it plays">
          {options.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={pick === k} onClick={() => choose(k)}>
              {label} <span>{(counts[k] ?? 0).toLocaleString()}</span>
            </button>
          ))}
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
