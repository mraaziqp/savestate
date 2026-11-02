#!/usr/bin/env node
// Builds SaveState for Windows as a native app (Tauri, src-tauri/) and
// publishes its installer as releases/updates/SaveState-Setup-<version>.exe,
// which /api/downloads/desktop?platform=windows serves.
//
//   node scripts/windows/build-desktop.mjs
//
// Needs Rust (MSVC toolchain) and Visual Studio Build Tools with the C++
// workload. Node.js for the bundled launcher comes from nodejs.org, checked
// against its published SHA-256. The version is package.json's.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tauriDir = path.join(root, "src-tauri");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

// 1. The app's version follows package.json.
const confPath = path.join(tauriDir, "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
const cargoPath = path.join(tauriDir, "Cargo.toml");
writeFileSync(cargoPath, readFileSync(cargoPath, "utf8").replace(/^version = "[^"]*"/m, `version = "${version}"`));

// 2. Node.js 22 for Windows, official and checksum-verified (kept between builds).
const nodeOut = path.join(tauriDir, "resources", "node.exe");
if (!existsSync(nodeOut)) {
  const rel = "https://nodejs.org/dist/latest-v22.x";
  const sums = await (await fetch(`${rel}/SHASUMS256.txt`)).text();
  const line = sums.split("\n").find((l) => / node-v[\d.]+-win-x64\.zip$/.test(l));
  if (!line) throw new Error("nodejs.org lists no win-x64 zip");
  const [want, file] = line.trim().split(/\s+/);
  const zip = Buffer.from(await (await fetch(`${rel}/${file}`)).arrayBuffer());
  const got = createHash("sha256").update(zip).digest("hex");
  if (got !== want) throw new Error(`Node.js checksum mismatch for ${file}`);
  const { default: AdmZip } = await import("adm-zip");
  const entry = new AdmZip(zip).getEntries().find((e) => /\/node\.exe$/.test(e.entryName));
  if (!entry) throw new Error(`no node.exe in ${file}`);
  mkdirSync(path.dirname(nodeOut), { recursive: true });
  writeFileSync(nodeOut, entry.getData());
  console.log(`Node.js: ${file} (checksum matches)`);
}

// 3. Icons from the site's own icon.
if (!existsSync(path.join(tauriDir, "icons", "icon.ico"))) {
  execFileSync("npx", ["tauri", "icon", path.join(root, "dist", "pwa-512x512.png"), "-o", path.join(tauriDir, "icons")], { cwd: root, stdio: "inherit", shell: true });
}

// 4. Build.
execFileSync("npx", ["tauri", "build", "--bundles", "nsis"], { cwd: root, stdio: "inherit", shell: true });

// 5. Publish.
const nsisDir = path.join(tauriDir, "target", "release", "bundle", "nsis");
const built = readdirSync(nsisDir).filter((f) => f.endsWith(".exe") && f.includes(version)).sort((a, b) => statSync(path.join(nsisDir, b)).mtimeMs - statSync(path.join(nsisDir, a)).mtimeMs)[0];
if (!built) throw new Error(`no NSIS installer for ${version} in ${nsisDir}`);
const out = path.join(root, "releases", "updates", `SaveState-Setup-${version}.exe`);
mkdirSync(path.dirname(out), { recursive: true });
copyFileSync(path.join(nsisDir, built), out);
console.log(`Published ${out} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
