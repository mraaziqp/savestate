// Packs a core's own data files (from its source tree) as <core>-system.zip
// in releases\cores\android, which the phone unpacks into its system folder
// (GameActivity: /api/engine/android/cores lists it under "system").
//
//   node engine/cores/pack-system.mjs dolphin
//
// Dolphin reads system/dolphin-emu/Sys (shaders, per-game settings, fonts).
// Entries use forward slashes (zips made by PowerShell on Windows use
// backslashes, which Android's unzip turns into odd file names).
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const AdmZip = createRequire(path.join(here, "../../package.json"))("adm-zip");
const SETS = {
  dolphin: { from: "G:/Projects/savestate-cores/dolphin/Data/Sys", to: "dolphin-emu/Sys" },
};
const core = process.argv[2];
const set = SETS[core];
if (!set) throw new Error(`No system files known for ${core}. Known: ${Object.keys(SETS).join(", ")}`);
const zip = new AdmZip();
let files = 0;
const walk = (dir, rel) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const into = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) walk(full, into);
    else { zip.addLocalFile(full, path.posix.dirname(`${set.to}/${into}`)); files++; }
  }
};
walk(set.from, "");
const out = path.join(here, "../../releases/cores/android", `${core}-system.zip`);
zip.writeZip(out);
console.log(`${out}: ${files} files, ${(statSync(out).size / 1024 ** 2).toFixed(1)} MB`);
