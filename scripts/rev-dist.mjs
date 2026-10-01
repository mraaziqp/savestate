#!/usr/bin/env node
// Give every JS/CSS file in dist/assets a new name after hand-patching the
// compiled frontend, and rewrite every reference to them.
//
//   node scripts/rev-dist.mjs r2
//
// Why: dist/ is the only copy of the frontend (the Vite sources were lost), so
// fixes are made to the built files directly. Those files are served
// "immutable, max-age=1y" and Cloudflare caches them too, so a file patched in
// place never reaches anyone who has visited before. New names force a fresh
// fetch. ALL of them are renamed, not only the patched ones: the chunks import
// each other, and a browser mixing an old cached chunk with a new one would
// load two copies of the app's modules.
//
// The argument is the revision tag; a previous "-rN" tag is replaced, never
// stacked. Also updates dist/index.html, the other pages in dist/, and the
// service worker's precache list (url + revision).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tag = process.argv[2];
if (!/^r\d+$/.test(tag ?? "")) {
  console.error("usage: node scripts/rev-dist.mjs r<N>   (e.g. r2)");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const assets = path.join(dist, "assets");

const renamed = new Map();
for (const f of readdirSync(assets)) {
  const m = /^(.*?)(?:-r\d+)?\.(js|mjs|css)$/.exec(f);
  if (!m) continue;
  const next = `${m[1]}-${tag}.${m[2]}`;
  if (next !== f) renamed.set(f, next);
}
if (!renamed.size) { console.log("nothing to rename"); process.exit(0); }

// Longest first, so no name is replaced inside a longer one.
const order = [...renamed.keys()].sort((a, b) => b.length - a.length);
const rewrite = (text) => {
  for (const from of order) if (text.includes(from)) text = text.split(from).join(renamed.get(from));
  return text;
};

const textFiles = [
  ...readdirSync(assets).filter((f) => /\.(js|mjs|css)$/.test(f)).map((f) => path.join(assets, f)),
  ...readdirSync(dist).filter((f) => /\.(html|js|webmanifest)$/.test(f)).map((f) => path.join(dist, f)),
];
let touched = 0;
for (const file of textFiles) {
  const before = readFileSync(file, "utf8");
  const after = rewrite(before);
  if (after !== before) { writeFileSync(file, after); touched++; }
}
for (const [from, to] of renamed) renameSync(path.join(assets, from), path.join(assets, to));

// Service worker precache: every entry gets the md5 of its current content,
// so returning visitors' service workers fetch the new files.
const swPath = path.join(dist, "sw.js");
if (existsSync(swPath)) {
  let sw = readFileSync(swPath, "utf8");
  let revs = 0;
  sw = sw.replace(/\{url:"([^"]+)",revision:(null|"[^"]*")\}/g, (all, url, _rev) => {
    const p = path.join(dist, url);
    if (!existsSync(p)) return all;
    revs++;
    return `{url:"${url}",revision:"${createHash("md5").update(readFileSync(p)).digest("hex")}"}`;
  });
  writeFileSync(swPath, sw);
  console.log(`service worker: ${revs} precache entries re-hashed`);
}
console.log(`renamed ${renamed.size} files to *-${tag}, rewrote references in ${touched} files`);
