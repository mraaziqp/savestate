#!/usr/bin/env node
// Publishes the SaveState Engine release build for launchers to fetch
// (/api/client-launcher/engine). Build it first: engine\build.cmd --release
//
//   node scripts/publish-engine.mjs
import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(root, "engine", "target", "release", "savestate-engine.exe");
const outDir = path.join(root, "releases", "engine");
const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(root, "engine", "Cargo.toml"), "utf8"))?.[1] ?? "0";

mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, "savestate-engine.exe.new");
copyFileSync(built, tmp);
// Replaced in one step, so a launcher downloading right now never gets half a file.
renameSync(tmp, path.join(outDir, "savestate-engine.exe"));
const bytes = readFileSync(path.join(outDir, "savestate-engine.exe"));
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(path.join(outDir, "engine.json"), JSON.stringify({ version, sha256, size: statSync(built).size, builtAt: new Date().toISOString() }, null, 2));
console.log(`SaveState Engine ${version} published (${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…)`);
