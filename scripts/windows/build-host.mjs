#!/usr/bin/env node
// Packs SaveState Host for Windows: the web app and server (dist/), the host
// runner (host/host.mjs, which starts SaveState's own PostgreSQL) and the
// production node_modules, as releases/updates/SaveState-Host-<version>.zip
// with a .json beside it (sha256, size). scripts/install-host.ps1 downloads
// it; Node.js and ffmpeg come from their own sites at install time, so this
// stays small.
//
//   node scripts/windows/build-host.mjs        (build the server and site first)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const PG = "17.11.0-beta.19"; // PostgreSQL 17.11 (the package's own numbering)
const stage = path.join(root, "releases", "host-stage");
const outDir = path.join(root, "releases", "updates");
const zip = path.join(outDir, `SaveState-Host-${version}.zip`);

if (!existsSync(path.join(root, "dist", "server.mjs"))) throw new Error("dist/server.mjs is missing: build the server first");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. The site and server. Not the Windows launcher bundle or old server copies.
cpSync(path.join(root, "dist"), path.join(stage, "dist"), {
  recursive: true,
  filter: (src) => { const b = path.basename(src); return !(b === "windows-host" || b.endsWith(".map") || /^server\.mjs\.(prev|new)/.test(b)); },
});
cpSync(path.join(root, "host", "host.mjs"), path.join(stage, "host.mjs"));

// 2. Only the packages the server really loads, plus the database. package.json
//    also lists the website's build tools (bundlers, CSS compilers, a PDF
//    viewer...), which the host never runs; installing all of them tripled
//    the download. The bundled server names what it imports.
const serverJs = readFileSync(path.join(root, "dist", "server.mjs"), "utf8");
const used = new Set();
for (const m of serverJs.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^import\s+)["']([^"'./][^"']*)["']/gm)) {
  const spec = m[1];
  if (spec.startsWith("node:")) continue;
  used.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
}
// vite only runs when dist/ is missing (development); the host always has dist/.
used.delete("vite");
const deps = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([name]) => used.has(name)));
const unknown = [...used].filter((n) => !(n in (pkg.dependencies ?? {})) && !(n in (pkg.devDependencies ?? {})) && !/^(fs|path|os|url|http|https|crypto|stream|zlib|events|util|child_process|net|tls|dns|readline|worker_threads|buffer|assert|module|perf_hooks|querystring|string_decoder|timers|tty|v8|vm|process|cluster|dgram|inspector)$/.test(n));
for (const n of [...used].filter((n) => !(n in (pkg.dependencies ?? {})) && n in (pkg.devDependencies ?? {}))) deps[n] = pkg.devDependencies[n];
if (unknown.length) console.log(`note: the server imports packages package.json doesn't list: ${unknown.join(", ")}`);
console.log(`server packages: ${Object.keys(deps).length} of ${Object.keys(pkg.dependencies ?? {}).length} listed`);
writeFileSync(path.join(stage, "package.json"), JSON.stringify({
  name: "savestate-host", version, private: true, type: "module",
  dependencies: { ...deps, "embedded-postgres": PG },
}, null, 2));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Once more on failure: the first try here died once with no message (a
// download cut off); the second finished.
const install = () => execFileSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
try { install(); } catch { console.log("npm install failed; trying once more"); install(); }
// Only the Windows database binaries are needed.
const pgPkgs = path.join(stage, "node_modules", "@embedded-postgres");
for (const d of existsSync(pgPkgs) ? readdirSync(pgPkgs) : []) if (d !== "windows-x64") rmSync(path.join(pgPkgs, d), { recursive: true, force: true });
if (!existsSync(path.join(pgPkgs, "windows-x64"))) throw new Error("the Windows PostgreSQL binaries didn't install");

// 3. Zip (Windows' own tar writes zip files).
mkdirSync(outDir, { recursive: true });
rmSync(zip, { force: true });
execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", zip, "-C", stage, "."], { stdio: "inherit" });
const bytes = readFileSync(zip);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(zip.replace(/\.zip$/, ".json"), JSON.stringify({ version, file: path.basename(zip), size: statSync(zip).size, sha256, builtAt: new Date().toISOString() }, null, 2));
rmSync(stage, { recursive: true, force: true });
console.log(`SaveState Host ${version}: ${path.basename(zip)} (${(bytes.length / 1048576).toFixed(0)} MB, sha256 ${sha256.slice(0, 16)}...)`);
