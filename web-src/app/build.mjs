#!/usr/bin/env node
// Builds the sign-in, welcome, plans and setup-guide screens into
// dist/assets/NexusApp-<rev>.js (plus NexusBoot-<rev>.js), and wires them into
// the compiled app.
//
//   node web-src/app/build.mjs
//   node scripts/rev-dist.mjs r<N>     (afterwards, so browsers fetch the new files)
//
// The rest of the frontend only exists as the compiled bundle in dist/ (the
// Vite sources were lost), so this module plugs into it the same way
// web-src/watch does: React comes from the bundle's own vendor chunks, and a
// handful of exact strings in the compiled shell are rewritten to point at
// this module. Every rewrite is idempotent and fails loudly if its anchor has
// gone, so a silent half-wired build is not possible.
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const dist = path.join(root, "dist");
const assets = path.join(dist, "assets");
const esbuild = createRequire(path.join(root, "package.json"))("esbuild");

const files = readdirSync(assets);
const find = (prefix) => {
  const f = files.find((x) => x.startsWith(prefix) && x.endsWith(".js"));
  if (!f) throw new Error(`no ${prefix}*.js in dist/assets`);
  return f;
};
const shellFile = find("index-");
const rev = /-(r\d+)\.js$/.exec(shellFile)?.[1] ?? "r0";
const emulationHub = find("EmulationHub-");

// How the compiled chunks get React: `var a=ft(gt(),1)` with ft and gt imported.
const sample = readFileSync(path.join(assets, emulationHub), "utf8");
const m = /var (\w+)=(\w+)\((\w+)\(\),1\)/.exec(sample);
if (!m) throw new Error("could not find the React import pattern in " + emulationHub);
const importOf = (local) => {
  for (const im of sample.matchAll(/import\{([^}]*)\}from"\.\/([^"]+)"/g)) {
    for (const spec of im[1].split(",")) {
      const [exp, , loc] = spec.trim().split(/\s+/);
      if ((loc ?? exp) === local) return { exp, file: im[2] };
    }
  }
  throw new Error(`no import for ${local} in ${emulationHub}`);
};
const toEsm = importOf(m[2]);
const reactReq = importOf(m[3]);
const reactModule = `
import { ${toEsm.exp} as __toESM } from "./${toEsm.file}";
import { ${reactReq.exp} as __react } from "./${reactReq.file}";
const React = __toESM(__react(), 1);
export default React;
export const { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense, Fragment, createElement, memo } = React;
`;
const oldEmulation = `export const loadOldEmulationHub = () => import("./${emulationHub}").then((m) => ({ default: m.EmulationHub }));`;
const oldCloud = `export const loadOldCloudHub = () => import("./${find("CloudHub-")}").then((m) => ({ default: m.CloudHub }));`;

const appOut = `NexusApp-${rev}.js`;
const bootOut = `NexusBoot-${rev}.js`;
await esbuild.build({
  entryPoints: [path.join(here, "index.jsx")],
  bundle: true, format: "esm", minify: true, target: "es2020",
  jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
  outfile: path.join(assets, appOut), legalComments: "none",
  plugins: [{
    name: "host-bundle",
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "host" }));
      b.onResolve({ filter: /^old-emulation$/ }, () => ({ path: "old-emulation", namespace: "host" }));
      b.onResolve({ filter: /^old-cloud$/ }, () => ({ path: "old-cloud", namespace: "host" }));
      b.onResolve({ filter: /^\.\/[\w-]+\.js$/, namespace: "host" }, (a) => ({ path: a.path, external: true }));
      b.onLoad({ filter: /.*/, namespace: "host" }, (a) => ({
        contents: a.path === "react" ? reactModule : a.path === "old-cloud" ? oldCloud : oldEmulation, loader: "js", resolveDir: here,
      }));
    },
  }],
});
await esbuild.build({
  entryPoints: [path.join(here, "boot.js")],
  bundle: true, format: "iife", minify: true, target: "es2020", outfile: path.join(assets, bootOut), legalComments: "none",
});
for (const f of readdirSync(assets)) {
  if ((/^NexusApp-r\d+\.js$/.test(f) && f !== appOut) || (/^NexusBoot-r\d+\.js$/.test(f) && f !== bootOut)) unlinkSync(path.join(assets, f));
}

// ── Wiring ──────────────────────────────────────────────────────────────
// patch(text, name, done, from, to): `done` is a string only the patched code
// contains. `from` may be a string or a RegExp matching the original.
function patch(text, name, done, from, to) {
  if (text.includes(done)) return text;
  const hit = typeof from === "string" ? text.includes(from) : from.test(text);
  if (!hit) throw new Error(`patch "${name}": anchor not found`);
  const out = text.replace(from, () => to);
  if (!out.includes(done)) throw new Error(`patch "${name}": did not apply`);
  return out;
}
const APP = `"./${appOut}"`;
const anyApp = /"\.\/NexusApp-r\d+\.js"/g;

// 1. The sign-in form chunk becomes a re-export, so its importers
//    (ProfileManager, RemoteClientOnboarding, the shell) need no change.
writeFileSync(path.join(assets, find("AuthForm-")), `export{AuthForm as t}from${APP};\n`);

// 2. The app shell.
let shell = readFileSync(path.join(assets, shellFile), "utf8").replace(anyApp, APP);
const before = shell;

// Signed-out visitors on the web get the welcome page instead of the app
// (which asked them to choose HOST or CLIENT and loaded behind the question).
// Native and desktop clients, and browsers already set up as a client of
// another host, keep their own onboarding.
// The block is rebuilt on every run (it carries the module's file name), so
// the pattern matches both the original Jl and a previously wired one.
{
  const re = /(?:var NxLoad=\(\)=>import\("\.\/NexusApp-r\d+\.js"\),[\s\S]*?)?function Jl\(\)\{return \$s\?\(0,e\.jsx\)\(Ri,\{sessionId:\$s\.sessionId,initialTitle:\$s\.title\}\):\(0,e\.jsx\)\((?:Yl|NxRoot),\{\}\)\}/;
  if (!re.test(shell)) throw new Error('patch "welcome": anchor not found');
  shell = shell.replace(re, () =>
    `var NxLoad=()=>import(${APP}),` +
    `NxWelcome=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.Welcome}))),` +
    `NxGate=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.TabGate}))),` +
    `NxSetup=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.EmulationTab}))),` +
    `NxDrives=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.DrivesPage}))),` +
    `NxMyDrives=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.MyDrives}))),` +
    `NxHousehold=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.Household}))),` +
    `NxDownloader=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.DownloaderSetup}))),` +
    `NxActivity=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.ActivityLog}))),` +
    `NxMiniGames=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.MiniGames}))),` +
    `NxGuides=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.Guides}))),` +
    `NxAddGames=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.AddGames}))),` +
    `NxProfiles=(0,s.lazy)(()=>NxLoad().then(t=>({default:t.ProfileLayer})));` +
    // Welcome when: an ordinary browser tab on the host's own site, and either
    // nobody is signed in or the address carries a password-reset link.
    `function NxRoot(){var t=!1;try{var w=/^https?:$/.test(location.protocol)&&!to()&&!Fe()&&!Ht(location.hostname)&&(!zt()||String(zt()).indexOf(location.origin)===0);` +
    `t=w&&(!localStorage.getItem("nexus_token")||new URLSearchParams(location.search).has("reset"))}catch{}` +
    // Signed in: the app, with household profiles over it ("Who's watching?", the profile chip).
    `return t?(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxWelcome,{})}):(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(Yl,{}),(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxProfiles,{})})]})}` +
    `function Jl(){return $s?(0,e.jsx)(Ri,{sessionId:$s.sessionId,initialTitle:$s.title}):(0,e.jsx)(NxRoot,{})}`);
}

// Upgrade / request-access screens over a tab that is not available.
// The "Update available — Install Update" prompt is for installed apps (the
// Android app, the old desktop app). A browser always runs the current site,
// and it was offered the Windows installer as an "update" once that
// installer's version passed the site's.
shell = patch(shell, "update prompt only in installed apps", "const M=async()=>{try{if(!_n()&&!window.__TAURI_INTERNALS__",
  "const M=async()=>{try{const U=await En();",
  "const M=async()=>{try{if(!_n()&&!window.__TAURI_INTERNALS__&&!window.__TAURI__&&!/electron/i.test(navigator.userAgent))return;const U=await En();");
