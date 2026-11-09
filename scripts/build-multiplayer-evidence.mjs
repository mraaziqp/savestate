#!/usr/bin/env node
// Builds server/data/multiplayer-evidence.json: per platform, what two public
// game databases say about how many people can play each game, and whether
// it is cooperative. The classifier (server/multiplayer-db.ts) uses it as
// evidence, with its source named on every game.
//
//   node scripts/build-multiplayer-evidence.mjs
//
// Sources (both downloaded fresh each run):
//   - LaunchBox Games Database (gamesdb.launchbox-app.com/Metadata.zip):
//     MaxPlayers and Cooperative per game per platform, community-maintained.
//   - libretro-database metadat/maxusers: the most simultaneous players per
//     ROM (No-Intro names), for cartridge systems.
// Neither says whether players share a screen or split it, or whether a mode
// is competitive; the classifier never infers those from these numbers.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "server", "data", "multiplayer-evidence.json");
const work = path.join(os.tmpdir(), `savestate-mp-${Date.now()}`);
mkdirSync(work, { recursive: true });

// LaunchBox platform name -> SaveState platform key.
const LB = {
  "Nintendo 64": "n64", "Super Nintendo Entertainment System": "snes", "Nintendo Entertainment System": "nes",
  "Sega Genesis": "genesis", "Sega Master System": "mastersystem", "Sega Game Gear": "gamegear", "Sega 32X": "32x", "Sega CD": "segacd",
  "Nintendo Game Boy": "gb", "Nintendo Game Boy Color": "gbc", "Nintendo Game Boy Advance": "gba", "Nintendo DS": "nds", "Nintendo 3DS": "3ds",
  "Nintendo GameCube": "gamecube", "Nintendo Wii": "wii", "Nintendo Wii U": "wiiu", "Nintendo Switch": "switch",
  "Sony Playstation": "psx", "Sony Playstation 2": "ps2", "Sony Playstation 3": "ps3", "Sony PSP": "psp",
  "Sega Dreamcast": "dreamcast", "Sega Saturn": "saturn", "SNK Neo Geo AES": "neogeo", "SNK Neo Geo MVS": "neogeo", "SNK Neo Geo CD": "neogeocd",
  "Arcade": "mame", "Atari 2600": "atari2600", "Atari 7800": "atari7800", "Atari Lynx": "lynx", "NEC TurboGrafx-16": "pce",
  "Microsoft Xbox": "xbox", "Microsoft Xbox 360": "xbox360",
};
// libretro system name -> SaveState platform key.
const LR = {
  "Nintendo - Nintendo 64": "n64", "Nintendo - Super Nintendo Entertainment System": "snes", "Nintendo - Nintendo Entertainment System": "nes",
  "Sega - Mega Drive - Genesis": "genesis", "Sega - Master System - Mark III": "mastersystem", "Sega - Game Gear": "gamegear",
  "Nintendo - Game Boy": "gb", "Nintendo - Game Boy Color": "gbc", "Nintendo - Game Boy Advance": "gba", "Atari - 2600": "atari2600",
  "Atari - 7800": "atari7800", "NEC - PC Engine - TurboGrafx 16": "pce", "SNK - Neo Geo Pocket Color": "ngpc",
};

const evidence = { builtAt: new Date().toISOString(), sources: {}, launchbox: {}, maxusers: {} };

// 1. LaunchBox.
{
  const zip = path.join(work, "Metadata.zip");
  console.log("downloading the LaunchBox Games Database...");
  const res = await fetch("https://gamesdb.launchbox-app.com/Metadata.zip");
  if (!res.ok) throw new Error(`LaunchBox: HTTP ${res.status}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync(process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", zip, "-C", work, "Metadata.xml"]);
  const tag = (block, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block); return m ? m[1] : ""; };
  const unxml = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const byId = new Map();
  const alt = [];
  let block = null, kind = "";
  const rl = readline.createInterface({ input: createReadStream(path.join(work, "Metadata.xml"), "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t === "<Game>" || t === "<GameAlternateName>") { block = ""; kind = t; continue; }
    if (block === null) continue;
    if (t === "</Game>" || t === "</GameAlternateName>") {
      if (kind === "<Game>") {
        const platform = LB[unxml(tag(block, "Platform"))];
        if (platform) {
          const max = Number(tag(block, "MaxPlayers")) || 0;
          const coop = tag(block, "Cooperative");
          byId.set(tag(block, "DatabaseID"), { n: unxml(tag(block, "Name")), p: platform, y: Number(tag(block, "ReleaseYear")) || 0, m: max, c: coop === "true" ? 1 : coop === "false" ? 0 : null });
        }
      } else {
        alt.push([tag(block, "DatabaseID"), unxml(tag(block, "AlternateName"))]);
      }
      block = null;
      continue;
    }
    block += t;
  }
  for (const g of byId.values()) {
    (evidence.launchbox[g.p] ??= []).push([g.n, g.m, g.c, g.y]);
  }
  // Other names a game is known by (regional titles), pointing at the same entry.
  for (const [id, name] of alt) {
    const g = byId.get(id);
    if (g && name) (evidence.launchbox[g.p] ??= []).push([name, g.m, g.c, g.y, 1]);
  }
  evidence.sources.launchbox = { name: "LaunchBox Games Database", url: "https://gamesdb.launchbox-app.com", games: byId.size };
  console.log(`LaunchBox: ${byId.size} games on SaveState's platforms`);
}

// 2. libretro maxusers.
{
  let files = 0, entries = 0;
  for (const [system, platform] of Object.entries(LR)) {
    const url = `https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/maxusers/${encodeURIComponent(system)}.dat`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`libretro: no list for ${system}`); continue; }
    const text = await res.text();
    files++;
    // Each entry: game ( comment "<No-Intro name>" users N rom ( crc XXXXXXXX ) )
    for (const m of text.matchAll(/game\s*\(([\s\S]*?)\r?\n\)/g)) {
      const name = /\b(?:comment|name)\s+"([^"]+)"/.exec(m[1])?.[1];
      const users = Number(/\busers\s+(\d+)/.exec(m[1])?.[1]);
      const crc = /\bcrc\s+([0-9A-Fa-f]{8})/.exec(m[1])?.[1]?.toLowerCase() ?? "";
      if (name && users) { (evidence.maxusers[platform] ??= []).push([name, users, crc]); entries++; }
    }
  }
  evidence.sources.maxusers = { name: "libretro-database (metadat/maxusers)", url: "https://github.com/libretro/libretro-database/tree/master/metadat/maxusers", systems: files, games: entries };
  console.log(`libretro: ${entries} games across ${files} systems`);
}

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(evidence));
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${path.relative(root, out)} (${(JSON.stringify(evidence).length / 1048576).toFixed(1)} MB)`);
