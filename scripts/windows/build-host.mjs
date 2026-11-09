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
// What the server reads from its own folder besides dist/: the Files page
// (web/), the TV, watch and launcher pages (public/), the launcher it hands to
// PCs, the install scripts it serves, and the co-op list. Without web/ the
// Files section answered 404 on a new host.
for (const item of ["web", "public", "client-launcher.cjs", "nucleus-compatibility.json",
  "scripts/install.sh", "scripts/install-host.ps1", "scripts/client-install-linux.sh", "scripts/gamepad-bridge.py"]) {
  const from = path.join(root, item);
  if (existsSync(from)) cpSync(from, path.join(stage, item), { recursive: true });
  else console.log(`note: ${item} is missing, left out`);
}

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

// 4. SaveState-Host.exe: what people download and double-click instead of
//    typing a command. A few lines of C# built with the compiler every
//    Windows 10/11 has (.NET Framework's csc.exe), with a manifest saying it
//    runs as the user. Not IExpress: its packages were taken for installers
//    and never started the setup (2026-11-09), and Windows asks for admin
//    rights for unsigned programs without that manifest whose names contain
//    Setup/Install/Update. It runs the same installer
//    (scripts/install-host.ps1, fetched from the site so it is always the
//    current one) and keeps the window open to read the result.
if (process.platform === "win32") {
  const work = path.join(root, "releases", "host-setup-stage");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const ps = `-NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm https://savestate.co.za/install-host.ps1 | iex"`;
  writeFileSync(path.join(work, "host.cs"), `using System;
using System.Diagnostics;
using System.Reflection;
[assembly: AssemblyTitle("SaveState Host")]
[assembly: AssemblyProduct("SaveState")]
[assembly: AssemblyVersion("${version}.0")]
class Program {
  static int Main() {
    try { Console.Title = "SaveState Host"; } catch {}
    Console.WriteLine("Setting up SaveState Host on this PC. This takes a few minutes.");
    Console.WriteLine();
    int code = 1;
    try {
      var psi = new ProcessStartInfo("powershell.exe", ${JSON.stringify(ps)});
      psi.UseShellExecute = false;
      using (var p = Process.Start(psi)) { p.WaitForExit(); code = p.ExitCode; }
    } catch (Exception e) { Console.WriteLine("Couldn't start PowerShell: " + e.Message); }
    Console.WriteLine();
    Console.WriteLine("You can close this window.");
    try { if (!Console.IsInputRedirected) Console.ReadKey(true); } catch {}
    return code;
  }
}
`);
  writeFileSync(path.join(work, "host.manifest"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" name="SaveState.Host"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
    <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
  </requestedPrivileges></security></trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
    <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
  </application></compatibility>
</assembly>
`);
  const exe = path.join(outDir, "SaveState-Host.exe");
  rmSync(exe, { force: true });
  const win = process.env.SystemRoot ?? "C:\\Windows";
  const csc = [path.join(win, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), path.join(win, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")].find(existsSync);
  if (!csc) throw new Error("the .NET Framework C# compiler (csc.exe) isn't on this PC");
  const icon = path.join(root, "src-tauri", "icons", "icon.ico");
  execFileSync(csc, ["/nologo", "/target:exe", "/optimize+", "/platform:anycpu", `/out:${exe}`, `/win32manifest:${path.join(work, "host.manifest")}`,
    ...(existsSync(icon) ? [`/win32icon:${icon}`] : []), path.join(work, "host.cs")], { stdio: "inherit" });
  rmSync(work, { recursive: true, force: true });
  if (!existsSync(exe)) throw new Error("csc didn't make SaveState-Host.exe");
  console.log(`SaveState-Host.exe (${(statSync(exe).size / 1024).toFixed(0)} KB)`);
}
console.log(`SaveState Host ${version}: ${path.basename(zip)} (${(bytes.length / 1048576).toFixed(0)} MB, sha256 ${sha256.slice(0, 16)}...)`);