// Remote Bridge drives the host (watcher, network); a member opening it by
// URL got two 403s and "Failed to load". Admins only, like Host Health.
shell = patch(shell, "remote bridge is admin-only", 'x==="handheld"&&Pe("manage_system")&&',
  'x==="handheld"&&(0,e.jsx)(rl,{})', 'x==="handheld"&&Pe("manage_system")&&(0,e.jsx)(rl,{})');
// Picking a game in quick search, or asking the assistant to launch one,
// started it on the host's PC for everyone. On a client (any browser not on
// the host's own address) it opens the game's page, where "How do you want
// to play?" offers what works on that device.
shell = patch(shell, "quick search opens the game on clients", "async u=>{if(Ft()){ce(u);return}ce(null);try{",
  "qn=(0,s.useCallback)(async u=>{ce(null);try{", "qn=(0,s.useCallback)(async u=>{if(Ft()){ce(u);return}ce(null);try{");
shell = patch(shell, "assistant opens the game on clients", 'if(Ft()){try{const g=await fetch("/api/games"',
  'if(J&&J!=="retroarch"&&ne){S("pcgames");return}if(U)try{',
  'if(J&&J!=="retroarch"&&ne){S("pcgames");return}if(Ft()){try{const g=await fetch("/api/games",{headers:{Authorization:`Bearer ${localStorage.getItem("nexus_token")??""}`},signal:le}).then(r=>r.json()),a=Array.isArray(g)?g:g.games??[],f=a.find(x=>x.id===U)||(q?a.find(x=>String(x.title).toLowerCase()===String(q).toLowerCase()):null);S("library");f&&ce(f)}catch{}return}if(U)try{');
shell = patch(shell, "tab gate", "(0,e.jsx)(NxGate,{tab:x})",
  `className:"relative flex-1 flex flex-col gap-8",children:[x==="library"&&`,
  `className:"relative flex-1 flex flex-col gap-8",children:[(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxGate,{tab:x})}),x==="library"&&`);

// Plans tab.
shell = patch(shell, "plans", `import(${APP}).then(t=>({default:t.PlansPage}))`,
  /import\("\.\/PlansPage-[\w-]+\.js"\)\.then\(t=>\(\{default:t\.PlansPage\}\)\)/,
  `import(${APP}).then(t=>({default:t.PlansPage}))`);

// "Emulation Setup" is in everyone's menu but only rendered for admins, so
// members got an empty page. It now opens the setup guide for everyone, with
// the host's tools underneath for admins.
shell = patch(shell, "setup guide", `x==="emulation"&&(0,e.jsx)(NxSetup,{isAdmin:Pe("manage_system")})`,
  `x==="emulation"&&Pe("manage_system")&&(0,e.jsx)(Cl,{})`,
  `x==="emulation"&&(0,e.jsx)(NxSetup,{isAdmin:Pe("manage_system")})`);
shell = patch(shell, "emulation is not admin-only", `"users","access","cloud"])`,
  `"users","access","emulation","cloud"])`, `"users","access","cloud"])`);

// Cloud: the two-account Drive file manager and upload jobs, with the old
// Cloud hub kept under "advanced". The menu entry was shown to everyone but
// only rendered for admins (an empty page for members); it is admin-only now.
shell = patch(shell, "cloud drives", `x==="cloud"&&Pe("manage_system")&&(0,e.jsx)(NxDrives,{})`,
  `x==="cloud"&&Pe("manage_system")&&(0,e.jsx)(La,{})`, `x==="cloud"&&Pe("manage_system")&&(0,e.jsx)(NxDrives,{})`);
shell = patch(shell, "cloud is admin-only in the menu", `brain:"manage_system",cloud:"manage_system"`,
  `brain:"manage_system"}`, `brain:"manage_system",cloud:"manage_system"}`);

shell = patch(shell, "cloud drives label", `{id:"cloud",icon:Xa,label:"Cloud Drives"`, `{id:"cloud",icon:Xa,label:"Cloud"`, `{id:"cloud",icon:Xa,label:"Cloud Drives"`);

shell = patch(shell, "cloud drives title", `cloud:"Cloud Drives",myfiles:"Files",`,`ql={myfiles:"Files",`, `ql={cloud:"Cloud Drives",myfiles:"Files",`);

// My Drives: every member can connect and manage their own cloud drives, at
// the top of what was "My Storage".
shell = patch(shell, "my drives", `x==="files"&&(0,e.jsxs)("div",{className:"space-y-8",children:[(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxMyDrives,{})}),(0,e.jsx)(ul,{}),`,
  `x==="files"&&(0,e.jsxs)("div",{className:"space-y-8",children:[(0,e.jsx)(ul,{}),`,
  `x==="files"&&(0,e.jsxs)("div",{className:"space-y-8",children:[(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxMyDrives,{})}),(0,e.jsx)(ul,{}),`);
shell = patch(shell, "my drives label", `{id:"files",icon:Bt,label:"My Drives"`, `{id:"files",icon:Bt,label:"My Storage"`, `{id:"files",icon:Bt,label:"My Drives"`);
shell = patch(shell, "my drives title", `files:"My Drives",`, `files:"My Files",`, `files:"My Drives",`);

// Household profiles: the Profiles tab, and a menu that offers a profile
// only what it may open (boot.js sets window.__nxAllow).
shell = patch(shell, "profiles tab", `x==="household"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxHousehold,{})}),x==="plans"&&`,
  `x==="plans"&&(0,e.jsx)(dl,{onNavigate:S}),`, `x==="household"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxHousehold,{})}),x==="plans"&&(0,e.jsx)(dl,{onNavigate:S}),`);
shell = patch(shell, "profiles menu item", `{id:"household",icon:us,label:"Profiles"`,
  `{id:"plans",icon:xs,label:"Plans & Pricing"`, `{id:"household",icon:us,label:"Profiles",color:"#f472b6",glow:"rgba(244,114,182,0.25)"},{id:"plans",icon:xs,label:"Plans & Pricing"`);
shell = patch(shell, "profiles title", `household:"Profiles",cloud:"Cloud Drives",`, `ql={cloud:"Cloud Drives",`, `ql={household:"Profiles",cloud:"Cloud Drives",`);
shell = patch(shell, "profile menu filter", `C=(0,s.useCallback)(m=>{if(window.__nxAllow&&!window.__nxAllow.has(m))return!1;if(Mr.has(m))return y;`,
  `C=(0,s.useCallback)(m=>{if(Mr.has(m))return y;`, `C=(0,s.useCallback)(m=>{if(window.__nxAllow&&!window.__nxAllow.has(m))return!1;if(Mr.has(m))return y;`);
{
  const head = `className:"w-full flex items-center justify-between px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.2em] text-white/35 hover:text-white/60 transition-colors",children:[(0,e.jsx)("span",{children:`;
  shell = patch(shell, "empty games heading", `style:x.length?void 0:{display:"none"},${head}"Games"`, `${head}"Games"`, `style:x.length?void 0:{display:"none"},${head}"Games"`);
  shell = patch(shell, "empty tools heading", `style:A.length?void 0:{display:"none"},${head}"System & Tools"`, `${head}"System & Tools"`, `style:A.length?void 0:{display:"none"},${head}"System & Tools"`);
}
shell = patch(shell, "profile bottom bar", `As.filter(m=>!window.__nxAllow||window.__nxAllow.has(m.id)).map(m=>{const c=t===m.id;`,
  `As.map(m=>{const c=t===m.id;`, `As.filter(m=>!window.__nxAllow||window.__nxAllow.has(m.id)).map(m=>{const c=t===m.id;`);

// Downloads: the downloader setup and health card, for admins, above the downloads.
shell = patch(shell, "downloader setup", `x==="torrent"&&(0,e.jsxs)(e.Fragment,{children:[Pe("manage_system")&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxDownloader,{})}),(0,e.jsx)(vl,{})]})`,
  `x==="torrent"&&(0,e.jsx)(vl,{})`, `x==="torrent"&&(0,e.jsxs)(e.Fragment,{children:[Pe("manage_system")&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxDownloader,{})}),(0,e.jsx)(vl,{})]})`);

