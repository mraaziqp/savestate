#!/usr/bin/env node
// Builds Discover + What to Watch into dist/assets/NexusWatch-<rev>.js.
//
//   node web-src/watch/build.mjs
//
// The rest of the frontend only exists as the compiled bundle in dist/ (the
// Vite sources were lost), so this module plugs into it rather than being
// built with it: React and the jsx runtime come from the bundle's own vendor
// chunks (found by reading how DiscoverFeed imports them, so a future
// rev-dist rename does not break this script), and the app shell's lazy
// imports for the Discover and What to Watch tabs are pointed at the output.
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const assets = path.join(root, "dist", "assets");
const esbuild = createRequire(path.join(root, "package.json"))("esbuild");

const files = readdirSync(assets);
const find = (prefix) => {
  const f = files.find((x) => x.startsWith(prefix) && x.endsWith(".js"));
  if (!f) throw new Error(`no ${prefix}*.js in dist/assets`);
  return f;
};
const oldDiscover = find("DiscoverFeed-");
const rev = /-(r\d+)\.js$/.exec(oldDiscover)?.[1] ?? "r0";

// How the compiled chunks get React: `var a=ft(gt(),1)` with ft and gt imported.
const df = readFileSync(path.join(assets, oldDiscover), "utf8");
const m = /var (\w+)=(\w+)\((\w+)\(\),1\)/.exec(df);
if (!m) throw new Error("could not find React import pattern in DiscoverFeed");
const importOf = (local) => {
  const re = new RegExp(`import\\{([^}]*)\\}from"\\./([^"]+)"`, "g");
  for (const im of df.matchAll(re)) {
    for (const spec of im[1].split(",")) {
      const [exp, , loc] = spec.trim().split(/\s+/);
      if ((loc ?? exp) === local) return { exp, file: im[2] };
    }
  }
  throw new Error(`no import for ${local}`);
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
const oldDiscoverModule = `export const loadOldDiscover = () => import("./${oldDiscover}");`;

const out = `NexusWatch-${rev}.js`;
await esbuild.build({
  entryPoints: [path.join(here, "index.jsx")],
  bundle: true, format: "esm", minify: true, target: "es2020",
  jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment",
  outfile: path.join(assets, out), legalComments: "none",
  plugins: [{
    name: "host-bundle",
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "host" }));
      b.onResolve({ filter: /^old-discover$/ }, () => ({ path: "old-discover", namespace: "host" }));
      b.onResolve({ filter: /^\.\/[\w-]+\.js$/, namespace: "host" }, (a) => ({ path: a.path, external: true }));
      b.onLoad({ filter: /.*/, namespace: "host" }, (a) => ({
        contents: a.path === "react" ? reactModule : oldDiscoverModule, loader: "js", resolveDir: here,
      }));
    },
  }],
});
for (const f of readdirSync(assets)) if (/^NexusWatch-r\d+\.js$/.test(f) && f !== out) unlinkSync(path.join(assets, f));

// Point the app shell's two tabs at the new module (idempotent).
const indexFile = find("index-");
let idx = readFileSync(path.join(assets, indexFile), "utf8");
const before = idx;
idx = idx.replace(/import\("\.\/(?:Matchmaker-[\w-]+|NexusWatch-r\d+)\.js"\)\.then\(t=>\(\{default:t\.(?:Matchmaker|WhatToWatch)\}\)\)/,
  `import("./${out}").then(t=>({default:t.WhatToWatch}))`);
idx = idx.replace(/import\("\.\/(?:DiscoverFeed-[\w-]+|NexusWatch-r\d+)\.js"\)\.then\(t=>\(\{default:t\.(?:DiscoverFeed|DiscoverHub)\}\)\)/,
  `import("./${out}").then(t=>({default:t.DiscoverHub}))`);
if (!idx.includes(`t.WhatToWatch`) || !idx.includes(`t.DiscoverHub`)) throw new Error("could not wire the tabs in " + indexFile);
if (idx !== before) writeFileSync(path.join(assets, indexFile), idx);
console.log(`built dist/assets/${out} (${(readFileSync(path.join(assets, out)).length / 1024).toFixed(1)} KB); tabs wired in ${indexFile}`);
