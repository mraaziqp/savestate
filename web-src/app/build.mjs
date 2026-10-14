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
shell = patch(shell, "cloud is admin-only in the menu", `brain:"manage_system",cloud:"manage_system"}`,
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
shell = patch(shell, "profiles title", `ql={household:"Profiles",cloud:"Cloud Drives",`, `ql={cloud:"Cloud Drives",`, `ql={household:"Profiles",cloud:"Cloud Drives",`);
shell = patch(shell, "profile menu filter", `C=(0,s.useCallback)(m=>{if(window.__nxAllow&&!window.__nxAllow.has(m))return!1;if(Mr.has(m))return y;`,
  `C=(0,s.useCallback)(m=>{if(Mr.has(m))return y;`, `C=(0,s.useCallback)(m=>{if(window.__nxAllow&&!window.__nxAllow.has(m))return!1;if(Mr.has(m))return y;`);
{
  const head = `className:"w-full flex items-center justify-between px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.2em] text-white/35 hover:text-white/60 transition-colors",children:[(0,e.jsx)("span",{children:`;
  shell = patch(shell, "empty games heading", `style:x.length?void 0:{display:"none"},${head}"Games"`, `${head}"Games"`, `style:x.length?void 0:{display:"none"},${head}"Games"`);
  shell = patch(shell, "empty tools heading", `style:A.length?void 0:{display:"none"},${head}"System & Tools"`, `${head}"System & Tools"`, `style:A.length?void 0:{display:"none"},${head}"System & Tools"`);
}
shell = patch(shell, "profile bottom bar", `As.filter(m=>!window.__nxAllow||window.__nxAllow.has(m.id)).map(m=>{const c=t===m.id;`,
  `As.map(m=>{const c=t===m.id;`, `As.filter(m=>!window.__nxAllow||window.__nxAllow.has(m.id)).map(m=>{const c=t===m.id;`);

// Tabs the menu offers but deep links (?tab=) and in-app navigation refused.
shell = patch(shell, "known tabs", `"matchmaker","music","multiplayer","remoteplay","ai"`,
  `"cloud","phonebackup","matchmaker"]`, `"cloud","phonebackup","matchmaker","music","multiplayer","remoteplay","ai"]`);
shell = patch(shell, "profiles tab is known", `"remoteplay","ai","household"]`, `"remoteplay","ai"]`, `"remoteplay","ai","household"]`);

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
  const order = ["media", "matchmaker", "discover", "music", "codex", "party", "torrent", "gallery", "photos", "myfiles", "files", "cloud", "phonebackup", "hosts", "friends", "household", "plans"];
  const rank = (s) => { const i = order.indexOf(idOf(s)); return i < 0 ? order.length : i; };
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
  if (sorted.length !== items.length) throw new Error('patch "menu order": lost an item');
  shell = shell.replace(mArr[0], `pn=[${sorted.join(",")}],fn=[`);
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
  const re = /\/api\/media\/(?:file|stream|hls\/playlist\.m3u8)\?rel=\$\{encodeURIComponent\([\w.]+\)\}(?!\$\{\(\(\)=>)/g;
  const next = hub.replace(re, (all) => all + tok);
  if (!next.includes("&token=")) throw new Error(`patch "media token": media URLs not found in ${chunk}`);
  if (next !== hub) writeFileSync(file, next);
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

const kb = (f) => (readFileSync(path.join(assets, f)).length / 1024).toFixed(1);
console.log(`built ${appOut} (${kb(appOut)} KB) and ${bootOut} (${kb(bootOut)} KB); wired into ${shellFile}, AuthForm, MusicHub and index.html`);