// Page titles: tabs missing from the title map showed their raw id
// ("Ai", "Phonebackup", "Become-host").
shell = patch(shell, "page titles", `ai:"SaveState AI",phonebackup`,
  `ql={household:"Profiles",`,
  `ql={ai:"SaveState AI",phonebackup:"Phone Backup",remoteplay:"Remote Play","become-host":"Become a Host",party:"Watch Party",gallery:"Photos",photos:"Photo Booklet",matchmaker:"What to Watch",library:"Games",multiplayer:"Multiplayer",emulation:"Emulation Setup",storage:"Storage",activity:"Activity",settings:"Settings",controller:"Controller",logs:"Logs",profile:"Profile",plans:"Plans & Pricing",music:"Music",household:"Profiles",`);
shell = patch(shell, "page title names", `media:"Movies & TV",`, `media:"Movies",`, `media:"Movies & TV",`);
shell = patch(shell, "ebooks title", `codex:"eBooks",`, `codex:"Codex",`, `codex:"eBooks",`);

// Music: the player lives inside the Music page, and the tab area unmounts a
// page when you leave it, so the song stopped on every tab change (and the
// keyless wrapper tried first did not survive it). The page is now mounted
// once at the app's root (NxMusicHost) and its DOM is moved into a slot on
// the Music tab, or into a hidden holder elsewhere, where only its fixed bar
// shows. Moving DOM never remounts React, so the audio keeps going.
// Each piece is checked on its own: the welcome block above is rebuilt on
// every run and drops the injected functions.
{
  const lazyName = /,(\w+)=\(0,s\.lazy\)\(\(\)=>\w+\(\(\)=>import\("\.\/MusicHub-/.exec(shell)?.[1];
  if (!lazyName) throw new Error('patch "music keeps playing": MusicHub import not found');
  if (!shell.includes("ref:NxMusicSlotRef")) {
    const m = /x==="music"&&\(0,e\.jsx\)\(\w+,\{\}\)/.exec(shell)
      ?? /\(x==="music"&&\(window\.__nxMusic=!0\),window\.__nxMusic\)&&\(0,e\.jsx\)\("div",\{className:x==="music"\?"":"nx-music-away",children:\(0,e\.jsx\)\(\w+,\{\}\)\}\)/.exec(shell);
    if (!m) throw new Error('patch "music slot": anchor not found');
    shell = shell.replace(m[0], () => 'x==="music"&&(0,e.jsx)("div",{ref:NxMusicSlotRef})');
  }
  if (!shell.includes("function NxMusicHost(")) {
    if (!shell.includes("function NxRoot(){")) throw new Error('patch "music host": NxRoot not found');
    shell = shell.replace("function NxRoot(){", () =>
      'function NxMusicSlotRef(t){window.__nxMusicSlot=t;window.dispatchEvent(new Event("nx:music-slot"))}'
      + 'function NxMusicHost(){const[on,setOn]=(0,s.useState)(!1),home=(0,s.useRef)(null),box=(0,s.useRef)(null);'
      + '(0,s.useEffect)(()=>{const place=()=>{const slot=window.__nxMusicSlot,b=box.current;if(!b||!home.current)return;'
      + 'if(slot){setOn(!0);if(b.parentNode!==slot)slot.appendChild(b);b.classList.remove("nx-music-away")}'
      + 'else{if(b.parentNode!==home.current)home.current.appendChild(b);b.classList.add("nx-music-away")}};'
      + 'place();window.addEventListener("nx:music-slot",place);return()=>{window.removeEventListener("nx:music-slot",place);const b=box.current;if(b&&home.current&&b.parentNode!==home.current)home.current.appendChild(b)}},[on]);'
      + `return (0,e.jsx)("div",{ref:home,children:(0,e.jsx)("div",{ref:box,className:"nx-music-away",children:on&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(${lazyName},{})})})})}`
      + 'function NxRoot(){');
  }
  shell = patch(shell, "music host at the root", "(0,e.jsx)(NxMusicHost,{})",
    "(0,e.jsx)(Yl,{}),(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxProfiles,{})})",
    "(0,e.jsx)(Yl,{}),(0,e.jsx)(NxMusicHost,{}),(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxProfiles,{})})");
}

// Activity log: live progress and receipts (ActivityLog.jsx), for everyone.
shell = patch(shell, "activity log tab", `x==="receipts"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxActivity,{})}),x==="household"&&`,
  `x==="household"&&`, `x==="receipts"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxActivity,{})}),x==="household"&&`);
shell = patch(shell, "activity log menu", `{id:"receipts",icon:xs,label:"Activity log"`,
  `{id:"household",icon:us,label:"Profiles"`, `{id:"receipts",icon:xs,label:"Activity log",color:"#22d3ee",glow:"rgba(34,211,238,0.25)"},{id:"household",icon:us,label:"Profiles"`);
shell = patch(shell, "activity log title", `receipts:"Activity log",`, `ql={ai:"SaveState AI",`, `ql={receipts:"Activity log",ai:"SaveState AI",`);
shell = patch(shell, "activity log is known", `"household","receipts"`, `"household"]`, `"household","receipts"]`);
// Mini Games: agent-builder games for everyone, upload for admins (MiniGames.jsx).
shell = patch(shell, "mini games tab", `x==="minigames"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxMiniGames,{})}),`,
  `x==="receipts"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxActivity,{})}),`,
  `x==="minigames"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxMiniGames,{})}),x==="receipts"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxActivity,{})}),`);
shell = patch(shell, "mini games menu", `{id:"minigames",icon:be,label:"Mini Games"`,
  `{id:"consoles",icon:be,label:"Play Offline",color:"#a855f7",glow:"rgba(168,85,247,0.25)"}`,
  `{id:"consoles",icon:be,label:"Play Offline",color:"#a855f7",glow:"rgba(168,85,247,0.25)"},{id:"minigames",icon:be,label:"Mini Games",color:"#f472b6",glow:"rgba(244,114,182,0.25)"}`);
shell = patch(shell, "mini games title", `minigames:"Mini Games",`, `ql={receipts:"Activity log",`, `ql={minigames:"Mini Games",receipts:"Activity log",`);
shell = patch(shell, "mini games is known", `"household","receipts","minigames"`, `"household","receipts"]`, `"household","receipts","minigames"]`);
// Help & guides: how to set up and use everything (Guides.jsx), for everyone.
shell = patch(shell, "guides tab", `x==="help"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxGuides,{})}),`,
  `x==="minigames"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxMiniGames,{})}),`,
  `x==="help"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxGuides,{})}),x==="minigames"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxMiniGames,{})}),`);
shell = patch(shell, "guides menu", `{id:"help",icon:xs,label:"Help & guides"`,
  `{id:"receipts",icon:xs,label:"Activity log",color:"#22d3ee",glow:"rgba(34,211,238,0.25)"}`,
  `{id:"receipts",icon:xs,label:"Activity log",color:"#22d3ee",glow:"rgba(34,211,238,0.25)"},{id:"help",icon:xs,label:"Help & guides",color:"#a3e635",glow:"rgba(163,230,53,0.25)"}`);
shell = patch(shell, "guides title", `help:"Help & guides",`, `ql={minigames:"Mini Games",`, `ql={help:"Help & guides",minigames:"Mini Games",`);
shell = patch(shell, "guides is known", `"receipts","minigames","help"`, `"household","receipts","minigames"]`, `"household","receipts","minigames","help"]`);
// Add games (admins): ROM files and folders into the library (AddGames.jsx).
shell = patch(shell, "add games tab", `x==="addgames"&&Pe("manage_system")&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxAddGames,{})}),`,
  `x==="help"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxGuides,{})}),`,
  `x==="addgames"&&Pe("manage_system")&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxAddGames,{})}),x==="help"&&(0,e.jsx)(s.Suspense,{fallback:null,children:(0,e.jsx)(NxGuides,{})}),`);
shell = patch(shell, "add games menu", `{id:"addgames",icon:be,label:"Add games"`,
  `{id:"minigames",icon:be,label:"Mini Games",color:"#f472b6",glow:"rgba(244,114,182,0.25)"}`,
  `{id:"minigames",icon:be,label:"Mini Games",color:"#f472b6",glow:"rgba(244,114,182,0.25)"},{id:"addgames",icon:be,label:"Add games",color:"#34d399",glow:"rgba(52,211,153,0.25)"}`);
shell = patch(shell, "add games is admin-only in the menu", `cloud:"manage_system",addgames:"manage_system"}`,
  `cloud:"manage_system"}`, `cloud:"manage_system",addgames:"manage_system"}`);
shell = patch(shell, "add games title", `addgames:"Add games",`, `ql={help:"Help & guides",`, `ql={addgames:"Add games",help:"Help & guides",`);
shell = patch(shell, "add games is known", `"minigames","help","addgames"]`, `"household","receipts","minigames","help"]`, `"household","receipts","minigames","help","addgames"]`);

// Tabs the menu offers but deep links (?tab=) and in-app navigation refused.
shell = patch(shell, "known tabs", `"matchmaker","music","multiplayer","remoteplay","ai"`,
  `"cloud","phonebackup","matchmaker"]`, `"cloud","phonebackup","matchmaker","music","multiplayer","remoteplay","ai"]`);
shell = patch(shell, "profiles tab is known", `"remoteplay","ai","household"`, `"remoteplay","ai"]`, `"remoteplay","ai","household"]`);

// Media first: everyone lands on Movies & TV (client mode used to open Games),
// and the menu leads with watching, then listening and reading.
shell = patch(shell, "land on media", `Bs.includes(u)?u:"media"`, `Bs.includes(u)?u:Ft()?"library":"media"`, `Bs.includes(u)?u:"media"`);

// Someone waiting for the host to approve them was sent back to the join
// screen on every visit, which hid the whole app (their own files, Discover,
// the setup guide, Plans). The Movies tab now says where the request stands.
shell = patch(shell, "no forced waiting screen", `if(!1&&(q==="pending"||q==="denied")){`,
  `if(q==="pending"||q==="denied"){try{localStorage.removeItem("nexus_remote_onboarding_v1")}catch{}`,
  `if(!1&&(q==="pending"||q==="denied")){try{localStorage.removeItem("nexus_remote_onboarding_v1")}catch{}`);

// "Fetching box art for 32 game(s)..." was announced whatever the server
// answered. It now appears only when a fetch really started (admins, and only
// when one is not already running).
shell = patch(shell, "honest box-art notice", "NxArt.started&&ae(`Fetching box art",
  "signal:AbortSignal.timeout(4e3)}).then(()=>{ae(`Fetching box art",
  "signal:AbortSignal.timeout(4e3)}).then(NxArt=>NxArt.json().catch(()=>({}))).then(NxArt=>{NxArt&&NxArt.started&&ae(`Fetching box art");

// "App updated - Reload" greeted every first-time visitor: a service worker
// claiming a page that had none fires the same event as a real update.
shell = patch(shell, "first-visit update notice", "__nxHadSW",
  `navigator.serviceWorker.addEventListener("controllerchange",()=>{if(console.log("[SW] New service worker activated"),`,
  `window.__nxHadSW=!!navigator.serviceWorker.controller,navigator.serviceWorker.addEventListener("controllerchange",()=>{if(!window.__nxHadSW){window.__nxHadSW=!0;return}if(console.log("[SW] New service worker activated"),`);
{
  const mArr = /pn=\[(\{id:"media".*?\})\],fn=\[/.exec(shell);
  if (!mArr) throw new Error('patch "menu order": media menu not found');
  const items = mArr[1].split(/,(?=\{id:")/);
  const idOf = (s) => /^\{id:"([\w-]+)"/.exec(s)?.[1];
  const order = ["media", "matchmaker", "discover", "music", "codex", "party", "torrent", "gallery", "photos", "myfiles", "files", "cloud", "phonebackup", "hosts", "friends", "household", "receipts", "plans"];
  const rank = (s) => { const i = order.indexOf(idOf(s)); return i < 0 ? order.length : i; };
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
  if (sorted.length !== items.length) throw new Error('patch "menu order": lost an item');
  shell = shell.replace(mArr[0], `pn=[${sorted.join(",")}],fn=[`);
}

// The shell carries the app version in four places (the version shown in
// App Info, the update check, and the build id whose change makes browsers
// clear old caches once). It is stamped from package.json on every build.
{
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const current = /function \w+\(\)\{return"(\d+\.\d+\.\d+)"\}async function/.exec(shell)?.[1];
  if (!current) throw new Error('patch "app version": anchor not found');
  if (current !== version) shell = shell.split(`"${current}"`).join(`"${version}"`);
}

if (shell !== before) writeFileSync(path.join(assets, shellFile), shell);

// 3. The music player: stream URLs carry the token, for clients (the desktop
//    and Android apps) where the session cookie does not reach the host.
{
  const file = path.join(assets, find("MusicHub-"));
  let music = readFileSync(file, "utf8");
  const tok = "${(()=>{try{const k=localStorage.getItem(\"nexus_token\");return k?\"&token=\"+encodeURIComponent(k):\"\"}catch{return\"\"}})()}";
  const re = /\/api\/music\/stream\?rel=\$\{encodeURIComponent\((\w+)\.absPath\)\}(?!\$\{\(\(\)=>)/g;
  const next = music.replace(re, (all) => all + tok);
  if (!next.includes("&token=")) throw new Error('patch "music token": stream URL not found');
  if (next !== music) writeFileSync(file, next);
}

// 3a. Films and covers are signed in the same way: the session cookie covers
//     the browser, the token in the URL covers clients it does not reach.
for (const chunk of ["MediaHub-", "WatchParty-"]) {
  const file = path.join(assets, find(chunk));
  const hub = readFileSync(file, "utf8");
  const tok = "${(()=>{try{const k=localStorage.getItem(\"nexus_token\");return k?\"&token=\"+encodeURIComponent(k):\"\"}catch{return\"\"}})()}";
  // Not the HLS playlist: the player passes that through its own helper, which
  // adds the token, and two tokens in one URL are refused.
  const re = /\/api\/media\/(?:file|stream)\?rel=\$\{encodeURIComponent\([\w.]+\)\}(?!\$\{\(\(\)=>)/g;
  const next = hub.split(`/api/media/hls/playlist.m3u8?rel=\${encodeURIComponent(n.relPath)}${tok}`).join("/api/media/hls/playlist.m3u8?rel=${encodeURIComponent(n.relPath)}")
    .replace(re, (all) => all + tok);
  if (!next.includes("&token=")) throw new Error(`patch "media token": media URLs not found in ${chunk}`);
  if (next !== hub) writeFileSync(file, next);
}

// 3e. Movies & TV > upload: the planned, resumable folder uploader
//     (MediaUpload.jsx) replaces the three upload tiles, which stay in the
//     page but hidden so the chunk's own state code is untouched.
{
  const file = path.join(assets, find("MediaHub-"));
  let hub = readFileSync(file, "utf8").replace(anyApp, APP);
  const before = hub;
  const grid = `(0,e.jsxs)("div",{className:"grid md:grid-cols-3 gap-3",children:[(0,e.jsxs)("label",{className:\`rounded-2xl border border-white/15 p-5 bg-black/35`;
  hub = patch(hub, "new uploader", "(0,e.jsx)(nxUp(),{})",
    grid, `(0,e.jsx)(r.Suspense,{fallback:null,children:(0,e.jsx)(nxUp(),{})}),${grid.replace('className:"grid md:grid-cols-3 gap-3",', 'className:"grid md:grid-cols-3 gap-3",style:{display:"none"},')}`);
  const hubExport = /export\{(\w+) as MediaHub\};\s*$/.exec(hub)?.[0] ?? "";
  hub = patch(hub, "uploader loader", "function nxUp(){", hubExport || /export\{\w+ as MediaHub\};\s*$/,
    `var NxUpC;function nxUp(){return NxUpC||(NxUpC=(0,r.lazy)(()=>import(${APP}).then(t=>({default:t.MediaUploader}))))}${hubExport}`);
  hub = patch(hub, "uploader hint", "Episodes are grouped by show and season however the folders are laid out.",
    "For series, upload the entire show folder (for example: Game of Thrones/Season 01/S01E01.mkv). Nexus keeps folder structure and auto-categorizes episodes.",
    "Upload a show's folder or a whole collection. Episodes are grouped by show and season however the folders are laid out.");
  if (hub !== before) writeFileSync(file, hub);
}

// 3f. The game details window was a fixed-height box with a 48px title: on a
//     phone (and any short landscape screen) the Play button and details
//     were cut off with nothing to scroll. Its parts are tagged here and the
//     boot stylesheet turns it into one scrolling column on small screens.
{
  const file = path.join(assets, find("ExpandableDetail-"));
  let d = readFileSync(file, "utf8");
  const before = d;
  const tag = (name, cls, add) => { d = patch(d, name, `"${add} ${cls}`, `"${cls}`, `"${add} ${cls}`); };
  tag("game details on phones", "fixed inset-0 z-50 flex items-center justify-center p-4 md:p-12", "nx-detail-wrap");
  tag("game details box", "w-full max-w-6xl h-full max-h-[85vh] rounded-3xl overflow-hidden relative flex flex-col md:flex-row", "nx-detail");
  tag("game details side", "relative z-10 w-full md:w-[380px] p-8 flex flex-col glass-panel border-y-0 border-l-0 overflow-y-auto", "nx-detail-side");
  tag("game details main", "relative z-10 flex-1 p-8 md:p-12 overflow-hidden flex flex-col", "nx-detail-main");
  tag("game details title", "text-3xl md:text-5xl font-black leading-tight italic", "nx-detail-title");
  // "Open Nexus at http://your-host:3000 ... HTTPS blocks local launcher
  // connections" was shown on phones too, where there is no launcher at all.
  d = d.replace(/if\((\w+)&&!(\w+)\(\)\)\{(\w+)\("missing"\),(\w+)\(!0\),(\w+)\(\{status:"missing-launcher",detail:"Open Nexus at http:\/\/your-host:3000 on your local network — HTTPS blocks local launcher connections\."\}\);return\}/,
    (_, a, b, c, e, f) => `if(${a}&&!${b}()&&!/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)){${c}("missing"),${e}(!0),${f}({status:"missing-launcher",detail:"To start PC emulators from the website, install the SaveState desktop app (Get the App): browsers can't start programs on this computer."});return}`);
  if (!d.includes("browsers can't start programs on this computer")) throw new Error('patch "launcher notice": anchor not found');
  if (d !== before) writeFileSync(file, d);
}

// 3g. Music: a track that failed (a Drive file still being fetched, a dropped
//     connection) left the player "playing" silence; play() rejections were
//     swallowed. Errors are retried twice from the same point, then the track
//     is skipped with a notice; 15 s of buffering counts as an error.
{
  const file = path.join(assets, find("MusicHub-"));
  let mh = readFileSync(file, "utf8");
  const before = mh;
  mh = patch(mh, "music keeps playing", "__nxBase",
    'o.current.addEventListener("ended",()=>Ne.current()))',
    'o.current.addEventListener("ended",()=>Ne.current()),'
    + 'o.current.addEventListener("error",()=>{const a=o.current;if(!a||!a.__nxBase)return;a.__nxTries=(a.__nxTries||0)+1;const at=a.currentTime||0;'
    + 'if(a.__nxTries<=2){setTimeout(()=>{a.src=a.__nxBase+"&r="+Date.now();a.addEventListener("loadedmetadata",()=>{if(at>1)a.currentTime=at},{once:!0});a.play().catch(()=>{})},1500*a.__nxTries)}'
    + 'else{try{window.__nxNotice&&window.__nxNotice("music-skip","That track wouldn\'t play, so it was skipped.")}catch{}a.__nxBase="";Ne.current()}}),'
    + 'o.current.addEventListener("waiting",()=>{const a=o.current;clearTimeout(a.__nxStall);a.__nxStall=setTimeout(()=>{if(a&&!a.paused&&a.readyState<3)a.dispatchEvent(new Event("error"))},15e3)}),'
    + 'o.current.addEventListener("playing",()=>{clearTimeout(o.current.__nxStall);o.current.__nxTries=0}))');
  mh = patch(mh, "music remembers its source", "o.current.__nxBase=o.current.src",
    ',o.current.play().catch(()=>{}),N(!0),Be(t,!0),zt())',
    ',o.current.__nxBase=o.current.src,o.current.__nxTries=0,o.current.play().catch(r=>{r&&r.name==="NotAllowedError"&&N(!1)}),N(!0),Be(t,!0),zt())');
  mh = patch(mh, "music bar tag", '"nx-music-bar fixed bottom-0 left-0 right-0',
    '"fixed bottom-0 left-0 right-0 bg-[#0a0a14]/95 border-t border-white/10 backdrop-blur-2xl z-50',
    '"nx-music-bar fixed bottom-0 left-0 right-0 bg-[#0a0a14]/95 border-t border-white/10 backdrop-blur-2xl z-50');
  mh = patch(mh, "music admin purge", '"nx-admin-only flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/15 text-white/60 hover:border-amber-500/40',
    '"flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/15 text-white/60 hover:border-amber-500/40',
    '"nx-admin-only flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/15 text-white/60 hover:border-amber-500/40');
  mh = patch(mh, "music admin scan", '"nx-admin-only flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/15 text-white/60 hover:border-cyan-500/40',
    '"flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/15 text-white/60 hover:border-cyan-500/40',
    '"nx-admin-only flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/15 text-white/60 hover:border-cyan-500/40');
  if (mh !== before) writeFileSync(file, mh);
}

// 3h. Video: a fatal network error made hls.js call startLoad() again at once,
//     for ever (the "load loop"), and media errors looped the same way. They
//     are now retried a few times with growing gaps, then the player falls back
//     to its direct stream. Auto quality hopped between 1080p, 720p and 480p,
//     and every hop starts a new transcode on the host (a stutter); it now
//     picks one level for the screen and only steps down after two stalls.
{
  const file = path.join(assets, find("MediaHub-"));
  let mh = readFileSync(file, "utf8");
  const before = mh;
  mh = patch(mh, "video retries with a limit", "a.__nxFixed=!0", "a.on(z.Events.ERROR,(y,I)=>{if(I?.fatal){if(I.type===z.ErrorTypes.NETWORK_ERROR){a.startLoad();return}if(I.type===z.ErrorTypes.MEDIA_ERROR){a.recoverMediaError();return}Re(Math.max(0,Math.floor(t.currentTime||0))),ut(!0)}})", "a.on(z.Events.ERROR,(y,I)=>{const R=a.__nx||(a.__nx={net:0,med:0,medAt:0,stalls:[]});if(!I?.fatal){if(I?.details===z.ErrorDetails.BUFFER_STALLED_ERROR&&a.__nxFixed&&a.currentLevel>0){const now=Date.now();R.stalls=R.stalls.filter(x=>now-x<6e4).concat(now);if(R.stalls.length>=2){R.stalls=[];a.nextLevel=a.currentLevel-1}}return}if(I.type===z.ErrorTypes.NETWORK_ERROR&&R.net<5){R.net++;setTimeout(()=>{try{a.startLoad()}catch{}},Math.min(15e3,1e3*2**(R.net-1)));return}if(I.type===z.ErrorTypes.MEDIA_ERROR&&R.med<3){const now=Date.now();R.med++;if(now-R.medAt<3e3)try{a.swapAudioCodec()}catch{}R.medAt=now;a.recoverMediaError();return}Re(Math.max(0,Math.floor(t.currentTime||0))),ut(!0)}),a.on(z.Events.FRAG_LOADED,()=>{a.__nx&&(a.__nx.net=0)}),a.on(z.Events.MANIFEST_PARSED,()=>{try{if(a.levels.length<2)return;const want=innerWidth<900?720:Math.min(1080,Math.max(720,(window.screen?.height||1080)*(window.devicePixelRatio||1)));let idx=0;a.levels.forEach((l,i)=>{if((l.height||0)<=want&&(l.height||0)>=(a.levels[idx].height||0))idx=i});a.startLevel=idx;a.currentLevel=idx;a.__nxFixed=!0}catch{}})");
  if (mh !== before) writeFileSync(file, mh);
}

// 3i. eBooks: the shelf stayed on a spinner until a cover lookup finished
//     (about 7 s), though the books had arrived in one; the lookup also ran
//     again on every focus and every 5 minutes. Books show at once and covers
//     are looked up once per visit. Cards are tagged for the book look in
//     the boot stylesheet (spine, page edges, lift on hover).
{
  const file = path.join(assets, find("CodexLibrary-"));
  let cx = readFileSync(file, "utf8");
  const before = cx;
  cx = patch(cx, "books show at once", "window.__nxCodexEnriched",
    "if(i(J(t)),t.some(c=>!c.coverUrl)&&",
    "if(i(J(t)),r(!1),!window.__nxCodexEnriched&&(window.__nxCodexEnriched=1)&&t.some(c=>!c.coverUrl)&&");
  cx = patch(cx, "book card look", '"nx-book relative overflow-hidden rounded-xl shadow-2xl aspect-[2/3]"',
    '"relative overflow-hidden rounded-xl shadow-2xl aspect-[2/3]"',
    '"nx-book relative overflow-hidden rounded-xl shadow-2xl aspect-[2/3]"');
  if (cx !== before) writeFileSync(file, cx);
}

// 3j. Big Picture (Console Vault): opened filtered to the first console
//     alphabetically (3DS, 2 games), showed template text ("an iconic
//     Nintendo experience...") as every game's description, had only a faint
//     blur behind the hero, and let the page underneath show through at the
//     bottom. It opens on all games, shows the real description (or none),
//     the game's art as the backdrop with a large cover, above everything.
{
  const file = path.join(assets, find("ConsoleHub-"));
  let ch = readFileSync(file, "utf8");
  const before = ch;
  ch = patch(ch, "big picture starts on all", "/*nx-all*/", "c[0]&&j(c[0]),", "/*nx-all*/");
  ch = patch(ch, "big picture starts on all (2)", "/*nx-all2*/", "b[0]&&j(b[0]),", "/*nx-all2*/");
  ch = patch(ch, "big picture real description", 'const q=i?(i.metadata?.description||i.description||""):""',
    'const q=i?vt(i):""', 'const q=i?(i.metadata?.description||i.description||""):""');
  ch = patch(ch, "big picture hides empty description", 'children:i.title}),q&&(0,e.jsx)("p",{className:"text-xs md:text-sm text-white/60 line-clamp-3',
    'children:i.title}),(0,e.jsx)("p",{className:"text-xs md:text-sm text-white/60 line-clamp-3',
    'children:i.title}),q&&(0,e.jsx)("p",{className:"text-xs md:text-sm text-white/60 line-clamp-3');
  ch = patch(ch, "big picture above the page", '"nx-bp fixed inset-0 z-50 flex flex-col bg-[#05050a]',
    '"fixed inset-0 z-50 flex flex-col bg-[#05050a]', '"nx-bp fixed inset-0 z-50 flex flex-col bg-[#05050a]');
  ch = patch(ch, "big picture art", '"nx-bp-cover"',
    'className:"absolute inset-0 w-full h-full object-cover pointer-events-none filter blur-3xl scale-125"},i.id):null}),',
    'className:"absolute inset-0 w-full h-full object-cover pointer-events-none filter blur-3xl scale-125"},i.id):null}),i?.boxArt?(0,e.jsx)("img",{src:i.boxArt,alt:"",className:"nx-bp-cover"},i.id+"-cover"):null,');
  ch = patch(ch, "big picture stronger backdrop", "/*nx-bp-bg*/animate:{opacity:.45}", "animate:{opacity:.22}", "/*nx-bp-bg*/animate:{opacity:.45}");
  // The first game was only picked when the console filter changed, which
  // forcing the first console used to do; now it follows the list itself.
  ch = patch(ch, "big picture picks the first game", "||m(C[0])},[F,z,C])", "||m(C[0])},[F,z])", "||m(C[0])},[F,z,C])");
  // Big Picture treated every browser that wasn't the Android app as the
  // host, so a member's Play started the emulator on the host's PC
  // (2026-10-15). It now uses the app's own client test: any browser not on
  // the host's own address is a client and plays on its own device.
  ch = patch(ch, "big picture knows clients", "O as nxClientMode,",
    "j as pt,", "j as pt,O as nxClientMode,");
  ch = patch(ch, "big picture plays on the client", "R=(0,s.useMemo)(()=>!(pt()||nxClientMode()),[])",
    'R=(0,s.useMemo)(()=>!(pt()||(typeof localStorage<"u"?localStorage.getItem("nexus_setup_role"):null)==="client"),[])',
    "R=(0,s.useMemo)(()=>!(pt()||nxClientMode()),[])");
  // ?tab=consoles&bp=1 opens straight into Big Picture: the Sunshine entry
  // (Moonlight on a phone) and TV shortcuts land on the couch view.
  ch = patch(ch, "big picture from a link", '[F,j]=(0,s.useState)(()=>{try{return new URLSearchParams(location.search).get("bp")==="1"}catch{return!1}})',
    "[F,j]=(0,s.useState)(!1)", '[F,j]=(0,s.useState)(()=>{try{return new URLSearchParams(location.search).get("bp")==="1"}catch{return!1}})');
  // A member pressing Play on a PS2 or GameCube game without the desktop
  // launcher had the whole disc image downloaded into the browser, which
  // then can't run it. Say what to do instead, before downloading anything.
  const touch = find("touchLayouts-");
  ch = patch(ch, "big picture knows browser systems", "nxCanBrowser}from",
    'import{t as bt}from"./EmulatorPlayer-', `import{s as nxCanBrowser}from"./${touch}";import{t as bt}from"./EmulatorPlayer-`);
  ch = patch(ch, "big picture heavy games need the app", "!nxCanBrowser(d.platform)",
    "onLaunch:async t=>{const d=l.find(n=>n.id===t);d&&(R?",
    "onLaunch:async t=>{const d=l.find(n=>n.id===t);if(d&&!R&&!re.has(d.id)&&!nxCanBrowser(d.platform)&&!await _())throw new Error(`${String(d.platform).toUpperCase()} can't run in a browser. On a PC, install the SaveState desktop app once (Get the App); on a phone, open the game in Games and choose Stream from the host PC.`);d&&(R?");
  // Big Picture knew each game only by id, so a downloaded ROM was saved as
  // roms/<platform>/<id> (no name, no extension) and handed to the player
  // without one. Arcade emulators find the game by its file name (mslugx.zip)
  // and answered "Romset is unknown"; RetroArch can't pick a core without the
  // extension. The library's real file name now travels with each game.
  ch = patch(ch, "big picture keeps file names", "coverUrl:u.box_art??u.boxArt??null,fileName:",
    "coverUrl:u.box_art??u.boxArt??null}",
    'coverUrl:u.box_art??u.boxArt??null,fileName:String(u.relativePath??u.relative_path??"").split(String.fromCharCode(92)).join("/").split("/").pop()}');
  ch = patch(ch, "big picture caches under the file name", "relativePath:`roms/${t.platform}/${t.fileName||t.id}`",
    "relativePath:`roms/${t.platform}/${t.id}`", "relativePath:`roms/${t.platform}/${t.fileName||t.id}`");
  ch = patch(ch, "big picture launches the named file", "relativePath:`roms/${a.platform}/${a.fileName||a.id}`,fileName:a.fileName",
    "relativePath:`roms/${a.platform}/${a.id}`", "relativePath:`roms/${a.platform}/${a.fileName||a.id}`,fileName:a.fileName");
  if (ch !== before) writeFileSync(file, ch);
}

// 3k. Game details on a member's PC. In a browser on https the panel declared
//     "desktop app missing" without asking the launcher (Chrome and Edge can
//     reach 127.0.0.1 from https), so the one-click launcher never counted.
//     Without it, "Play on this PC" was still marked Recommended for a GBA
//     game that plays right here, the working option sat second, and members
//     were shown the host's emulator-core status with an "Install Core & Play"
//     button for the host. Now the launcher is asked; when it isn't there,
//     "Play in this browser" comes first and is recommended for systems a
//     browser can run; host-only core controls are hidden from members; and
//     the cover shrinks on short screens so the choices are on screen.
{
  const file = path.join(assets, find("ExpandableDetail-"));
  let gd = readFileSync(file, "utf8");
  const before = gd;
  const BROWSER_FIRST = "!f&&y&&ue&&be(t.platform)";
  gd = patch(gd, "game details asks the launcher", "if(!1&&bs&&!Rt()",
    "if(bs&&!Rt()", "if(!1&&bs&&!Rt()");
  gd = patch(gd, "game details explains a missing launcher", "Ready to play in this browser.",
    'detail:"Client launcher not running on this machine."',
    'detail:be(t.platform)?"Ready to play in this browser. For full speed and offline play, install the SaveState desktop app once (Get the App).":"Full-speed play on this PC needs the SaveState desktop app (Get the App, a one-time install). Until then, stream it from the host."');
  // On a phone that note talked about "this PC" and the desktop app.
  gd = patch(gd, "game details note on phones", "Plays right here on this phone",
    'detail:be(t.platform)?"Ready to play in this browser.',
    'detail:f?(be(t.platform)?"Plays right here on this phone, with touch controls.":`${(t.platform??"This system").toUpperCase()} is too heavy for a phone: choose Stream from the host PC and play it in Moonlight.`):be(t.platform)?"Ready to play in this browser.');
  gd = patch(gd, "game details hides host core status", '!f&&!y&&K&&K!=="unknown"&&', '!f&&K&&K!=="unknown"&&', '!f&&!y&&K&&K!=="unknown"&&');
  gd = patch(gd, "game details hides host core install", '!f&&!y&&K==="missing"&&!P&&', '!f&&K==="missing"&&!P&&', '!f&&!y&&K==="missing"&&!P&&');
  gd = patch(gd, "game details play options order", '"nx-playopts rounded-2xl',
    '"rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-2",children:[(0,e.jsx)("p",{className:"text-[10px] font-black uppercase tracking-widest text-nexus-muted px-0.5",children:"How do you want to play?"})',
    '"nx-playopts rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-2",children:[(0,e.jsx)("p",{className:"text-[10px] font-black uppercase tracking-widest text-nexus-muted px-0.5",children:"How do you want to play?"})');
  gd = patch(gd, "game details recommends what works (PC)", `&&!(${BROWSER_FIRST})&&(0,e.jsx)("span",{className:"text-[8.5px]`,
    '!(f&&!be(t.platform))&&(0,e.jsx)("span",{className:"text-[8.5px]',
    `!(f&&!be(t.platform))&&!(${BROWSER_FIRST})&&(0,e.jsx)("span",{className:"text-[8.5px]`);
  gd = patch(gd, "game details recommends what works (browser)", "nx-first ",
    'className:"w-full text-left px-3 py-2.5 rounded-xl border border-blue-500/25',
    `className:(${BROWSER_FIRST}?"nx-first ":"")+"w-full text-left px-3 py-2.5 rounded-xl border border-blue-500/25`);
  gd = patch(gd, "game details browser badge", '"Play in this browser",',
    '(0,e.jsx)("span",{className:"block text-[12px] font-bold text-blue-200",children:"Play in this browser"})',
    `(0,e.jsxs)("span",{className:"block text-[12px] font-bold text-blue-200",children:["Play in this browser",${BROWSER_FIRST}&&(0,e.jsx)("span",{className:"ml-2 text-[8.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-400/25 text-blue-100",children:"Recommended"})]})`);
  gd = patch(gd, "game details cover fits", '"nx-detail-cover w-full aspect-[3/4]',
    '"w-full aspect-[3/4] object-cover rounded-2xl shadow-2xl mb-8 border border-white/10"',
    '"nx-detail-cover w-full aspect-[3/4] object-cover rounded-2xl shadow-2xl mb-8 border border-white/10"');
  // "Stream from the host PC" starts the game on the host; the picture and the
  // controls travel through Sunshine and the Moonlight app (the site's own
  // JPEG feed is too slow for games). It said "streams the picture here" and
  // then "enjoy!", leaving someone on a phone elsewhere looking at nothing.
  gd = patch(gd, "stream option names Moonlight", "you see and play it in the free Moonlight app",
    '"Runs on the host and streams the picture here. Needs a steady connection."',
    '"Runs on the host PC; you see and play it in the free Moonlight app (Help & guides). Needs a steady connection."');
  gd = patch(gd, "stream option on phones names Moonlight", "the host runs it and the Moonlight app shows it here",
    '`The only way to play ${(t.platform??"this system").toUpperCase()} on a phone — the host runs the real emulator.`',
    '`The way to play ${(t.platform??"this system").toUpperCase()} on a phone: the host runs it and the Moonlight app shows it here.`');
  gd = patch(gd, "stream start tells where to look", "open Moonlight on this device",
    "c({text:`${l} is running — enjoy!`,success:!0})",
    "c({text:y?`${l} is running on the host PC — open Moonlight on this device and choose SaveState or Desktop to play it.`:`${l} is running — enjoy!`,success:!0})");
  // On a PC, "stream from the host" read "the only way to play PSP on a phone".
  gd = patch(gd, "game details stream wording on a PC", 'children:be(t.platform)||!f?"Runs on the host',
    'children:be(t.platform)?"Runs on the host', 'children:be(t.platform)||!f?"Runs on the host');
  if (gd !== before) writeFileSync(file, gd);
}

// 3l. In-browser play never started (GBA: "loaded but isn't running", no
//     frames). EmulatorJS fetches EJS_biosUrl as one file, and it was given
//     the BIOS folder with no file name, which 404s; EmulatorJS stops with
//     "Network Error" before it requests the ROM. Only systems that need a
//     BIOS ask for one, by name, and only when the host has it. The cloud
//     save is likewise loaded only when there is one.
{
  const file = path.join(assets, find("EmulatorPlayer-"));
  let ep = readFileSync(file, "utf8");
  const before = ep;
  ep = patch(ep, "browser play bios by name", "const nxBios=",
    'let d=`${a}/api/emulator/bios/serve/${t?`?token=${encodeURIComponent(t)}`:""}`;',
    'const nxBios={psx:"scph5501.bin",segaCD:"bios_CD_U.bin",neogeo:"neogeo.zip",arcade:"neogeo.zip",fbneo:"neogeo.zip"}[b],nxOk=async u=>{try{return(await fetch(u,{method:"HEAD"})).ok}catch{return!1}};let d=nxBios?`${a}/api/emulator/bios/serve/${nxBios}${t?`?token=${encodeURIComponent(t)}`:""}`:"";d&&!await nxOk(d)&&(d="");');
  // A downloaded copy (blob: address) has no file name, so EmulatorJS called
  // every such game "game": arcade sets weren't recognised and all of them
  // shared one save name. It gets the game's real file name (only for blob:
  // addresses, so saves of games loaded by URL keep their names).
  ep = patch(ep, "browser play names downloaded games", "window.EJS_gameName=",
    "window.EJS_gameUrl=s,",
    'window.EJS_gameUrl=s,String(s).startsWith("blob:")&&(window.EJS_gameName=r.fileName||String(r.relative_path||r.relativePath||"").split(String.fromCharCode(92)).join("/").split("/").pop()||void 0),');
  ep = patch(ep, "browser play forgets the name", '"EJS_biosUrl","EJS_gameName",', '"EJS_biosUrl",', '"EJS_biosUrl","EJS_gameName",');
  ep = patch(ep, "browser play bios only when set", "d&&(window.EJS_biosUrl=d),",
    "window.EJS_biosUrl=d,", "d&&(window.EJS_biosUrl=d),");
  // Neo Geo and Sega CD can't start without theirs: say so instead of a black screen.
  ep = patch(ep, "browser play names a missing bios", "/*nx-need-bios*/",
    "d&&(window.EJS_biosUrl=d),",
    '/*nx-need-bios*/if(!d&&nxBios&&/neogeo|neo geo|segacd|sega cd/i.test(String(r.platform))){J(!1),Q(!0),g(`${String(r.platform).toUpperCase()} games need the system BIOS (${nxBios}) to run in a browser, and this server doesn\'t have it yet. Stream it from the host instead, or ask the host to add it under Emulation Setup → BIOS.`);return}d&&(window.EJS_biosUrl=d),');
  ep = patch(ep, "browser play cloud save only when saved", "nxState=",
    'window.EJS_loadStateURL=`${a}/api/emulator/savestates/${encodeURIComponent(r.id)}/cloud?token=${encodeURIComponent(t)}`;',
    'window.EJS_loadStateURL=void 0;const nxState=`${a}/api/emulator/savestates/${encodeURIComponent(r.id)}/cloud?token=${encodeURIComponent(t)}`;await nxOk(nxState)&&(window.EJS_loadStateURL=nxState);');
  if (ep !== before) writeFileSync(file, ep);
}
// Neo Geo and arcade sets were mapped to fbalpha2012, which the EmulatorJS
// CDN no longer publishes, so the player refused them; FBNeo plays them.
{
  const file = path.join(assets, find("touchLayouts-"));
  let tl = readFileSync(file, "utf8");
  const before = tl;
  tl = patch(tl, "arcade plays on fbneo", 'arcade:"fbneo",mame:"mame2003",neogeo:"fbneo"',
    'arcade:"fbalpha2012",mame:"mame2003",neogeo:"fbalpha2012","neo geo":"fbalpha2012"',
    'arcade:"fbneo",mame:"mame2003",neogeo:"fbneo","neo geo":"fbneo"');
  if (tl !== before) writeFileSync(file, tl);
}

// 3b. Movies & TV showed every member the host's own controls (media root
//     picker, rescan, the metadata scraper), which only admins can use. They
//     are tagged here and hidden for everyone else by the boot script's CSS.
{
  const file = path.join(assets, find("MediaHub-"));
  let hub = readFileSync(file, "utf8");
  const before = hub;
  hub = patch(hub, "media root is admin-only", `className:"space-y-2 nx-admin-only",children:[(0,e.jsx)(Ln,{value:he,onChange:Je,placeholder:"Media root on host..."`,
    `className:"space-y-2",children:[(0,e.jsx)(Ln,{value:he,onChange:Je,placeholder:"Media root on host..."`,
    `className:"space-y-2 nx-admin-only",children:[(0,e.jsx)(Ln,{value:he,onChange:Je,placeholder:"Media root on host..."`);
  const scraper = `to-black/40 p-4 md:p-5",children:[(0,e.jsxs)("div",{className:"flex items-start justify-between gap-3 flex-wrap",children:[(0,e.jsxs)("div",{className:"space-y-1.5 max-w-2xl",children:[(0,e.jsx)("p",{className:"text-[10px] font-black uppercase tracking-[0.24em] text-cyan-300",children:"Gemini Media Scraper"`;
  hub = patch(hub, "scraper is admin-only", scraper.replace(`p-4 md:p-5"`, `p-4 md:p-5 nx-admin-only"`), scraper, scraper.replace(`p-4 md:p-5"`, `p-4 md:p-5 nx-admin-only"`));
  if (hub !== before) writeFileSync(file, hub);
}

// 3c. The product is SaveState (savestate.co.za); the compiled app still
//     called itself NexusEmu. Only display text changes: a name followed by a
//     letter, "/", "\" or "-" is an identifier, folder or file name
//     (NexusEmuDesktop in a user-agent test, NexusEmu/bios on Android,
//     F:\NexusEmu\Games, NexusEmu-update.apk) and is left alone, as are the
//     virtual gamepad ids ("NexusEmu Remote P1") and log prefixes.
const BRAND = "SaveState";
const rebrand = (text) => text
  .replace(/Nexus Emu(?![A-Za-z])/g, BRAND)
  .replace(/NexusEmu(?![A-Za-z0-9/\\\-_]| Remote P|\])/g, BRAND);
for (const f of readdirSync(assets).filter((x) => x.endsWith(".js"))) {
  const file = path.join(assets, f);
  const text = readFileSync(file, "utf8");
  const next = rebrand(text);
  if (next !== text) writeFileSync(file, next);
}
for (const f of ["index.html", "manifest.webmanifest"]) {
  const file = path.join(dist, f);
  const text = readFileSync(file, "utf8");
  const next = rebrand(text);
  if (next !== text) writeFileSync(file, next);
}

// 3d. The player forgot volume, mute and playback speed between videos and
//     visits (speed was reset to 1x on every episode). They are kept now.
{
  const file = path.join(assets, find("MediaHub-"));
  let hub = readFileSync(file, "utf8");
  const before = hub;
  const num = (key, dflt) => `(()=>{try{const v=parseFloat(localStorage.getItem("${key}"));return Number.isFinite(v)&&v>0?v:${dflt}}catch{return ${dflt}}})()`;
  hub = patch(hub, "player remembers volume", `[Ke,qt]=(0,r.useState)(()=>${num("nexus_volume", 1)})`,
    "[Ke,qt]=(0,r.useState)(1)", `[Ke,qt]=(0,r.useState)(()=>${num("nexus_volume", 1)})`);
  hub = patch(hub, "player remembers mute", `[We,qe]=(0,r.useState)(()=>{try{return localStorage.getItem("nexus_muted")==="1"}catch{return!1}})`,
    "[We,qe]=(0,r.useState)(!1)", `[We,qe]=(0,r.useState)(()=>{try{return localStorage.getItem("nexus_muted")==="1"}catch{return!1}})`);
  hub = patch(hub, "player remembers speed", `[ge,ke]=(0,r.useState)(()=>${num("nexus_playback_rate", 1)})`,
    "[ge,ke]=(0,r.useState)(1)", `[ge,ke]=(0,r.useState)(()=>${num("nexus_playback_rate", 1)})`);
  hub = patch(hub, "speed kept between episodes", `Z(0),ke(${num("nexus_playback_rate", 1)}),`, "Z(0),ke(1),", `Z(0),ke(${num("nexus_playback_rate", 1)}),`);
  hub = patch(hub, "player saves volume and speed", "nexus_playback_rate\",String(ge))",
    "t&&(t.volume=Math.max(0,Math.min(1,Ke)),t.muted=We)},[Ke,We])",
    't&&(t.volume=Math.max(0,Math.min(1,Ke)),t.muted=We);try{localStorage.setItem("nexus_volume",String(Ke));localStorage.setItem("nexus_muted",We?"1":"0");localStorage.setItem("nexus_playback_rate",String(ge))}catch{}},[Ke,We,ge])');
  if (hub !== before) writeFileSync(file, hub);
}

// 4. index.html loads the boot script ahead of the app.
{
  const file = path.join(dist, "index.html");
  let html = readFileSync(file, "utf8").replace(/\s*<script type="module" crossorigin src="\/assets\/NexusBoot-r\d+\.js"><\/script>/g, "");
  const tag = `<script type="module" crossorigin src="/assets/${bootOut}"></script>`;
  const at = html.indexOf('<script type="module"');
  if (at < 0) throw new Error("index.html: no module script to load the boot script ahead of");
  html = html.slice(0, at) + tag + "\n    " + html.slice(at);
  writeFileSync(file, html);
}

// 5. Every chunk must still parse. A patch that lands mid-expression (a
//    `const` after a comma) broke the whole site once (2026-10-15); stop here
//    instead of publishing it.
for (const f of readdirSync(assets).filter((n) => n.endsWith(".js"))) {
  try {
    esbuild.transformSync(readFileSync(path.join(assets, f), "utf8"), { format: "esm", loader: "js", logLevel: "silent" });
  } catch (err) {
    throw new Error(`${f} no longer parses: ${String(err?.errors?.[0]?.text ?? err?.message ?? err)}`);
  }
}

const kb = (f) => (readFileSync(path.join(assets, f)).length / 1024).toFixed(1);
console.log(`built ${appOut} (${kb(appOut)} KB) and ${bootOut} (${kb(bootOut)} KB); wired into ${shellFile}, AuthForm, MusicHub and index.html`);
