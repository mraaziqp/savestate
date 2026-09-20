// NexusEmu Embedded Client Launcher (Electron main process)
//
// Ports the game-play responsibilities of public/client-launcher.ps1 into the
// Electron desktop app itself, so desktop users no longer need to install and
// keep a separate PowerShell background service running. Serves the same HTTP
// API on 127.0.0.1:17373 that the web UI already speaks:
//
//   GET  /health           — liveness + emulator detection summary
//   GET  /preflight        — per-platform readiness (emulator + core)
//   GET  /setup            — full status object (folders + emulator paths)
//   POST /ensure-local     — install RetroArch (winget, Windows) + platform core
//   POST /install-emulator — install a specific emulator (retroarch)
//   POST /cache-rom        — download a ROM into the local ROM folder
//   POST /cache-music      — save a host-library track into the local Music folder
//   POST /launch           — download ROM if needed, then launch the emulator
//                            (optional netplay: {role, hostAddress, port, nick}
//                            adds RetroArch's --host/--connect args, so netplay
//                            actually runs here instead of on the host)
//   POST /launch-exe       — launch an arbitrary local executable (PC/Steam-less
//                            games tracked only by executablePath — the only
//                            client-side launch path for those; steam://
//                            protocol URIs handle Steam/Epic games separately)
//   POST /config           — update romDirectory / extraRomDirs / emulator paths / host URL
//   POST /rom-scan         — walk romDirectory + extraRomDirs, report ROM file counts
//   POST /pick-folder      — (new, Electron-only) native folder picker; roots
//                            ROMs/cores/bios/saves/states in ONE chosen folder
//   POST /pick-path        — (new, Electron-only) plain native folder/file
//                            dialog, no side effects; used for standalone path
//                            fields (host setup wizard's ROMs/BIOS/exe fields)
//   POST /clone-host-setup — copy a connected host's already-working cores +
//                            BIOS into this client (never touches saves/states)
//
// Deliberately NOT ported: the offline-media endpoints (/offline-*) from the
// PowerShell script — nothing in the web UI calls them anymore.
//
// If port 17373 is already taken (e.g. the legacy PowerShell launcher is still
// installed and running), this module logs and backs off — the UI works the
// same against either implementation.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 17373;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Node kills the ENTIRE process on an unhandled promise rejection by default
// (has since Node 15) — with dozens of async route handlers in this file,
// one missed .catch() or an unawaited rejected promise anywhere would take
// down the whole HTTP server, not just that one request. That's exactly what
// "the launcher worked, then later showed not running" looks like from the
// outside: nothing crashed loudly, the process just silently stopped
// existing. Logging and surviving here is the same "keep the server alive"
// policy server.ts already uses for its own transient errors.
process.on('uncaughtException', (err) => {
  try { console.error('[client-launcher] uncaught exception (survived):', err && err.stack ? err.stack : err); } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[client-launcher] unhandled rejection (survived):', reason); } catch {}
});

// Same root as the PowerShell launcher on Windows so existing installs keep
// their config, ROMs and emulators without re-downloading anything.
function getClientRoot() {
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'NexusEmuClient');
  }
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'NexusEmuClient');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'NexusEmuClient');
}

const clientRoot = getClientRoot();
const defaultRomDir = path.join(clientRoot, 'ROMs');
const emuRoot = path.join(clientRoot, 'Emulators');
const configPath = path.join(clientRoot, 'launcher-config.json');
const hostUrlFile = path.join(clientRoot, 'preferred-host-url.txt');

function ensureDirSync(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* best effort */ }
}

// Windows Defender (and Windows Search indexing) routinely holds a transient
// lock on files for a few hundred ms right after they're extracted from an
// archive — a plain fs.renameSync on a freshly-unzipped folder (RetroArch's
// "assets" directory is exactly this: dozens of newly-written files) hits
// that window often enough to be a real, reproducible install failure
// ("EPERM: operation not permitted, rename ..."), not a rare edge case.
// Retries with backoff first (the lock is normally gone within ~1s); if it's
// still locked after that, falls back to a recursive copy + delete-original,
// which succeeds even when a rename genuinely can't (e.g. still-open handle
// preventing the atomic move but not a plain read).
function renameDirWithRetry(src, dest, attempts = 6, delayMs = 300) {
  return new Promise((resolve, reject) => {
    const tryRename = (attemptsLeft) => {
      try {
        fs.renameSync(src, dest);
        resolve();
      } catch (err) {
        if (attemptsLeft <= 1) {
          try {
            fs.cpSync(src, dest, { recursive: true });
            fs.rmSync(src, { recursive: true, force: true });
            resolve();
          } catch (copyErr) {
            reject(copyErr || err);
          }
          return;
        }
        setTimeout(() => tryRename(attemptsLeft - 1), delayMs);
      }
    };
    tryRename(attempts);
  });
}

// ── Config (same JSON schema as the PowerShell launcher) ─────────────────────
function defaultConfig() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    clientRoot,
    romDirectory: defaultRomDir,
    // Extra folders/drives (e.g. an existing GameCube ROM collection kept
    // on a separate drive) searched in addition to romDirectory — nothing
    // is ever written here automatically, only read from during launch/
    // cache-rom/scan, so pointing this at an existing library never risks
    // reorganizing or duplicating it.
    extraRomDirs: [],
    emulatorRoot: emuRoot,
    emulators: { retroarch: '', dolphin: '', pcsx2: '', ppsspp: '', cemu: '', rpcs3: '' },
    // Folder sharing — lets this client contribute a local folder (e.g. an
    // existing movie collection) into the host's shared media library
    // without ever copying the files onto the host's own drive. clientId is
    // stable across restarts so the host can recognize returning shares;
    // shareToken gates the LAN-facing share server (see startShareServer)
    // so only requests that know it (i.e. the host, which received it at
    // registration time) can list/read the shared folder.
    clientId: crypto.randomUUID(),
    shareEnabled: false,
    shareFolder: '',
    shareToken: crypto.randomBytes(24).toString('hex'),
  };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.emulators) cfg.emulators = {};
    if (!Array.isArray(cfg.extraRomDirs)) cfg.extraRomDirs = [];
    // Backfill fields added after this config file was first created — an
    // existing install must not lose its romDirectory/emulators just because
    // the on-disk JSON predates the folder-sharing feature.
    if (!cfg.clientId) cfg.clientId = crypto.randomUUID();
    if (!cfg.shareToken) cfg.shareToken = crypto.randomBytes(24).toString('hex');
    if (typeof cfg.shareEnabled !== 'boolean') cfg.shareEnabled = false;
    if (typeof cfg.shareFolder !== 'string') cfg.shareFolder = '';
    return cfg;
  } catch {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
}

function saveConfig(cfg) {
  ensureDirSync(clientRoot);
  try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8'); } catch { /* best effort */ }
  return cfg;
}

// Records an emulator's path without clobbering concurrent config writes.
//
// Every installer loads a `cfg` at the top and then spends MINUTES downloading
// and extracting before it saves. Auto-setup runs several of them in sequence,
// so by the time one saves, its in-memory copy is stale — and writing the whole
// object back silently reverts whatever the others recorded in between. That is
// not hypothetical: a real auto-setup run finished with rpcs3 recorded but
// "retroarch": "" despite RetroArch having installed successfully moments
// earlier, which made every RetroArch platform fail at launch with "No emulator
// found". Re-reading immediately before the write keeps each installer's
// contribution to a single key.
//
// `localCfg`, when passed, is the caller's own stale object — refreshed in place
// so the rest of that function keeps seeing an accurate view.
function persistEmulatorPath(configKey, exePath, localCfg) {
  const fresh = loadConfig();
  fresh.emulators = fresh.emulators || {};
  fresh.emulators[configKey] = exePath;
  saveConfig(fresh);
  if (localCfg) localCfg.emulators = fresh.emulators;
  return exePath;
}

function resolveRomDirectory(cfg) {
  const dir = String(cfg.romDirectory || '').trim() || defaultRomDir;
  ensureDirSync(dir);
  return dir;
}

// ── Platform → RetroArch core mapping (parity with client-launcher.ps1) ──────
const PLATFORM_CORES = {
  nes: 'fceumm', famicom: 'fceumm', snes: 'snes9x', n64: 'mupen64plus_next',
  gba: 'mgba', gbc: 'mgba', gb: 'mgba', nds: 'melondsds', '3ds': 'citra',
  ps1: 'pcsx_rearmed', psx: 'pcsx_rearmed', playstation: 'pcsx_rearmed',
  ps2: 'pcsx2', psp: 'ppsspp',
  genesis: 'genesis_plus_gx', megadrive: 'genesis_plus_gx', 'sega genesis': 'genesis_plus_gx',
  gamegear: 'genesis_plus_gx', mastersystem: 'genesis_plus_gx', sms: 'genesis_plus_gx',
  sega32x: 'picodrive', '32x': 'picodrive',
  segacd: 'genesis_plus_gx', 'sega cd': 'genesis_plus_gx',
  dreamcast: 'flycast', 'sega dreamcast': 'flycast', saturn: 'yabause', 'sega saturn': 'yabause',
  pce: 'mednafen_pce', 'pc engine': 'mednafen_pce', turbografx: 'mednafen_pce',
  wonderswan: 'mednafen_wswan', neogeo: 'fbneo', 'neo geo': 'fbneo',
  atari2600: 'stella', 'atari 2600': 'stella', atari7800: 'prosystem', 'atari 7800': 'prosystem',
  lynx: 'mednafen_lynx', mame: 'mame', arcade: 'mame',
  // GameCube/Wii via RetroArch's Dolphin core. Standalone Dolphin is still
  // preferred when present (getEmulatorPath checks it first) — but Dolphin
  // is the one emulator with no automatable install: it publishes no GitHub
  // releases, and dolphin-emu.org returns 403 to programmatic downloads, so
  // every GameCube launch dead-ended on "No emulator found for 'gamecube'".
  // The libretro core IS on the same buildbot every other core comes from
  // (verified: dolphin_libretro.dll.zip, 7.3 MB, HTTP 200), so this reuses
  // the auto-download path that already works instead of needing a new one.
  gamecube: 'dolphin', wii: 'dolphin',
};

const CORE_EXT = IS_WIN ? '.dll' : IS_MAC ? '.dylib' : '.so';

// Platforms with no bare-RetroArch fallback — they need a specific standalone
// emulator (Dolphin, PCSX2, etc). Hoisted to module scope so both
// getEmulatorPath() and the /ensure-local handler can see it: ensure-local
// used to unconditionally try to auto-install RetroArch for every platform,
// including these, which never helped a GameCube/PS2/etc launch (RetroArch
// isn't what runs those) and just wasted time before reporting a misleading
// "RetroArch installed" step next to a launch that still couldn't work.
// gamecube/wii are deliberately NOT in this set: they now have a working
// RetroArch core (see PLATFORM_CORES' dolphin entries), so falling back to
// RetroArch is a real, playable path for them rather than the misleading
// dead end it would be for the others. Standalone Dolphin still wins when
// installed — getEmulatorPath() checks it before reaching this fallback.
const STANDALONE_ONLY_PLATFORMS = new Set(['ps2', 'wiiu', 'psp', 'ps3', 'switch', 'xbox', 'xbox360', 'x360']);

// Recognized ROM/disc-image extensions for the multi-drive scan — same list
// shape as quickstart-zorin-host.sh's host-side ROM_EXT_REGEX, so a file this
// client finds is one the host would also have recognized as a ROM.
const ROM_EXTENSIONS = new Set([
  '.zip', '.7z', '.chd', '.iso', '.bin', '.cue', '.nes', '.sfc', '.smc',
  '.gba', '.gbc', '.gb', '.n64', '.z64', '.nds', '.3ds', '.pce', '.md',
  '.gen', '.ngp', '.ws', '.wsc', '.sms', '.gg', '.a26', '.a52', '.a78',
  '.j64', '.min', '.vb', '.vec', '.int', '.rvz', '.wbfs', '.gcm', '.wux',
  '.wua', '.xci', '.nsp', '.cso', '.gcz', '.ciso',
]);

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ── Folder sharing — contribute a local folder to the host's media library
// without copying it there. See defaultConfig()'s comment for the shape.
const SHARE_PORT = 17375;
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.wmv', '.flv', '.ts']);
const SHARE_SCAN_MAX_DEPTH = 6;
const SHARE_SCAN_MAX_FILES = 20_000;

// First non-internal IPv4 address — this is what gets handed to the host so
// it knows where to reach this machine's share server. Loopback/link-local
// addresses are useless to a host on a different device, so those are
// explicitly skipped rather than accidentally registering an unreachable URL.
function getLanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

function listSharedFiles(rootFolder) {
  const out = [];
  const budget = { count: 0 };
  function walk(dir, depth) {
    if (depth > SHARE_SCAN_MAX_DEPTH || budget.count > SHARE_SCAN_MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.count > SHARE_SCAN_MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        budget.count++;
        if (!MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        if (size <= 0) continue;
        const rel = path.relative(rootFolder, full).replace(/\\/g, '/');
        out.push({ relPath: rel, name: path.parse(entry.name).name, size });
      }
    }
  }
  walk(rootFolder, 0);
  return out;
}

// Best-effort — the host might be unreachable (offline, wrong URL) or might
// be an older version without this endpoint; either way, sharing must never
// crash the launcher, it just silently doesn't show up in anyone's library
// until the next successful registration.
async function registerShareWithHost(cfg) {
  if (!cfg.shareEnabled || !cfg.shareFolder) return;
  let hostUrl = '';
  try { hostUrl = fs.readFileSync(hostUrlFile, 'utf8').trim(); } catch { return; }
  if (!hostUrl) return;
  const lanIp = getLanAddress();
  if (!lanIp) return;
  const files = listSharedFiles(cfg.shareFolder);
  try {
    await fetch(`${hostUrl.replace(/\/+$/, '')}/api/client-shares/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: cfg.clientId,
        clientName: os.hostname(),
        lanUrl: `http://${lanIp}:${SHARE_PORT}`,
        token: cfg.shareToken,
        files,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* host unreachable — will retry on the next heartbeat */ }
}

// Separate HTTP server, separate (non-default) port, bound to every
// interface rather than just loopback — this is the one piece of this
// launcher that's deliberately reachable from other devices on the network,
// since the whole point is letting the HOST (a different machine) read from
// it. Everything it serves is gated by shareToken (only the host knows this,
// having received it at registration time) and hard-scoped to files inside
// the configured shareFolder — it has no other capability (no launch, no
// config, no arbitrary path access) even if the token leaked to someone else
// on the same LAN.
function startShareServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const cfg = loadConfig();
      if (!cfg.shareEnabled || !cfg.shareFolder) {
        res.writeHead(404); res.end(); return;
      }
      const token = url.searchParams.get('token');
      if (token !== cfg.shareToken) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      if (url.pathname === '/shared-list') {
        const files = listSharedFiles(cfg.shareFolder);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, files }));
        return;
      }

      if (url.pathname === '/shared-file') {
        const rel = safeRelativeSubpath(url.searchParams.get('rel') || '');
        if (!rel) { res.writeHead(400); res.end('Bad path'); return; }
        const full = path.join(cfg.shareFolder, rel);
        // safeRelativeSubpath already rejects ".."/absolute escapes, but a
        // symlink inside the shared folder could still point outside it —
        // resolving the real path and re-checking containment closes that.
        let real;
        try { real = fs.realpathSync(full); } catch { res.writeHead(404); res.end(); return; }
        const realRoot = fs.realpathSync(cfg.shareFolder);
        if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        let stat;
        try { stat = fs.statSync(real); } catch { res.writeHead(404); res.end(); return; }
        const range = req.headers.range;
        const ext = path.extname(real).toLowerCase();
        const mime = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm' }[ext] || 'application/octet-stream';
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? parseInt(m[1], 10) : 0;
          const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
          const stream = fs.createReadStream(real, { start, end });
          stream.on('error', () => { try { res.end(); } catch {} });
          req.on('close', () => stream.destroy());
          stream.pipe(res);
        } else {
          res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
          const stream = fs.createReadStream(real);
          stream.on('error', () => { try { res.end(); } catch {} });
          req.on('close', () => stream.destroy());
          stream.pipe(res);
        }
        return;
      }

      res.writeHead(404); res.end();
    } catch (e) {
      try { res.writeHead(500); res.end(String(e && e.message ? e.message : e)); } catch {}
    }
  });
  server.on('error', (err) => {
    console.warn('[electron] Share server error (folder sharing disabled until restart):', err && err.message ? err.message : err);
  });
  server.listen(SHARE_PORT, '0.0.0.0', () => {
    console.log(`[electron] Share server listening on 0.0.0.0:${SHARE_PORT}`);
  });
  return server;
}

function getEmulatorPath(platform) {
  const cfg = loadConfig();
  const p = String(platform || '').toLowerCase();
  const home = os.homedir();

  // The portable installers write into <emulationRoot>/emulators/<Name>/ (see
  // installRetroArchWindowsPortable / installPCSX2WindowsPortable), which is
  // NOT the same place as emuRoot (<clientRoot>/Emulators). That left the
  // config entry as the only way to find a freshly-installed emulator — so any
  // hiccup writing it (a stale config overwriting the path, a failed save)
  // produced "No emulator found" for an emulator sitting right there on disk.
  // Searching the real install location too makes lookup self-healing.
  // Three real locations, because two different mechanisms install emulators:
  //   <emulationRoot>/emulators/<Name>  — the portable installers
  //   <emulationRoot>/<Name>            — performCloneHostSetup's clone targets
  //   <clientRoot>/Emulators/<Name>     — the original/legacy layout
  const emuDirs = [
    cfg.emulationRoot ? path.join(cfg.emulationRoot, 'emulators') : null,
    cfg.emulationRoot || null,
    emuRoot,
  ].filter(Boolean);
  const inEmuDirs = (...rel) => emuDirs.map((d) => path.join(d, ...rel));

  const retro = firstExisting(IS_WIN ? [
    cfg.emulators?.retroarch,
    ...inEmuDirs('RetroArch', 'retroarch.exe'),
    path.join(emuRoot, 'RetroArch', 'retroarch.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'RetroArch', 'retroarch.exe'),
    'C:\\RetroArch\\retroarch.exe',
    'C:\\Program Files\\RetroArch-Win64\\retroarch.exe',
    'C:\\Program Files (x86)\\RetroArch-Win64\\retroarch.exe',
  ] : IS_MAC ? [
    cfg.emulators?.retroarch,
    '/Applications/RetroArch.app/Contents/MacOS/RetroArch',
    path.join(home, 'Applications', 'RetroArch.app', 'Contents', 'MacOS', 'RetroArch'),
  ] : [
    cfg.emulators?.retroarch,
    '/usr/bin/retroarch',
    '/usr/local/bin/retroarch',
    '/snap/bin/retroarch',
    '/var/lib/flatpak/exports/bin/org.libretro.RetroArch',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.libretro.RetroArch'),
  ]);

  const dolphin = firstExisting(IS_WIN ? [
    cfg.emulators?.dolphin,
    ...inEmuDirs('Dolphin', 'Dolphin.exe'),
    path.join(emuRoot, 'Dolphin', 'Dolphin.exe'),
    'C:\\Program Files\\Dolphin\\Dolphin.exe',
    'C:\\Program Files\\Dolphin Emulator\\Dolphin.exe',
  ] : IS_MAC ? [
    cfg.emulators?.dolphin,
    '/Applications/Dolphin.app/Contents/MacOS/Dolphin',
  ] : [
    cfg.emulators?.dolphin,
    '/usr/bin/dolphin-emu',
    '/snap/bin/dolphin-emulator',
    '/var/lib/flatpak/exports/bin/org.DolphinEmu.dolphin-emu',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.DolphinEmu.dolphin-emu'),
  ]);

  const pcsx2 = firstExisting(IS_WIN ? [
    cfg.emulators?.pcsx2,
    ...inEmuDirs('PCSX2', 'pcsx2-qt.exe'),
    path.join(emuRoot, 'PCSX2', 'pcsx2-qt.exe'),
    ...inEmuDirs('PCSX2', 'pcsx2.exe'),
    path.join(emuRoot, 'PCSX2', 'pcsx2.exe'),
    'C:\\Program Files\\PCSX2\\pcsx2-qt.exe',
  ] : IS_MAC ? [
    cfg.emulators?.pcsx2,
    '/Applications/PCSX2.app/Contents/MacOS/PCSX2',
  ] : [
    cfg.emulators?.pcsx2,
    '/usr/bin/pcsx2',
    '/snap/bin/pcsx2',
    '/var/lib/flatpak/exports/bin/net.pcsx2.PCSX2',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'net.pcsx2.PCSX2'),
  ]);

  const ppsspp = firstExisting(IS_WIN ? [
    cfg.emulators?.ppsspp,
    ...inEmuDirs('PPSSPP', 'PPSSPPWindows64.exe'),
    path.join(emuRoot, 'PPSSPP', 'PPSSPPWindows64.exe'),
    'C:\\Program Files\\PPSSPP\\PPSSPPWindows64.exe',
  ] : [
    cfg.emulators?.ppsspp,
    '/usr/bin/ppsspp',
    '/snap/bin/ppsspp-emu.ppsspp-sdl',
    '/var/lib/flatpak/exports/bin/org.ppsspp.PPSSPP',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.ppsspp.PPSSPP'),
  ]);

  const rpcs3 = firstExisting(IS_WIN ? [
    cfg.emulators?.rpcs3,
    ...inEmuDirs('RPCS3', 'rpcs3.exe'),
    path.join(emuRoot, 'RPCS3', 'rpcs3.exe'),
    path.join(emuRoot, 'RCPS3', 'rpcs3.exe'),
    'C:\\RPCS3\\rpcs3.exe',
    'C:\\Program Files\\RPCS3\\rpcs3.exe',
    path.join(process.env.LOCALAPPDATA || '', 'rpcs3', 'rpcs3.exe'),
  ] : [
    cfg.emulators?.rpcs3,
    '/usr/bin/rpcs3',
    '/snap/bin/rpcs3',
    '/var/lib/flatpak/exports/bin/net.rpcs3.RPCS3',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'net.rpcs3.RPCS3'),
  ]);

  const switchEmu = firstExisting(IS_WIN ? [
    cfg.emulators?.eden, cfg.emulators?.ryujinx,
    // The Switch clone target writes to <emulationRoot>/Switch/ (see
    // STANDALONE_TARGETS' folder), so probe both that and the emulators/ tree.
    ...inEmuDirs('Eden', 'eden.exe'),
    ...inEmuDirs('Ryujinx', 'Ryujinx.exe'),
    ...(cfg.emulationRoot ? [
      path.join(cfg.emulationRoot, 'Switch', 'eden.exe'),
      path.join(cfg.emulationRoot, 'Switch', 'Ryujinx.exe'),
    ] : []),
    path.join(emuRoot, 'Eden', 'eden.exe'),
    path.join(emuRoot, 'Ryujinx', 'Ryujinx.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Eden', 'eden.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Ryujinx', 'Ryujinx.exe'),
  ] : [
    cfg.emulators?.eden, cfg.emulators?.ryujinx,
    '/usr/bin/eden', '/usr/bin/ryujinx',
    '/var/lib/flatpak/exports/bin/dev.eden_emu.eden',
    '/var/lib/flatpak/exports/bin/io.github.ryubing.Ryujinx',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'dev.eden_emu.eden'),
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'io.github.ryubing.Ryujinx'),
  ]);

  const cemu = firstExisting(IS_WIN ? [
    cfg.emulators?.cemu,
    ...inEmuDirs('Cemu', 'Cemu.exe'),
    path.join(emuRoot, 'Cemu', 'Cemu.exe'),
    'C:\\Cemu\\Cemu.exe',
    'C:\\Program Files\\Cemu\\Cemu.exe',
  ] : [
    cfg.emulators?.cemu,
    '/usr/bin/cemu',
    '/var/lib/flatpak/exports/bin/info.cemu.Cemu',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'info.cemu.Cemu'),
  ]);

  // Xbox / Xbox 360. Both are already declared in the server's platform
  // registry and in its STANDALONE_LAUNCHERS, and the host can launch them —
  // but this client-side resolver never knew about them, so an Xbox or 360
  // game could not be launched locally on a client machine at all. It fell
  // through to the `retro` branch, and since neither is a RetroArch platform
  // the launch reported no emulator. Xenia is Windows-only upstream; on Linux
  // it runs under Proton/Wine, so only an explicitly-configured path is
  // honoured there rather than guessing at a wrapper.
  const xemu = firstExisting(IS_WIN ? [
    cfg.emulators?.xemu,
    ...inEmuDirs('xemu', 'xemu.exe'),
    path.join(emuRoot, 'xemu', 'xemu.exe'),
    'C:\\xemu\\xemu.exe',
    'C:\\Program Files\\xemu\\xemu.exe',
  ] : [
    cfg.emulators?.xemu,
    '/usr/bin/xemu',
    '/snap/bin/xemu',
    '/var/lib/flatpak/exports/bin/app.xemu.xemu',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'app.xemu.xemu'),
  ]);

  const xenia = firstExisting(IS_WIN ? [
    cfg.emulators?.xenia,
    ...inEmuDirs('Xenia', 'xenia.exe'),
    ...inEmuDirs('Xenia', 'xenia_canary.exe'),
    path.join(emuRoot, 'Xenia', 'xenia.exe'),
    path.join(emuRoot, 'Xenia', 'xenia_canary.exe'),
    'C:\\Xenia\\xenia.exe',
  ] : [
    cfg.emulators?.xenia,
  ]);

  if ((p === 'gamecube' || p === 'wii') && dolphin) return dolphin;
  if (p === 'wiiu' && cemu) return cemu;
  if (p === 'ps2' && pcsx2) return pcsx2;
  if (p === 'psp' && ppsspp) return ppsspp;
  if (p === 'ps3' && rpcs3) return rpcs3;
  if (p === 'switch' && switchEmu) return switchEmu;
  if (p === 'xbox' && xemu) return xemu;
  if ((p === 'xbox360' || p === 'x360') && xenia) return xenia;
  // Platforms that need a dedicated standalone emulator must NOT fall back to
  // bare RetroArch — this used to return `retro` unconditionally for every
  // platform, so preflight/health checks reported e.g. "PS2 ready" purely
  // because RetroArch was installed, with no PS2-capable core or emulator
  // anywhere. Launching then either opened RetroArch with no core loaded or
  // crashed, while the UI had already claimed everything was ready.
  if (retro && !STANDALONE_ONLY_PLATFORMS.has(p)) return retro;
  return null;
}

function isRetroArch(emuPath) {
  const base = path.basename(emuPath || '').toLowerCase();
  return base === 'retroarch.exe' || base === 'retroarch' || base === 'org.libretro.retroarch';
}

function getCoreDirs(retroarchPath) {
  const dirs = [path.join(path.dirname(retroarchPath), 'cores')];
  // /pick-folder (the native folder picker — see handleLaunch's caller)
  // creates a `cores` subfolder under whatever root the user chose, but
  // nothing ever looked there — cores placed/downloaded into it were
  // orphaned. Check it first since an explicit user choice should win.
  const cfg = loadConfig();
  if (cfg.emulationRoot) dirs.unshift(path.join(cfg.emulationRoot, 'cores'));
  const home = os.homedir();
  if (IS_WIN) {
    dirs.push(path.join(process.env.APPDATA || '', 'RetroArch', 'cores'));
  } else if (IS_MAC) {
    dirs.push(path.join(home, 'Library', 'Application Support', 'RetroArch', 'cores'));
  } else {
    // Order matters, and it depends on HOW RetroArch was installed. A
    // snap-confined RetroArch cannot read ~/.config/retroarch at all (snap's
    // `home` interface excludes hidden directories), and a flatpak one reads
    // its own ~/.var/app tree — so listing ~/.config first meant a core
    // downloaded there was reported as found (preflight checks every dir) and
    // then handed to an emulator that could not open it: "core installed,
    // ready to play", followed by a launch that silently does nothing. Put
    // the dir the running RetroArch can actually read first.
    const plainDir  = path.join(home, '.config', 'retroarch', 'cores');
    const snapDir   = path.join(home, 'snap', 'retroarch', 'current', '.config', 'retroarch', 'cores');
    const flatpakDir = path.join(home, '.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch', 'cores');
    const rp = String(retroarchPath || '');
    if (rp.includes('/snap/')) dirs.push(snapDir, plainDir, flatpakDir);
    else if (/flatpak|org\.libretro\.retroarch/i.test(rp)) dirs.push(flatpakDir, plainDir, snapDir);
    else dirs.push(plainDir, snapDir, flatpakDir);
  }
  return dirs;
}

function getCorePath(retroarchPath, platform) {
  const p = String(platform || '').toLowerCase();
  const coreId = PLATFORM_CORES[p];
  if (!coreId) return null;
  return firstExisting(getCoreDirs(retroarchPath).map(d => path.join(d, `${coreId}_libretro${CORE_EXT}`)));
}

// ── Installers ────────────────────────────────────────────────────────────────
// Returns { code, stderr } — stderr used to be discarded entirely
// (stdio:'ignore'), so a winget failure only ever surfaced as a bare exit
// code with no explanation (e.g. "exit 2316632107", one of winget's own
// HRESULT-style codes) and no way to tell the user what actually went wrong.
function runProcess(cmd, args, timeoutMs, spawnOpts) {
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code, stderr: Buffer.concat(chunks).toString('utf8').trim().slice(0, 600) });
    };
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...spawnOpts });
      child.stderr?.on('data', (d) => { if (chunks.length < 20) chunks.push(d); });
      const t = setTimeout(() => { try { child.kill(); } catch { } finish(-2); }, timeoutMs);
      child.on('exit', (code) => { clearTimeout(t); finish(code ?? -1); });
      child.on('error', (err) => { clearTimeout(t); chunks.push(Buffer.from(String(err && err.message ? err.message : err))); finish(-1); });
    } catch (e) {
      chunks.push(Buffer.from(String(e && e.message ? e.message : e)));
      finish(-1);
    }
  });
}

// sha256 of a file's contents — mirrors server.ts's sha256File(), used to
// verify a cloned core/BIOS file actually matches what the host's manifest
// said it should be, instead of trusting that "the zip extracted without
// throwing" means the file is intact.
async function sha256File(filePath) {
  try {
    const buf = await fsp.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// Checks every file the manifest listed hashes for; returns the filenames
// whose on-disk hash doesn't match (missing entirely counts as a mismatch).
async function verifyClonedHashes(dir, hashes) {
  const bad = [];
  for (const [name, expected] of Object.entries(hashes || {})) {
    const actual = await sha256File(path.join(dir, name));
    if (actual !== expected) bad.push(name);
  }
  return bad;
}

// Inverse of verifyClonedHashes — the filenames that are ALREADY present and
// correct, so the caller can tell the host's export endpoint to skip
// re-sending them (see `skip` param on fetchExtractAndVerify below).
async function findAlreadyGoodFiles(dir, hashes) {
  const good = [];
  for (const [name, expected] of Object.entries(hashes || {})) {
    const actual = await sha256File(path.join(dir, name));
    if (actual === expected) good.push(name);
  }
  return good;
}

// The buildbot's "stable" tree only keeps the most recent handful of
// releases — a hardcoded version number (this used to be a literal "1.19.1"
// right below) silently goes stale as new stable releases ship and old ones
// get pruned, turning the stable-fallback download into a permanent 404 with
// no obvious cause ("RetroArch download failed (HTTP 404 at .../1.19.1/...)").
// server.ts already carries this exact fix (getLatestRetroArchStableVersion) —
// this is a straight port of it, since this file has its own independent copy
// of the RetroArch-install logic that never got the same fix applied.
let _cachedStableVersion = null;
async function getLatestRetroArchStableVersion() {
  const FALLBACK = '1.22.2';
  if (_cachedStableVersion && Date.now() - _cachedStableVersion.ts < 24 * 3600_000) {
    return _cachedStableVersion.version;
  }
  try {
    const r = await fetch('https://buildbot.libretro.com/stable/', { signal: AbortSignal.timeout(8000) });
    const html = await r.text();
    const versions = [...html.matchAll(/stable\/(\d+\.\d+\.\d+)\//g)].map((m) => m[1]);
    if (versions.length > 0) {
      versions.sort((a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
        return 0;
      });
      const latest = versions[versions.length - 1];
      _cachedStableVersion = { version: latest, ts: Date.now() };
      return latest;
    }
  } catch { /* offline or buildbot unreachable — use the last-known-good fallback */ }
  return FALLBACK;
}

// Windows portable install, mirroring installRetroArchLinuxPortable's shape.
// Installs into <emulationRoot>/emulators/RetroArch when the user has picked
// a folder (POST /pick-folder) — winget instead installs system-wide and
// ignores that choice entirely, which is exactly the "pick once, always
// reused" gap this fixes. Falls back to emuRoot (the fixed clientRoot
// default) only when no folder has been picked yet.
//
// As of 2026 the buildbot no longer ships a plain RetroArch.zip for Windows
// at all (only RetroArch.7z, RetroArch-Win64-setup.exe, RetroArch_cores.7z) —
// requesting the old .zip URL 404s unconditionally, independent of (and on
// top of) the version-staleness bug this function already had fixed. Uses
// the same 7zip-bin-backed extraction as installRetroArchLinuxPortable
// instead of adm-zip, which can't open 7z archives.
async function installRetroArchWindowsPortable() {
  const cfg = loadConfig();
  const installRoot = path.join(cfg.emulationRoot ? path.join(cfg.emulationRoot, 'emulators') : emuRoot, 'RetroArch');
  ensureDirSync(installRoot);
  const downloadDir = path.join(installRoot, '_download');
  ensureDirSync(downloadDir);
  const archivePath = path.join(downloadDir, 'RetroArch.7z');

  const stableVersion = await getLatestRetroArchStableVersion();
  const urls = [
    'https://buildbot.libretro.com/nightly/windows/x86_64/RetroArch.7z',
    `https://buildbot.libretro.com/stable/${stableVersion}/windows/x86_64/RetroArch.7z`,
  ];
  let downloaded = false;
  // Collects every attempt's failure, not just the last one — with a single
  // overwritten `lastErr`, a failure on the FIRST (nightly) URL was silently
  // discarded the moment the second (stable) URL also failed, leaving the
  // shown error looking like only the stable download had a problem when the
  // nightly one may have failed for an entirely different, unreported reason.
  const errors = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) { errors.push(`HTTP ${res.status} at ${url}`); continue; }
      await fsp.writeFile(archivePath, Buffer.from(await res.arrayBuffer()));
      downloaded = true;
      break;
    } catch (e) { errors.push(`${String(e && e.message ? e.message : e)} at ${url}`); }
  }
  if (!downloaded) throw new Error(`RetroArch download failed (${errors.join('; ') || 'no source succeeded'})`);

  const { path7za } = require('7zip-bin');
  const { code, stderr } = await runProcess(path7za, ['x', archivePath, `-o${downloadDir}`, '-y'], 180_000);
  if (code !== 0) throw new Error(`RetroArch.7z extraction failed (exit ${code}${stderr ? ` — ${stderr}` : ''})`);
  fs.rmSync(archivePath, { force: true });

  const findExe = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findExe(full); if (found) return found; }
      else if (entry.name.toLowerCase() === 'retroarch.exe') return full;
    }
    return null;
  };
  const extractedExe = findExe(downloadDir);
  if (!extractedExe) throw new Error('RetroArch.7z extracted but retroarch.exe was not found');

  // Move the extracted tree up out of the _download subfolder into installRoot.
  // renameDirWithRetry (not a plain fs.renameSync) — Defender/Search indexing
  // routinely holds a brief lock on files right after extraction (the
  // "assets" folder especially, since it's dozens of freshly-written files),
  // which turned this into a reproducible EPERM install failure rather than
  // a rare fluke. See its own comment for the retry+copy-fallback strategy.
  const extractedDir = path.dirname(extractedExe);
  for (const entry of fs.readdirSync(extractedDir)) {
    try {
      await renameDirWithRetry(path.join(extractedDir, entry), path.join(installRoot, entry));
    } catch (e) {
      throw new Error(`Could not move extracted "${entry}" into place: ${e && e.message ? e.message : e}`);
    }
  }
  fs.rmSync(downloadDir, { recursive: true, force: true });

  const exePath = path.join(installRoot, 'retroarch.exe');
  if (!fs.existsSync(exePath)) throw new Error('RetroArch extracted but retroarch.exe is missing from the final location');

  // Persist so getEmulatorPath() finds it via its existing cfg.emulators.retroarch
  // override slot — no new candidate path needed, just wire the config through.
  return persistEmulatorPath('retroarch', exePath, cfg);
}

// Standalone-emulator platforms (PS2, GameCube, PS3, PSP, Wii U) have never
// had any auto-install path — handleLaunch just failed outright with "No
// emulator found", telling the user to place one manually. That's a real
// gap in "auto setup ... play any game": RetroArch auto-installs, but a PS2
// game (the single most common standalone-emulator case) never did. This
// covers PCSX2 the same way installRetroArchWindowsPortable covers
// RetroArch — a portable 7z build, no GUI installer, queried from GitHub's
// release API each time so the URL never goes stale.
let _cachedPcsx2ReleaseAsset = null;
async function getLatestPcsx2WindowsAssetUrl() {
  if (_cachedPcsx2ReleaseAsset && Date.now() - _cachedPcsx2ReleaseAsset.ts < 24 * 3600_000) {
    return _cachedPcsx2ReleaseAsset.url;
  }
  const res = await fetch('https://api.github.com/repos/PCSX2/pcsx2/releases/latest', {
    headers: { 'User-Agent': 'NexusEmuLauncher' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
  const data = await res.json();
  const asset = (data.assets || []).find((a) => /windows-x64-Qt\.7z$/i.test(a.name || ''));
  if (!asset) throw new Error('Could not find a windows-x64-Qt.7z asset in the latest PCSX2 release');
  _cachedPcsx2ReleaseAsset = { url: asset.browser_download_url, ts: Date.now() };
  return asset.browser_download_url;
}

async function installPCSX2WindowsPortable() {
  const cfg = loadConfig();
  const installRoot = path.join(cfg.emulationRoot ? path.join(cfg.emulationRoot, 'emulators') : emuRoot, 'PCSX2');
  ensureDirSync(installRoot);
  const downloadDir = path.join(installRoot, '_download');
  ensureDirSync(downloadDir);
  const archivePath = path.join(downloadDir, 'PCSX2.7z');

  const url = await getLatestPcsx2WindowsAssetUrl();
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`PCSX2 download failed (HTTP ${res.status} at ${url})`);
  await fsp.writeFile(archivePath, Buffer.from(await res.arrayBuffer()));

  const { path7za } = require('7zip-bin');
  const { code, stderr } = await runProcess(path7za, ['x', archivePath, `-o${downloadDir}`, '-y'], 180_000);
  if (code !== 0) throw new Error(`PCSX2.7z extraction failed (exit ${code}${stderr ? ` — ${stderr}` : ''})`);
  fs.rmSync(archivePath, { force: true });

  const findExe = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findExe(full); if (found) return found; }
      else if (entry.name.toLowerCase() === 'pcsx2-qt.exe') return full;
    }
    return null;
  };
  const extractedExe = findExe(downloadDir);
  if (!extractedExe) throw new Error('PCSX2.7z extracted but pcsx2-qt.exe was not found inside it');

  // Same Defender-lock-tolerant move as RetroArch's install — see
  // renameDirWithRetry's own comment for why a plain rename isn't enough.
  const extractedDir = path.dirname(extractedExe);
  for (const entry of fs.readdirSync(extractedDir)) {
    try {
      await renameDirWithRetry(path.join(extractedDir, entry), path.join(installRoot, entry));
    } catch (e) {
      throw new Error(`Could not move extracted "${entry}" into place: ${e && e.message ? e.message : e}`);
    }
  }
  fs.rmSync(downloadDir, { recursive: true, force: true });

  const exePath = path.join(installRoot, 'pcsx2-qt.exe');
  if (!fs.existsSync(exePath)) throw new Error('PCSX2 extracted but pcsx2-qt.exe is missing from the final location');

  // Portable mode (an empty portable.ini next to the exe) makes PCSX2 look
  // for its bios/ folder inside its OWN install directory instead of
  // %USERPROFILE%\Documents\PCSX2 — without this, a BIOS already cloned
  // from the host into cfg.emulationRoot/bios (see /clone-host-setup) is
  // completely invisible to a freshly-installed PCSX2, which still shows
  // its first-run "PCSX2 requires a PS2 BIOS" wizard even though the client
  // already has one. Copying (not symlinking) into the portable bios/
  // folder is deliberate: it survives PCSX2 rewriting its own config, and
  // doesn't depend on Windows symlink privileges being available.
  try {
    fs.writeFileSync(path.join(installRoot, 'portable.ini'), '', 'utf8');
    const sourceBiosDir = cfg.emulationRoot ? path.join(cfg.emulationRoot, 'bios') : null;
    let biosFilename = null;
    if (sourceBiosDir && fs.existsSync(sourceBiosDir)) {
      const destBiosDir = path.join(installRoot, 'bios');
      ensureDirSync(destBiosDir);
      for (const entry of fs.readdirSync(sourceBiosDir)) {
        const src = path.join(sourceBiosDir, entry);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(destBiosDir, entry));
          // A real PS2 BIOS dump is a multi-MB .bin; its .mec/.nvm siblings
          // are a few bytes each and aren't the BIOS image PCSX2 wants
          // selected — only match those so a mixed bios/ folder doesn't
          // pick the wrong (tiny, non-bootable) file as "the" BIOS.
          if (/\.bin$/i.test(entry) && !biosFilename) biosFilename = entry;
        }
      }
    }

    // PCSX2 correctly auto-detects a BIOS placed in bios/ (confirmed: its
    // own generated ini picks the right [Filenames] BIOS= entry on its
    // very first run) — but that first run still shows its "PCSX2 requires
    // a PS2 BIOS" setup wizard regardless, because SetupWizardIncomplete
    // only ever flips to false once a human clicks through it manually.
    // Since the BIOS is already known-good at this point, pre-seeding a
    // minimal ini with the wizard already marked complete (and the BIOS
    // pre-selected) skips a dead-end dialog for something that's already
    // fully configured. PCSX2 fills in every other key with its own
    // defaults on first run — an ini only needs to define the keys that
    // actually differ from those defaults.
    if (biosFilename) {
      const inisDir = path.join(installRoot, 'inis');
      ensureDirSync(inisDir);
      const seedIni = [
        '[UI]',
        'SettingsVersion = 1',
        'SetupWizardIncomplete = false',
        '',
        '[Folders]',
        'Bios = bios',
        '',
        '[Filenames]',
        `BIOS = ${biosFilename}`,
        '',
      ].join('\r\n');
      fs.writeFileSync(path.join(inisDir, 'PCSX2.ini'), seedIni, 'utf8');
    }
  } catch { /* best effort — PCSX2 still runs, just shows its own BIOS wizard if this didn't work */ }

  return persistEmulatorPath('pcsx2', exePath, cfg);
}

// "The host already has this working — just copy it" instead of the client
// re-sourcing cores/BIOS on its own. Cores could already be auto-downloaded
// (RetroArch's buildbot), but BIOS files never can (copyrighted firmware) —
// this is the one setup step that has no other automatable path, which is
// the actual point of this feature. Deliberately only ever writes into
// cfg.emulationRoot's cores/bios subfolders — never touches saves/states,
// so the client's own profile and progress are untouched by cloning
// someone else's setup.
//
// Extracted out of the /clone-host-setup HTTP handler (which now just calls
// this and returns its result) so handleLaunch can also call it directly —
// previously "auto setup" meant clicking a separate "Auto-Install from
// Host" button before Play would work at all; a first-time Play on a
// completely bare client still hit "No emulator found" / a missing-core
// RetroArch launch even though everything needed was one clone away.
// Everything the clone writes (roms/cores/bios/saves/states) lives under one
// root. When the user hasn't picked one, fall back to a sane default inside the
// client root rather than refusing to run.
//
// This used to hard-fail with "Choose a folder first (pick-folder)", which on
// the current desktop build was unrecoverable: /pick-folder is the ONLY way to
// set emulationRoot and it required Electron's native dialog — and this project
// has fully migrated to Tauri, so require('electron') throws MODULE_NOT_FOUND on
// every install. The picker returned 500, emulationRoot stayed empty, and so
// auto-setup AND first-time Play (handleLaunch calls straight through to here)
// failed permanently on every fresh client with no way for the user to fix it.
function ensureEmulationRoot(cfg) {
  if (cfg.emulationRoot) return cfg.emulationRoot;
  const root = path.join(clientRoot, 'Emulation');
  for (const sub of ['roms', 'cores', 'bios', 'saves', 'states', 'screenshots']) {
    ensureDirSync(path.join(root, sub));
  }
  cfg.emulationRoot = root;
  if (!cfg.romDirectory || cfg.romDirectory === defaultRomDir) {
    cfg.romDirectory = path.join(root, 'roms');
  }
  saveConfig(cfg);
  console.log(`[client-launcher] no emulation folder chosen — defaulting to ${root}`);
  return root;
}

async function performCloneHostSetup(hostUrl, token) {
  const cfg = loadConfig();
  ensureEmulationRoot(cfg);

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  let manifest;
  try {
    const manifestRes = await fetch(`${hostUrl}/api/emulator/export/manifest`, { headers: authHeaders });
    if (!manifestRes.ok) return { ok: false, error: `Could not read host manifest: HTTP ${manifestRes.status}` };
    manifest = await manifestRes.json();
  } catch (e) {
    return { ok: false, error: `Could not reach host: ${e && e.message ? e.message : e}` };
  }

  const AdmZip = require('adm-zip');
  const steps = [];

  // Downloads+extracts the zip, verifies every file the manifest gave a hash
  // for, and retries once (fresh re-download+re-extract) if anything came
  // back corrupt/truncated — presence/count alone used to be trusted as "it
  // worked," so a bad download looked identical to a good one until the
  // core/BIOS actually failed to load in-game. On the first attempt, files
  // this client already has with a matching hash are sent as `skip` so the
  // host only zips up what's actually missing/changed — re-running "clone
  // host setup" used to re-transfer the entire cores/BIOS set every time.
  async function fetchExtractAndVerify(exportUrl, destDir, hashes) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const skip = attempt === 1 ? await findAlreadyGoodFiles(destDir, hashes) : [];
      const url = skip.length ? `${exportUrl}?skip=${encodeURIComponent(skip.join(','))}` : exportUrl;
      const r = await fetch(url, { headers: authHeaders });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (r.status !== 204) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0) new AdmZip(buf).extractAllTo(destDir, true);
      }
      const bad = await verifyClonedHashes(destDir, hashes);
      if (bad.length === 0) return { attempt, bad: [], skipped: skip.length };
      if (attempt === 2) return { attempt, bad };
    }
    return { attempt: 2, bad: [] };
  }

  // A core is compiled native code — a Linux host's cores are *.so files
  // that a Windows/Mac client can genuinely never load, no matter how
  // faithfully they're copied. This used to copy them anyway and report
  // "verified" (the hash of a correctly-copied but wrong-platform file
  // still matches), which looked identical to success while leaving the
  // client with zero usable cores. Skipped entirely when none of the
  // host's cores could ever work on this OS, rather than burning
  // bandwidth/time copying files that will just sit there unusable. Play
  // itself doesn't depend on this either way — it fetches the correct
  // per-platform core straight from RetroArch's buildbot the moment a game
  // actually needs one (see ensureRetroArchCore).
  const hostCoreFiles = manifest.cores?.files || [];
  const crossPlatformCores = manifest.cores?.available && hostCoreFiles.length > 0 && !hostCoreFiles.some((f) => f.endsWith(CORE_EXT));
  if (crossPlatformCores) {
    steps.push({ name: 'Cores', ok: true, detail: `Host's cores are for a different OS (not ${CORE_EXT}) — skipped copying unusable files. Play fetches the right core automatically instead.` });
  } else if (manifest.cores?.available) {
    try {
      const { attempt, bad, skipped } = await fetchExtractAndVerify(
        `${hostUrl}/api/emulator/export/cores`, path.join(cfg.emulationRoot, 'cores'), manifest.cores.hashes
      );
      if (bad.length === 0) {
        const already = skipped ? `, ${skipped} already up to date` : '';
        steps.push({ name: 'Cores', ok: true, detail: `${manifest.cores.count} core(s) verified${already}${attempt > 1 ? ' (retried once)' : ''}` });
      } else {
        steps.push({ name: 'Cores', ok: false, detail: `Verification failed after retry for: ${bad.join(', ')}` });
      }
    } catch (e) {
      steps.push({ name: 'Cores', ok: false, detail: String(e && e.message ? e.message : e) });
    }
  } else {
    steps.push({ name: 'Cores', ok: false, detail: 'Host has no cores installed' });
  }

  if (manifest.bios?.available) {
    try {
      const { attempt, bad, skipped } = await fetchExtractAndVerify(
        `${hostUrl}/api/emulator/export/bios`, path.join(cfg.emulationRoot, 'bios'), manifest.bios.hashes
      );
      if (bad.length === 0) {
        const already = skipped ? `, ${skipped} already up to date` : '';
        steps.push({ name: 'BIOS', ok: true, detail: `${manifest.bios.count} file(s) verified${already}${attempt > 1 ? ' (retried once)' : ''}` });
      } else {
        steps.push({ name: 'BIOS', ok: false, detail: `Verification failed after retry for: ${bad.join(', ')}` });
      }
    } catch (e) {
      steps.push({ name: 'BIOS', ok: false, detail: String(e && e.message ? e.message : e) });
    }
  } else {
    steps.push({ name: 'BIOS', ok: false, detail: 'Host has no BIOS files configured' });
  }

  // RetroArch itself isn't cloned from the host binary-for-binary (wrong
  // platform half the time) — reuse the portable installer instead, which
  // already picks the right build for this machine.
  const existingEmu = getEmulatorPath('nes');
  if (!existingEmu) {
    try {
      const installed = await ensureRetroArchInstalled();
      steps.push({ name: 'RetroArch', ok: !!installed.ok, detail: installed.detail || (installed.ok ? 'Installed' : 'Install failed') });
    } catch (e) {
      steps.push({ name: 'RetroArch', ok: false, detail: String(e && e.message ? e.message : e) });
    }
  } else {
    steps.push({ name: 'RetroArch', ok: true, detail: `Already present: ${existingEmu}` });
  }

  // Standalone emulators (PCSX2, Dolphin, RPCS3, Switch) — cloning the
  // host's own already-working install closes the gap for whichever of
  // these don't have their own portable-download auto-installer (Dolphin,
  // and Switch emulators, which have no verified public download source —
  // see installStandaloneEmulatorPortable's own comment). Best-effort: a
  // client that already has its own copy, or whose host doesn't have one
  // (e.g. a Linux host binary can't run on a Windows client), just skips.
  try {
    const standaloneRes = await fetch(`${hostUrl}/api/emulator/export/standalone/manifest`, { headers: authHeaders });
    if (standaloneRes.ok) {
      const standaloneManifest = await standaloneRes.json();
      const STANDALONE_TARGETS = [
        { key: 'pcsx2', platform: 'ps2', folder: 'PCSX2', label: 'PCSX2', exeMap: [['pcsx2-qt.exe', 'pcsx2'], ['pcsx2.exe', 'pcsx2']] },
        { key: 'dolphin', platform: 'gamecube', folder: 'Dolphin', label: 'Dolphin', exeMap: [['Dolphin.exe', 'dolphin']] },
        { key: 'rpcs3', platform: 'ps3', folder: 'RPCS3', label: 'RPCS3', exeMap: [['rpcs3.exe', 'rpcs3']] },
        // Switch emulators: the host could be running Eden or Ryujinx
        // (detectSwitchEmuPath() checks both, Eden first) — each has its
        // own cfg.emulators slot, so which one gets written depends on
        // which exe name actually shows up after extraction.
        { key: 'switch', platform: 'switch', folder: 'Switch', label: 'Switch Emulator', exeMap: [['eden.exe', 'eden'], ['Ryujinx.exe', 'ryujinx']] },
      ];
      for (const target of STANDALONE_TARGETS) {
        const info = standaloneManifest[target.key];
        if (!info?.available) continue; // host doesn't have a clonable copy — nothing to do
        if (getEmulatorPath(target.platform)) continue; // client already has one of its own
        try {
          const destDir = path.join(cfg.emulationRoot, target.folder);
          const { attempt, bad, skipped } = await fetchExtractAndVerify(
            `${hostUrl}/api/emulator/export/standalone?name=${target.key}`,
            destDir,
            info.hashes,
          );
          if (bad.length === 0) {
            // Persist so getEmulatorPath() finds it via its cfg.emulators.<key>
            // override slot — same pattern ensureRetroArchInstalled() already
            // uses. Without this, the clone lands on disk but stays
            // permanently invisible to launch/preflight, which only ever
            // check the fixed <clientRoot>/Emulators path, not cfg.emulationRoot.
            const match = target.exeMap
              .map(([name, configKey]) => ({ exePath: path.join(destDir, name), configKey }))
              .find((m) => fs.existsSync(m.exePath));
            if (match) {
              // Re-read the config instead of writing the `cfg` captured at the
              // top of performCloneHostSetup. Steps in between (notably
              // ensureRetroArchInstalled -> installRetroArchWindowsPortable)
              // persist their OWN emulator paths through a separately-loaded
              // config, so saving the stale object here silently reverted them:
              // a real run finished with rpcs3 recorded but "retroarch": ""
              // even though RetroArch had just installed successfully. That
              // wiped path is unrecoverable — RetroArch installs under
              // <emulationRoot>/emulators/, so losing the config entry meant
              // every RetroArch platform (NES/SNES/N64/GBA/Genesis/PS1 — most
              // of a library) failed at launch with "No emulator found".
              persistEmulatorPath(match.configKey, match.exePath, cfg);
            }
            const already = skipped ? `, ${skipped} already up to date` : '';
            const foundNote = match ? '' : ' (files copied but executable not found at the expected name — check manually)';
            steps.push({ name: target.label, ok: !!match, detail: `${info.count} file(s) verified${already}${attempt > 1 ? ' (retried once)' : ''}${foundNote}` });
          } else {
            steps.push({ name: target.label, ok: false, detail: `Verification failed after retry for: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}` });
          }
        } catch (e) {
          steps.push({ name: target.label, ok: false, detail: String(e && e.message ? e.message : e) });
        }
      }
    }
  } catch {
    // Host doesn't support standalone-emulator export (older host version) — not fatal, cores/BIOS already handled above.
  }

  return { ok: steps.every((s) => s.ok), steps };
}

async function ensurePCSX2Installed() {
  const existing = getEmulatorPath('ps2');
  if (existing) return { ok: true, installed: false, path: existing, detail: 'PCSX2 already present' };
  if (!IS_WIN) {
    return { ok: false, detail: 'Automatic PCSX2 install is currently Windows-only — install it via your package manager, then set its path in Client Setup.' };
  }
  try {
    const installed = await installPCSX2WindowsPortable();
    return { ok: true, installed: true, path: installed, detail: 'PCSX2 installed (portable)' };
  } catch (e) {
    return { ok: false, detail: `PCSX2 install failed: ${e && e.message ? e.message : e}. Install manually from pcsx2.net, then retry.` };
  }
}

// Shared shape for the other standalone-emulator auto-installs (RPCS3,
// PPSSPP, Cemu) — same portable-archive-from-GitHub pattern as PCSX2's own
// installer, just parameterized so each emulator isn't its own near-copy of
// the same download/extract/relocate logic. Dolphin (GameCube/Wii) isn't
// included here: unlike these three, it doesn't publish through GitHub
// Releases (their real distribution is dolphin-emu.org's own updater API),
// and guessing at an unverified download URL risks silently shipping a
// broken/stale link — better to leave it manual for now than pretend it's
// covered.
async function installStandaloneEmulatorPortable({ name, folderName, githubRepo, assetPattern, archiveType, exeNames, configKey }) {
  const cfg = loadConfig();
  const installRoot = path.join(cfg.emulationRoot ? path.join(cfg.emulationRoot, 'emulators') : emuRoot, folderName);
  ensureDirSync(installRoot);
  const downloadDir = path.join(installRoot, '_download');
  ensureDirSync(downloadDir);

  const releaseRes = await fetch(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
    headers: { 'User-Agent': 'NexusEmuLauncher' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!releaseRes.ok) throw new Error(`GitHub API returned HTTP ${releaseRes.status}`);
  const release = await releaseRes.json();
  const asset = (release.assets || []).find((a) => assetPattern.test(a.name || ''));
  if (!asset) throw new Error(`Could not find a matching Windows asset in the latest ${name} release`);

  const archivePath = path.join(downloadDir, `archive.${archiveType}`);
  const dlRes = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) });
  if (!dlRes.ok) throw new Error(`${name} download failed (HTTP ${dlRes.status} at ${asset.browser_download_url})`);
  await fsp.writeFile(archivePath, Buffer.from(await dlRes.arrayBuffer()));

  if (archiveType === '7z') {
    const { path7za } = require('7zip-bin');
    const { code, stderr } = await runProcess(path7za, ['x', archivePath, `-o${downloadDir}`, '-y'], 180_000);
    if (code !== 0) throw new Error(`${name} archive extraction failed (exit ${code}${stderr ? ` — ${stderr}` : ''})`);
  } else {
    const AdmZip = require('adm-zip');
    new AdmZip(archivePath).extractAllTo(downloadDir, true);
  }
  fs.rmSync(archivePath, { force: true });

  const findExe = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findExe(full); if (found) return found; }
      else if (exeNames.includes(entry.name.toLowerCase())) return full;
    }
    return null;
  };
  const extractedExe = findExe(downloadDir);
  if (!extractedExe) throw new Error(`${name} extracted but its executable was not found inside the archive`);

  // Same Defender-lock-tolerant move as PCSX2/RetroArch's own installers.
  const extractedDir = path.dirname(extractedExe);
  for (const entry of fs.readdirSync(extractedDir)) {
    try {
      await renameDirWithRetry(path.join(extractedDir, entry), path.join(installRoot, entry));
    } catch (e) {
      throw new Error(`Could not move extracted "${entry}" into place: ${e && e.message ? e.message : e}`);
    }
  }
  fs.rmSync(downloadDir, { recursive: true, force: true });

  const exePath = path.join(installRoot, path.basename(extractedExe));
  if (!fs.existsSync(exePath)) throw new Error(`${name} extracted but its executable is missing from the final location`);

  return persistEmulatorPath(configKey, exePath, cfg);
}

async function ensureRPCS3Installed() {
  const existing = getEmulatorPath('ps3');
  if (existing) return { ok: true, installed: false, path: existing, detail: 'RPCS3 already present' };
  if (!IS_WIN) return { ok: false, detail: 'Automatic RPCS3 install is currently Windows-only — install it manually, then set its path in Client Setup.' };
  try {
    const installed = await installStandaloneEmulatorPortable({
      name: 'RPCS3', folderName: 'RPCS3', githubRepo: 'RPCS3/rpcs3-binaries-win',
      assetPattern: /win64_msvc\.7z$/i, archiveType: '7z', exeNames: ['rpcs3.exe'], configKey: 'rpcs3',
    });
    return { ok: true, installed: true, path: installed, detail: 'RPCS3 installed (portable). PS3 firmware still needs installing once — RPCS3 will prompt for it on first run (Settings > Install Firmware), same "must come from a console you own" legal requirement as any BIOS.' };
  } catch (e) {
    return { ok: false, detail: `RPCS3 install failed: ${e && e.message ? e.message : e}. Install manually from rpcs3.net, then retry.` };
  }
}

async function ensurePPSSPPInstalled() {
  const existing = getEmulatorPath('psp');
  if (existing) return { ok: true, installed: false, path: existing, detail: 'PPSSPP already present' };
  if (!IS_WIN) return { ok: false, detail: 'Automatic PPSSPP install is currently Windows-only — install it manually, then set its path in Client Setup.' };
  try {
    const installed = await installStandaloneEmulatorPortable({
      name: 'PPSSPP', folderName: 'PPSSPP', githubRepo: 'hrydgard/ppsspp',
      assetPattern: /-Windows-x64\.zip$/i, archiveType: 'zip', exeNames: ['ppssppwindows64.exe'], configKey: 'ppsspp',
    });
    return { ok: true, installed: true, path: installed, detail: 'PPSSPP installed (portable)' };
  } catch (e) {
    return { ok: false, detail: `PPSSPP install failed: ${e && e.message ? e.message : e}. Install manually from ppsspp.org, then retry.` };
  }
}

async function ensureCemuInstalled() {
  const existing = getEmulatorPath('wiiu');
  if (existing) return { ok: true, installed: false, path: existing, detail: 'Cemu already present' };
  if (!IS_WIN) return { ok: false, detail: 'Automatic Cemu install is currently Windows-only — install it manually, then set its path in Client Setup.' };
  try {
    const installed = await installStandaloneEmulatorPortable({
      name: 'Cemu', folderName: 'Cemu', githubRepo: 'cemu-project/Cemu',
      assetPattern: /-windows-x64\.zip$/i, archiveType: 'zip', exeNames: ['cemu.exe'], configKey: 'cemu',
    });
    return { ok: true, installed: true, path: installed, detail: 'Cemu installed (portable). Wii U games also need decrypted keys.txt for most titles — same manual/legal step Cemu itself requires.' };
  } catch (e) {
    return { ok: false, detail: `Cemu install failed: ${e && e.message ? e.message : e}. Install manually from cemu.info, then retry.` };
  }
}

async function ensureRetroArchInstalled() {
  const existing = getEmulatorPath('nes');
  if (existing) return { ok: true, installed: false, path: existing, detail: 'RetroArch already present' };
  if (IS_WIN) {
    try {
      const installed = await installRetroArchWindowsPortable();
      return { ok: true, installed: true, path: installed, detail: 'RetroArch installed (portable)' };
    } catch (e) {
      // Portable download failing (offline buildbot, blocked network) still
      // has winget as a last resort — just no longer the first choice, since
      // it can't respect the user's picked emulationRoot.
      const wingetResult = await runProcess('winget', [
        'install', '-e', '--id', 'Libretro.RetroArch',
        '--accept-source-agreements', '--accept-package-agreements', '--silent',
      ], 10 * 60_000).catch((err) => ({ code: -1, stderr: String(err && err.message ? err.message : err) }));
      const found = getEmulatorPath('nes');
      if (found) return { ok: true, installed: true, path: found, detail: 'RetroArch installed via winget (portable download failed first)' };
      const wingetDetail = wingetResult.stderr ? ` — ${wingetResult.stderr}` : '';
      return { ok: false, detail: `RetroArch install failed — portable download (${e && e.message ? e.message : e}) and winget (exit ${wingetResult.code}${wingetDetail}) both failed. Install from retroarch.com, then retry.` };
    }
  }
  if (!IS_MAC) {
    // Same portable-AppImage approach as server.ts's installRetroArchLinuxPortable
    // — no sudo/snap needed, so a client machine with nothing preinstalled can
    // still get a working emulator on the first "This is my host"/client setup
    // instead of dead-ending with "install it yourself".
    try {
      const installed = await installRetroArchLinuxPortable();
      return { ok: true, installed: true, path: installed, detail: 'RetroArch installed (portable)' };
    } catch (e) {
      return {
        ok: false,
        detail: `Portable install failed (${e && e.message ? e.message : e}) — install RetroArch via your package manager (e.g. "sudo snap install retroarch"), then retry.`,
      };
    }
  }
  // Automatic system-level installs need elevation on macOS — be honest.
  return {
    ok: false,
    detail: 'Automatic install is not available on macOS — download RetroArch from retroarch.com and place it in /Applications.',
  };
}

async function installRetroArchLinuxPortable() {
  const installRoot = path.join(emuRoot, 'RetroArch');
  ensureDirSync(installRoot);
  const downloadDir = path.join(installRoot, '_download');
  ensureDirSync(downloadDir);
  const archivePath = path.join(downloadDir, 'RetroArch.7z');

  const res = await fetch('https://buildbot.libretro.com/nightly/linux/x86_64/RetroArch.7z', { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await fsp.writeFile(archivePath, Buffer.from(await res.arrayBuffer()));

  const { path7za } = require('7zip-bin');
  await runProcess(path7za, ['x', archivePath, `-o${downloadDir}`, '-y'], 180_000);

  const findAppImage = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findAppImage(full); if (found) return found; }
      else if (entry.name === 'RetroArch-Linux-x86_64.AppImage') return full;
    }
    return null;
  };
  const appImage = findAppImage(downloadDir);
  if (!appImage) throw new Error('RetroArch.7z extracted but the AppImage was not found inside it');
  fs.chmodSync(appImage, 0o755);

  await runProcess(appImage, ['--appimage-extract'], 60_000, { cwd: installRoot });
  const binPath = path.join(installRoot, 'squashfs-root', 'usr', 'bin', 'retroarch');
  fs.accessSync(binPath, fs.constants.X_OK);

  fs.rmSync(downloadDir, { recursive: true, force: true });
  return binPath;
}

function coreFileName(coreId) {
  if (IS_WIN) return `${coreId}_libretro.dll.zip`;
  if (IS_MAC) return `${coreId}_libretro.dylib.zip`;
  return `${coreId}_libretro.so.zip`;
}

function coreOsArch() {
  const os = IS_WIN ? 'windows' : IS_MAC ? 'osx' : 'linux';
  const arch = (IS_MAC && process.arch === 'arm64') ? 'arm64' : 'x86_64';
  return { os, arch };
}

function buildbotCoreUrl(coreId) {
  const { os, arch } = coreOsArch();
  if (os === 'windows') return `https://buildbot.libretro.com/nightly/windows/x86_64/latest/${coreFileName(coreId)}`;
  if (os === 'osx') return `https://buildbot.libretro.com/nightly/apple/osx/${arch}/latest/${coreFileName(coreId)}`;
  return `https://buildbot.libretro.com/nightly/linux/x86_64/latest/${coreFileName(coreId)}`;
}

// Where to look for a core, best source first. The HOST's own mirror comes
// ahead of buildbot.libretro.com deliberately: pressing Play should not depend
// on a third-party build server being up and un-rate-limited at that exact
// moment. The host fetches each core from upstream exactly once, then serves it
// to every device on the network from local disk forever after. Upstream stays
// as a fallback so a client that cannot reach its host (or a host with no
// internet on first use) is never worse off than before.
function coreDownloadUrls(coreId) {
  const urls = [];
  // The host URL lives in preferred-host-url.txt (written by POST /config), NOT
  // in launcher-config.json — reading it off the config object silently yields
  // undefined and would quietly skip the mirror entirely, sending every client
  // straight back to the external buildbot this exists to avoid.
  let host = '';
  try { host = fs.readFileSync(hostUrlFile, 'utf8').trim().replace(/\/+$/, ''); } catch { /* none recorded yet */ }
  if (host) {
    const { os, arch } = coreOsArch();
    urls.push(`${host}/api/emulator/native-core/${os}/${arch}/${coreFileName(coreId)}`);
  }
  urls.push(buildbotCoreUrl(coreId));
  return urls;
}

function pickWritableCoreDir(retroarchPath) {
  for (const dir of getCoreDirs(retroarchPath)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try next */ }
  }
  const fallback = path.join(emuRoot, 'RetroArch', 'cores');
  ensureDirSync(fallback);
  return fallback;
}

// Some libretro cores need supporting system files that don't ship inside
// the core .dll — RetroArch's own UI installs these via "Online Updater ->
// Core System Files Downloader". The Dolphin core is one: without them it
// logs "Core file codehandler.bin missing!" and then fails to boot any
// GameCube/Wii disc, which from the outside is just a game that refuses to
// start. Pulled from the same buildbot the cores come from (verified:
// assets/system/Dolphin.zip, 3.2 MB, HTTP 200) and extracted into
// RetroArch's system/ directory, which is exactly where the core looks
// (confirmed from its own GET_SYSTEM_DIRECTORY log line). The archive is
// already laid out as dolphin-emu/Sys/... so it extracts straight in.
const CORE_SYSTEM_FILES = {
  dolphin: { url: 'https://buildbot.libretro.com/assets/system/Dolphin.zip', marker: path.join('dolphin-emu', 'Sys', 'codehandler.bin') },
};

async function ensureCoreSystemFiles(retroarchPath, coreId) {
  const spec = CORE_SYSTEM_FILES[coreId];
  if (!spec) return { ok: true, detail: 'No system files needed' };
  const systemDir = path.join(path.dirname(retroarchPath), 'system');
  if (fs.existsSync(path.join(systemDir, spec.marker))) {
    return { ok: true, installed: false, detail: 'System files already present' };
  }
  try {
    const res = await fetch(spec.url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) return { ok: false, detail: `System files download failed: HTTP ${res.status}` };
    ensureDirSync(systemDir);
    const AdmZip = require('adm-zip');
    new AdmZip(Buffer.from(await res.arrayBuffer())).extractAllTo(systemDir, true);
    const ok = fs.existsSync(path.join(systemDir, spec.marker));
    return ok
      ? { ok: true, installed: true, detail: 'System files installed' }
      : { ok: false, detail: 'System files extracted but expected file is missing' };
  } catch (e) {
    return { ok: false, detail: `System files install failed: ${e && e.message ? e.message : e}` };
  }
}

async function ensureRetroArchCore(retroarchPath, platform) {
  const existing = getCorePath(retroarchPath, platform);
  if (existing) return { ok: true, installed: false, path: existing, detail: 'Core already present' };
  const p = String(platform || '').toLowerCase();
  const coreId = PLATFORM_CORES[p];
  if (!coreId) return { ok: true, detail: `No core mapping for '${platform}'` };
  try {
    const sources = coreDownloadUrls(coreId);
    let buf = null;
    let lastDetail = '';
    for (const url of sources) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) { lastDetail = `HTTP ${res.status}`; continue; }
        const got = Buffer.from(await res.arrayBuffer());
        // A mirror that answers 200 with an error page (or an empty body) must
        // not be mistaken for a core — every real core zip is far bigger.
        if (got.length < 4096) { lastDetail = `suspiciously small (${got.length} bytes)`; continue; }
        buf = got;
        console.log(`[client-launcher] core ${coreId} from ${url.includes('/api/emulator/native-core/') ? 'host mirror' : 'libretro buildbot'}`);
        break;
      } catch (e) {
        lastDetail = e && e.message ? e.message : String(e);
      }
    }
    if (!buf) return { ok: false, coreId, detail: `Core download failed: ${lastDetail || 'no source reachable'}` };
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buf);
    const coresDir = pickWritableCoreDir(retroarchPath);
    zip.extractAllTo(coresDir, true);
    const after = firstExisting([path.join(coresDir, `${coreId}_libretro${CORE_EXT}`), getCorePath(retroarchPath, platform)]);
    if (after) return { ok: true, installed: true, coreId, path: after, detail: 'Core installed' };
    return { ok: false, coreId, detail: 'Core install attempted but not detected' };
  } catch (e) {
    return { ok: false, coreId, detail: `Core download failed: ${e && e.message ? e.message : e}` };
  }
}

// ── ROM download + launch ────────────────────────────────────────────────────
// The host answers /api/games/<id>/download with
//   Content-Disposition: attachment; filename="Battletoads in Battlemaniacs (USA).zip"
// which is the ONLY place the real name (and therefore the real extension)
// appears — the URL path itself carries neither. Ignoring it meant every
// cached ROM landed as "<gameId>.rom" (romExtFromUrl's fallback), and a .rom
// file is content RetroArch cannot identify: it will not auto-extract it (that
// is keyed on a .zip extension) and snes9x/mGBA/etc. reject it because it
// matches none of their declared extensions. RetroArch then falls back to its
// own menu — the "Load Content" screen instead of the game.
function filenameFromDisposition(res) {
  try {
    const cd = res.headers.get('content-disposition');
    if (!cd) return null;
    // filename*=UTF-8''... wins over the plain filename="..." when present.
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    if (star && star[1]) return decodeURIComponent(star[1].trim());
    const plain = /filename\s*=\s*"([^"]+)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
    if (plain && plain[1]) return plain[1].trim();
  } catch { /* fall through */ }
  return null;
}

// Last resort when the server sends no disposition: the container formats we
// actually receive are self-identifying in their first few bytes.
function extFromMagic(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7)) return '.zip';
  if (buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF) return '.7z';
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return '.rar';
  return null;
}

function romExtFromUrl(url) {
  try {
    const name = path.basename(new URL(url).pathname);
    const ext = path.extname(name);
    if (ext && ext.length <= 8) return ext;
  } catch { /* fall through */ }
  return '.rom';
}

function sanitizeName(s) {
  return String(s || '').replace(/[\/:*?"<>|\\]/g, '_').replace(/\s+/g, ' ').trim() || 'nexus_game';
}

// Keyed by whatever the caller passes as progressKey (gameId, for ROM
// downloads) so /cache-rom/progress can answer "how far along is this
// specific download" while the main /cache-rom request is still in flight —
// that request only responds once the WHOLE file is saved, so without this
// there was no way to tell a slow-but-working multi-GB download apart from
// one that had actually stalled: nothing on disk changed either way, since
// the old implementation buffered the entire response in memory before ever
// touching the filesystem.
const downloadProgress = new Map(); // progressKey -> { received, total, startedAt }

// No bytes for this long means the connection has gone silently dead — a
// half-open TCP socket over a tunnel or flaky Wi-Fi link, common on exactly
// the kind of setup this launcher runs on — not that the transfer is merely
// slow. Node's fetch() does not surface this on its own: reader.read() just
// never settles, so without this the old implementation hung until the
// unconditional 30-minute abort, with the UI frozen at whatever byte count
// it last polled (often a small early number like "16 KB" if the stall hit
// near the start) — the desktop "Console Vault" counterpart to the same
// class of bug already fixed in the browser (useBrowserRomCache) and native
// mobile (useMobileRomCache) download paths.
const DL_STALL_MS = 20_000;
const DL_MAX_RESUMES = 5;

async function downloadToFile(url, dest, progressKey) {
  ensureDirSync(path.dirname(dest));
  // Unique per call, not a fixed `${dest}.nexusdl`: two concurrent
  // downloads of the same game (see dedupeLaunch's comment for how that
  // happened routinely) both opened a write stream on the SAME temp path
  // and interleaved their bytes into it, then each renamed the resulting
  // mangled file into place — producing exactly the 0-byte and truncated
  // ROMs behind "download says 0KB" and emulators crashing on load.
  // dedupeLaunch now prevents that pairing at the source; keeping the temp
  // name unique means no other pair of callers (e.g. /cache-rom racing a
  // /launch for the same title) can reintroduce it.
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.nexusdl`;
  const writeStream = fs.createWriteStream(tmp);
  let total = 0;
  let received = 0;
  let resumes = 0;
  let usedStreamingPath = true;
  // Real name/extension as reported by the host, learned from the first
  // response. See filenameFromDisposition for why this matters.
  let serverName = null;
  let firstBytes = null;
  if (progressKey) downloadProgress.set(progressKey, { received: 0, total: 0, startedAt: Date.now() });

  const writeChunk = (value) => new Promise((resolve) => {
    const buf = Buffer.from(value);
    if (!firstBytes && buf.length) firstBytes = buf.subarray(0, 8);
    if (writeStream.write(buf)) resolve();
    else writeStream.once('drain', resolve);
  });

  // One pass over the network: (re)opens the connection at `received` and
  // reads until it finishes or falls silent. Returns true once the file is
  // whole. Thrown errors (not stalls) are handled by the caller's retry loop.
  const runAttempt = async () => {
    const headers = { 'User-Agent': 'NexusEmuLauncher/4-electron' };
    if (received > 0) headers.Range = `bytes=${received}-`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);

    if (!serverName) serverName = filenameFromDisposition(res);

    if (total === 0) {
      const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
      const contentRange = res.headers.get('content-range');
      // On a 206 the real total lives in "Content-Range: bytes X-Y/TOTAL".
      total = contentRange
        ? Number(contentRange.split('/')[1]) || contentLength + received
        : contentLength;
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      // Fallback for any fetch polyfill without a streamable body — same
      // behavior as before, just without live progress or resume.
      usedStreamingPath = false;
      const buf = Buffer.from(await res.arrayBuffer());
      received = buf.length;
      await writeChunk(buf);
      return true;
    }

    const reader = res.body.getReader();
    for (;;) {
      // A dead stream never settles read(), so awaiting it alone would hang
      // forever — exactly the "frozen at a few KB" symptom. Race it against
      // a silence timer instead.
      let timer;
      const stalled = new Promise((resolve) => { timer = setTimeout(() => resolve('stall'), DL_STALL_MS); });
      const next = await Promise.race([reader.read(), stalled]);
      clearTimeout(timer);

      if (next === 'stall') {
        try { await reader.cancel(); } catch { /* already dead */ }
        return false;
      }
      const { done, value } = next;
      if (done) break;
      if (!value || !value.length) continue;
      received += value.length;
      if (progressKey) downloadProgress.set(progressKey, { received, total, startedAt: downloadProgress.get(progressKey)?.startedAt ?? Date.now() });
      await writeChunk(value);
    }
    return total === 0 || received >= total;
  };

  try {
    // Resume from the exact byte reached rather than starting over — the
    // server advertises Accept-Ranges and honours partial requests, so a
    // stalled multi-GB ISO costs a reconnect, not the whole transfer again.
    let complete = await runAttempt();
    while (!complete && usedStreamingPath && resumes < DL_MAX_RESUMES) {
      resumes++;
      try {
        complete = await runAttempt();
      } catch (e) {
        if (resumes >= DL_MAX_RESUMES) throw e;
      }
    }
    await new Promise((resolve, reject) => writeStream.end((err) => (err ? reject(err) : resolve())));
  } catch (e) {
    // Any failure — HTTP 401/404, a dead tunnel, the write stream erroring —
    // must not leave its partial ".nexusdl" behind. They accumulate in the ROM
    // folder, are picked up by nothing, and a 0-byte one sitting next to a real
    // ROM is exactly the kind of debris that makes "why is this folder full of
    // junk" reports. The rename on success consumes the temp file, so reaching
    // here always means there is one to clear.
    try { writeStream.destroy(); } catch { /* already closed */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  } finally {
    if (progressKey) downloadProgress.delete(progressKey);
  }

  // A 0-byte or short-of-Content-Length response (auth hiccup mid-stream,
  // tunnel blip) used to still get renamed into place and reported as a
  // successful cache — findCachedRom/findRomAnywhere then treat that broken
  // file as permanently "already downloaded" and never retry it. Fail loudly
  // instead so the caller's existing retry/error UI actually gets used.
  if (received === 0 || (total > 0 && received < total)) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw new Error(`Download incomplete (${received} of ${total || '?'} bytes)`);
  }
  // Name the file what it ACTUALLY is. `dest` was built before the request
  // from romExtFromUrl(), which can only ever see "/api/games/<id>/download"
  // — no extension — and so fell back to ".rom" for every single ROM. Now that
  // the response has been seen, prefer the host's own filename, then the
  // container's magic bytes. Without this, RetroArch receives a .rom that is
  // really a .zip, refuses to identify it, and shows its "Load Content" menu.
  let finalDest = dest;
  const trueExt = (() => {
    if (serverName) {
      const e = path.extname(serverName);
      if (e && e.length <= 8) return e;
    }
    return extFromMagic(firstBytes);
  })();
  if (trueExt && trueExt.toLowerCase() !== path.extname(dest).toLowerCase()) {
    const corrected = path.join(path.dirname(dest), path.basename(dest, path.extname(dest)) + trueExt);
    finalDest = corrected;
  }
  await fsp.rename(tmp, finalDest);
  // A previous build of this launcher may have left the same ROM cached under
  // the wrong ".rom" name; drop it so findRomAnywhere can't serve the broken
  // one back to RetroArch forever.
  if (finalDest !== dest) { try { fs.rmSync(dest, { force: true }); } catch {} }
  return finalDest;
}

function platformRomDir(cfg, platform) {
  let dir = resolveRomDirectory(cfg);
  if (platform) {
    dir = path.join(dir, String(platform).toLowerCase());
    ensureDirSync(dir);
  }
  return dir;
}

// Turns the host's relative_path (e.g. "SNES/Action/Super Mario World.sfc")
// into a safe subpath under this client's ROM root, mirroring the host's
// actual folder structure instead of flattening everything into
// <romDir>/<platform>/<gameId>.<ext> — keeps paths consistent between host
// and client for the same library. Returns null for anything that could
// escape the ROM root (drive letters, UNC paths, leading slash, ".."
// segments), so a malformed/missing value just falls back to the old flat
// layout instead of writing outside the ROM folder.
function safeRelativeSubpath(relPath) {
  const raw = String(relPath || '').trim();
  if (!raw) return null;
  const norm = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(norm) || norm.startsWith('/')) return null;
  const parts = norm.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return path.join(...parts);
}

function findCachedRom(dir, gameId, safeName) {
  try {
    const files = fs.readdirSync(dir);
    for (const base of [gameId, safeName]) {
      if (!base) continue;
      const hit = files.find(f => path.parse(f).name === base);
      if (!hit) continue;
      const full = path.join(dir, hit);
      // A previous 0-byte/truncated download landing here used to be treated
      // as a permanently valid cache hit forever (see downloadToFile) — skip
      // it instead of returning it, so a bad file can actually self-heal by
      // being redownloaded rather than getting stuck.
      try {
        if (fs.statSync(full).size === 0) continue;
      } catch { continue; }
      return full;
    }
  } catch { /* dir missing */ }
  return null;
}

// Lowercased, extension-stripped, alphanumeric-only form of a name — lets
// "Super Smash Bros. Melee (USA).iso" match a game titled "Super Smash Bros
// Melee" without needing exact filename agreement. A ROM collection built up
// independently over the years essentially never agrees on punctuation,
// region tags, or bracketed release-group notes with what the host calls it.
function normalizeForMatch(name) {
  return path.parse(String(name || '')).name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const SCAN_MAX_DEPTH = 6;
// A "scan my whole drive" request has no natural size bound — this caps how
// many files get stat'd/compared before giving up on a branch, so pointing
// extraRomDirs at a drive root can't hang the launcher indefinitely.
const SCAN_MAX_FILES = 200_000;
const SCAN_SKIP_DIR_NAMES = new Set(['system volume information', '$recycle.bin', 'node_modules', '.git']);

function walkAndCollect(dir, depth, budget, out) {
  if (depth > SCAN_MAX_DEPTH || budget.count > SCAN_MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing/unreadable (e.g. a drive that isn't plugged in right now) — not an error, just nothing found here
  }
  for (const entry of entries) {
    if (budget.count > SCAN_MAX_FILES) return;
    if (!entry.isFile()) continue;
    budget.count++;
    if (!ROM_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      if (fs.statSync(path.join(dir, entry.name)).size === 0) continue;
    } catch { continue; }
    out.push({
      path: path.join(dir, entry.name),
      nameNoExt: path.parse(entry.name).name,
      normalized: normalizeForMatch(entry.name),
    });
  }
  for (const entry of entries) {
    if (budget.count > SCAN_MAX_FILES) return;
    if (!entry.isDirectory()) continue;
    if (SCAN_SKIP_DIR_NAMES.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
    walkAndCollect(path.join(dir, entry.name), depth + 1, budget, out);
  }
}

// findRomAnywhere used to re-walk every configured root from scratch on
// every single launch/cache-rom call — fine for a small romDirectory, but
// pointing extraRomDirs at an actual drive with a large existing collection
// meant every "new" download first paid for a full recursive re-scan of
// everything else just to conclude "not found here either." Cache each
// root's file listing for a few minutes so repeat lookups in the same
// session (browsing a library, clicking through several games) hit an
// in-memory array instead of the filesystem again.
const ROM_INDEX_CACHE = new Map(); // root -> { entries, builtAt }
const ROM_INDEX_TTL_MS = 5 * 60_000;

function getRomIndex(root, forceRefresh) {
  const cached = ROM_INDEX_CACHE.get(root);
  if (!forceRefresh && cached && Date.now() - cached.builtAt < ROM_INDEX_TTL_MS) {
    return cached.entries;
  }
  const entries = [];
  if (fs.existsSync(root)) walkAndCollect(root, 0, { count: 0 }, entries);
  ROM_INDEX_CACHE.set(root, { entries, builtAt: Date.now() });
  return entries;
}

// Config changes (a folder added/removed, or a drive that's now
// plugged in/out) must not keep serving a stale index until the TTL happens
// to expire on its own.
function invalidateRomIndexes() {
  ROM_INDEX_CACHE.clear();
}

function findInIndex(entries, gameId, normalizedTitle) {
  if (gameId) {
    const hit = entries.find((e) => e.nameNoExt === gameId);
    if (hit) return hit.path;
  }
  if (normalizedTitle) {
    const exact = entries.find((e) => e.normalized === normalizedTitle);
    if (exact) return exact.path;
    // Real ROM filenames almost always carry region/revision tags a bare
    // game title doesn't ("Super Smash Bros. Melee (USA).iso" vs "Super
    // Smash Bros Melee"), so requiring exact equality basically never
    // matched anything real. A length floor on the containment check avoids
    // a short/generic title (e.g. "Mario") spuriously matching unrelated
    // files that merely contain it as a substring.
    if (normalizedTitle.length >= 6) {
      const partial = entries.find((e) => e.normalized.includes(normalizedTitle));
      if (partial) return partial.path;
    }
  }
  return null;
}

// Widens findCachedRom's single-flat-directory exact-match lookup into a
// search across every configured ROM location (the primary romDirectory's
// full tree, plus any extraRomDirs — e.g. a GameCube collection that already
// lives on a completely different drive) with fuzzy title matching. This is
// what lets an existing local ROM get found and launched directly instead of
// Nexus downloading a duplicate copy from the host every time.
function findRomAnywhere(cfg, gameId, title, platform) {
  const safeName = sanitizeName(title);
  // Fast path: exact match in the conventional <romDir>/<platform> folder —
  // covers everything Nexus itself has ever downloaded, no directory walk needed.
  const flat = findCachedRom(platformRomDir(cfg, platform), gameId, safeName);
  if (flat) return flat;

  const normalizedTitle = normalizeForMatch(title);
  const searchRoots = [resolveRomDirectory(cfg), ...(Array.isArray(cfg.extraRomDirs) ? cfg.extraRomDirs : [])];
  for (const root of searchRoots) {
    if (!root || !String(root).trim()) continue;
    const found = findInIndex(getRomIndex(root), gameId, normalizedTitle);
    if (found) return found;
  }
  return null;
}

// Mirrors server.ts's spawnAndVerify (the host-launch path) — this client-side
// launch used to just fire-and-forget spawn() and report success immediately,
// so an emulator that crashed on start (PCSX2 aborting with SIGABRT when no
// PS2 BIOS is configured being the most common case) looked identical to a
// successful launch: the UI said "Launching…" and nothing further ever told
// the user why nothing appeared, only Windows' own crash dialog (if any).
//
// cwd is set explicitly to the emulator's own directory — several standalone
// emulators (and some libretro cores) resolve their own config/BIOS/assets
// paths relative to the process's current working directory rather than the
// executable's location, so launching with an inherited cwd that happens to
// be this launcher's own folder made them silently fail to find their BIOS
// or config and boot to a black screen instead of erroring.
//
// Unlike the original bounded alive-check, logging is NOT torn down once
// waitMs elapses — a genuinely-alive process can still black-screen a couple
// seconds later during GPU/video driver init, which used to be invisible
// (stderr was destroyed and the child was unref()'d right at the waitMs
// mark). The child is still unref()'d so it doesn't keep this launcher
// process alive, but its stdout/stderr keep streaming to this process's own
// console for as long as both processes are running, so a delayed crash is
// still diagnosable instead of silent.
function spawnAndVerify(exe, args, waitMs = 1200) {
  return new Promise((resolve) => {
    const chunks = [];
    const tag = path.basename(exe);
    const child = spawn(exe, args, { detached: true, cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => { console.log(`[${tag}] ${d.toString('utf8').trimEnd()}`); });
    child.stderr?.on('data', (d) => {
      const text = d.toString('utf8');
      console.error(`[${tag}] ${text.trimEnd()}`);
      if (chunks.length < 20) chunks.push(Buffer.from(text));
    });

    const onEarlyExit = (code, signal) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(chunks).toString('utf8').trim().slice(0, 600);
      resolve({ pid: child.pid || 0, alive: false, stderr: stderr || `Exited with code ${code ?? signal}` });
    };
    child.once('exit', onEarlyExit);
    child.once('error', (err) => {
      clearTimeout(timer);
      child.removeListener('exit', onEarlyExit);
      resolve({ pid: 0, alive: false, stderr: String(err && err.message ? err.message : err) });
    });

    const timer = setTimeout(() => {
      child.removeListener('exit', onEarlyExit);
      child.unref();
      resolve({ pid: child.pid || 0, alive: true, stderr: '' });
    }, waitMs);
  });
}

// Recognized disc-image/ROM extensions to look for once an archive has been
// extracted — same shape as ROM_EXTENSIONS but without the archive formats
// themselves, since the point is finding what's *inside* one.
const DISC_IMAGE_EXTENSIONS = new Set([
  '.iso', '.bin', '.cue', '.chd', '.gcm', '.rvz', '.wbfs', '.cso', '.gcz', '.ciso', '.wux', '.wua',
]);

function findDiscImage(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && DISC_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findDiscImage(path.join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}

// Standalone emulators (PCSX2, Dolphin, RPCS3, PPSSPP — anything in
// STANDALONE_ONLY_PLATFORMS) generally expect a raw disc image and either
// refuse to open a .zip/.7z or open their own library window with nothing
// loaded instead of the requested game — from the outside both look exactly
// like "black screen, nothing happened". RetroArch cores are deliberately
// left alone here: libretro's own zip loading handles the common libretro
// platforms fine, so extracting for those would just be unnecessary I/O.
// Extraction is cached next to the archive (keyed by filename) so replaying
// the same game doesn't re-extract every launch.
// What each libretro core will actually accept, read off the cores themselves
// (their embedded valid_extensions string). RetroArch identifies content by
// EXTENSION alone: a file whose extension is in neither this list nor its
// archive formats is content it cannot classify, so it loads the core, fails
// to attach any game, and leaves the user sitting in RetroArch's own menu on
// the "Load Content" entry. That is the whole mechanism behind "it opens
// RetroArch settings instead of the game".
const CORE_VALID_EXT = {
  snes9x:            ['.smc', '.sfc', '.swc', '.fig', '.bs', '.st'],
  fceumm:            ['.nes', '.fds', '.unf', '.unif'],
  mgba:              ['.gba', '.gb', '.gbc', '.sgb'],
  mupen64plus_next:  ['.n64', '.v64', '.z64', '.bin', '.u1'],
  genesis_plus_gx:   ['.mdx', '.md', '.smd', '.gen', '.bin', '.sms', '.gg', '.sg', '.cue', '.iso', '.chd'],
  picodrive:         ['.32x', '.smd', '.bin', '.md', '.iso', '.cue', '.chd'],
  mednafen_pce:      ['.pce', '.sgx', '.cue', '.ccd', '.chd'],
  mednafen_wswan:    ['.ws', '.wsc', '.pc2'],
  mednafen_lynx:     ['.lnx', '.o'],
  stella:            ['.a26', '.bin'],
  prosystem:         ['.a78', '.bin'],
  melondsds:         ['.nds'],
  pcsx_rearmed:      ['.bin', '.cue', '.img', '.mdf', '.pbp', '.toc', '.cbn', '.m3u', '.chd', '.iso'],
  yabause:           ['.cue', '.iso', '.ccd', '.chd', '.mds'],
  fbneo:             ['.zip', '.7z'],
  mame:              ['.zip', '.7z', '.chd'],
  flycast:           ['.chd', '.gdi', '.cdi', '.cue', '.iso', '.m3u'],
  citra:             ['.3ds', '.3dsx', '.cci', '.cxi', '.app'],
  dolphin:           ['.gcm', '.iso', '.wbfs', '.ciso', '.gcz', '.rvz', '.wad', '.m3u'],
};

// RetroArch unpacks these itself, so handing it the archive is fine and is
// what we prefer (it keeps one file on disk instead of two).
const ARCHIVE_EXT = new Set(['.zip', '.7z']);

function sniffArchiveExt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    return extFromMagic(buf);
  } catch { return null; }
}

// Repairs ROMs cached by an older build of this launcher, which named every
// single download "<gameId>.rom" because the download URL carries no
// extension (see filenameFromDisposition). Those files are byte-perfect —
// only the name is wrong — so this renames rather than re-downloading, then
// returns the usable path. Never throws: a launch must not be blocked by a
// failed tidy-up.
function ensureLoadableRom(romFile, platform) {
  try {
    const ext = path.extname(romFile).toLowerCase();
    if (ARCHIVE_EXT.has(ext)) return romFile;
    const coreId = PLATFORM_CORES[String(platform || '').toLowerCase()];
    const valid = coreId ? CORE_VALID_EXT[coreId] : null;
    if (valid && valid.includes(ext)) return romFile;

    // Wrong or unknown extension. The bytes tell the truth.
    const realExt = sniffArchiveExt(romFile)
      || (valid && valid.length ? valid[0] : null);
    if (!realExt || realExt.toLowerCase() === ext) return romFile;

    const fixed = path.join(path.dirname(romFile), path.basename(romFile, path.extname(romFile)) + realExt);
    if (fs.existsSync(fixed)) return fixed;
    fs.renameSync(romFile, fixed);
    invalidateRomIndexes();
    console.log(`[client-launcher] renamed ${path.basename(romFile)} -> ${path.basename(fixed)} so the core can load it`);
    return fixed;
  } catch {
    return romFile;
  }
}

async function extractRomIfArchived(romFile, platform) {
  const ext = path.extname(romFile).toLowerCase();
  if (ext !== '.zip' && ext !== '.7z') return romFile;
  if (!STANDALONE_ONLY_PLATFORMS.has(String(platform || '').toLowerCase())) return romFile;

  const destDir = path.join(path.dirname(romFile), `.extracted__${path.parse(romFile).name}`);
  const cached = fs.existsSync(destDir) ? findDiscImage(destDir) : null;
  if (cached) return cached;

  ensureDirSync(destDir);
  if (ext === '.zip') {
    const AdmZip = require('adm-zip');
    new AdmZip(romFile).extractAllTo(destDir, true);
  } else {
    const { path7za } = require('7zip-bin');
    const { code, stderr } = await runProcess(path7za, ['x', romFile, `-o${destDir}`, '-y'], 180_000);
    if (code !== 0) throw new Error(`Failed to extract ${path.basename(romFile)} (exit ${code}${stderr ? ` — ${stderr}` : ''})`);
  }
  const discImage = findDiscImage(destDir);
  if (!discImage) throw new Error(`${path.basename(romFile)} was extracted but no disc image (.iso/.bin/.cue/etc.) was found inside it`);
  return discImage;
}

// RetroArch black-screens on some GPUs when its config still has a stale or
// unset video_driver from a fresh/first install — "gl" is the most broadly
// compatible choice across Windows GPU drivers. This only ever fills in a
// MISSING value; an existing, user-chosen video_driver (including one they
// deliberately picked for performance) is left untouched; this is a
// first-run default, not a forced override on every launch.
function ensureSaneVideoDriver(retroarchPath) {
  const cfgPath = path.join(path.dirname(retroarchPath), 'retroarch.cfg');
  let text = '';
  try { text = fs.readFileSync(cfgPath, 'utf8'); } catch { /* no config yet — RetroArch will create one on first run without our help */ return; }
  if (/^\s*video_driver\s*=/m.test(text)) return;
  const withDefault = `${text.replace(/\s*$/, '')}\nvideo_driver = "gl"\n`;
  try { fs.writeFileSync(cfgPath, withDefault, 'utf8'); } catch { /* best effort — launch proceeds with RetroArch's own default either way */ }
}

// hostUrl comes from whatever this client last successfully talked to (see
// /config's preferredHostUrl write) — always available without the frontend
// needing to resend it on every launch. token has no server-side fallback:
// it's the caller's own session, so it only exists if the frontend actually
// sent one (older frontend builds won't have started doing this yet, which
// degrades gracefully to "clone skipped" rather than failing the launch).
function getHostUrlAndToken(body) {
  let hostUrl = '';
  try { hostUrl = fs.readFileSync(hostUrlFile, 'utf8').trim(); } catch { /* none recorded yet */ }
  return { hostUrl, token: String(body?.token || '') };
}

// ── Local (client-side) PC game discovery ────────────────────────────────
// Steam records every library folder in steamapps/libraryfolders.vdf, and
// one appmanifest_<appid>.acf per installed game inside each folder's
// steamapps/. Parsed with a targeted key/value regex rather than a full VDF
// parser: these two files only need a handful of flat string fields, and a
// dependency-free reader keeps this launcher self-contained.
function steamInstallRoots() {
  const roots = [];
  const candidates = IS_WIN
    ? [
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
      ]
    : [
        path.join(os.homedir(), '.steam', 'steam'),
        path.join(os.homedir(), '.local', 'share', 'Steam'),
      ];
  for (const base of candidates) {
    if (fs.existsSync(path.join(base, 'steamapps'))) roots.push(base);
  }
  return roots;
}

function steamLibraryFolders() {
  const libs = new Set();
  for (const root of steamInstallRoots()) {
    libs.add(root);
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    let text = '';
    try { text = fs.readFileSync(vdf, 'utf8'); } catch { continue; }
    // "path"  "D:\\SteamLibrary"  — the escaped backslashes are VDF's, so
    // they collapse back to single separators here.
    for (const m of text.matchAll(/"path"\s*"([^"]+)"/g)) {
      const p = m[1].replace(/\\\\/g, '\\');
      if (fs.existsSync(path.join(p, 'steamapps'))) libs.add(p);
    }
  }
  return [...libs];
}

function scanLocalSteamGames() {
  const games = [];
  const seen = new Set();
  for (const lib of steamLibraryFolders()) {
    const appsDir = path.join(lib, 'steamapps');
    let entries = [];
    try { entries = fs.readdirSync(appsDir); } catch { continue; }
    for (const file of entries) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(appsDir, file), 'utf8'); } catch { continue; }
      const field = (k) => (text.match(new RegExp(`"${k}"\\s*"([^"]*)"`)) || [])[1];
      const appId = field('appid');
      const name = field('name');
      if (!appId || !name || seen.has(appId)) continue;
      seen.add(appId);
      const installDirName = field('installdir');
      const stateFlags = Number(field('StateFlags') || 0);
      games.push({
        id: `steam:${appId}`,
        title: name,
        source: 'steam',
        appId,
        steamAppId: Number(appId),
        // StateFlags bit 2 = fully installed; anything else is mid-download
        // or needs an update, which the UI shows differently.
        installed: (stateFlags & 4) === 4,
        installDir: installDirName ? path.join(appsDir, 'common', installDirName) : undefined,
        sizeOnDisk: Number(field('SizeOnDisk') || 0) || undefined,
        storeUrl: `steam://rungameid/${appId}`,
        iconUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
        artUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
        heroUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_hero.jpg`,
        local: true, // distinguishes these from the host's library
      });
    }
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  return games;
}

// Epic Games — one JSON manifest per installed title under a fixed
// ProgramData folder. Straightforward to read, and without it an Epic-only
// library (GTA V here) simply never appeared in the app.
function scanLocalEpicGames() {
  const games = [];
  const manifestDir = IS_WIN
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
    : null;
  if (!manifestDir || !fs.existsSync(manifestDir)) return games;
  for (const file of fs.readdirSync(manifestDir)) {
    if (!file.toLowerCase().endsWith('.item')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));
      if (!m.AppName || !m.DisplayName) continue;
      games.push({
        id: `epic:${m.AppName}`,
        title: m.DisplayName,
        source: 'epic',
        appId: m.AppName,
        installed: m.bIsIncompleteInstall !== true,
        installDir: m.InstallLocation || undefined,
        executablePath: m.InstallLocation && m.LaunchExecutable ? path.join(m.InstallLocation, m.LaunchExecutable) : undefined,
        sizeOnDisk: Number(m.InstallSize || 0) || undefined,
        // Epic's own launch protocol — same shape PC Games already uses.
        storeUrl: `com.epicgames.launcher://apps/${m.CatalogNamespace}%3A${m.CatalogItemId}%3A${m.AppName}?action=launch&silent=true`,
        local: true,
      });
    } catch { /* a malformed manifest shouldn't lose the whole scan */ }
  }
  return games;
}

// Xbox / Microsoft Store games. Each drive that holds them has a small
// binary ".GamingRoot" marker at its root naming the install folder: an
// 8-byte header ("RGBX" + a 4-byte version) followed by the path as
// UTF-16LE. Each game then lives in its own subfolder there.
// There is no manifest to read, so these are reported by folder name with
// no launch URI — enough to show what's on the PC, which is what was
// missing entirely before.
const XBOX_NON_GAME_FOLDERS = new Set(['gamesave', 'gamesaves', 'temp', 'windowsapps', '$recycle.bin', 'system volume information']);

function scanLocalXboxGames() {
  const games = [];
  if (!IS_WIN) return games;
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const marker = `${letter}:\\.GamingRoot`;
    let raw;
    try { raw = fs.readFileSync(marker); } catch { continue; }
    let folder;
    try {
      folder = raw.slice(8).toString('utf16le').replace(/\u0000+$/g, '').trim();
    } catch { continue; }
    if (!folder) continue;
    const root = path.isAbsolute(folder) ? folder : path.join(`${letter}:\\`, folder);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // The install root also holds bookkeeping folders alongside the games
      // ("GameSave" is the Xbox app's own save store), which would otherwise
      // be listed as if they were playable titles.
      if (XBOX_NON_GAME_FOLDERS.has(entry.name.toLowerCase())) continue;
      games.push({
        id: `xbox:${entry.name}`,
        title: entry.name,
        source: 'xbox',
        installed: true,
        installDir: path.join(root, entry.name),
        local: true,
      });
    }
  }
  return games;
}

// Everything installed on THIS machine, across every launcher we can read.
// Each scanner is isolated so one failing source (a launcher that isn't
// installed, an unreadable folder) still returns the others rather than
// leaving the whole list empty.
function scanLocalPcGames() {
  const all = [];
  for (const scan of [scanLocalSteamGames, scanLocalEpicGames, scanLocalXboxGames]) {
    try { all.push(...scan()); } catch { /* skip this source */ }
  }
  const seen = new Set();
  const unique = all.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)));
  unique.sort((a, b) => a.title.localeCompare(b.title));
  return unique;
}

// Collapses duplicate concurrent launches of the SAME game into one.
//
// The web UI's postToLocalLauncher() fans a single Play click out to every
// candidate launcher address at once (127.0.0.1:17373, localhost:17373,
// 127.0.0.1:17374, localhost:17374) via .map() rather than trying them in
// order — so this process receives FOUR identical /launch requests within
// milliseconds, and used to honour all four. Confirmed live: one click
// produced four concurrent launches. The consequences were everything that
// looked like unrelated random breakage:
//   • four emulator instances of the same game spawned at once
//   • four concurrent downloads of the same ROM racing to write the same
//     temp file and rename it into the same destination — the actual cause
//     of "download says 0KB" and of truncated/corrupt ROMs that then made
//     RetroArch appear to "crash on random games"
//   • ~4x the bandwidth for one game, i.e. the "takes very long" slowness
//
// Keyed on the game itself (not the raw body) so requests that differ only
// in which address they arrived at collapse together, while a genuinely
// different game still launches normally. The entry is cleared once the
// launch settles, so a later re-launch of the same game is unaffected —
// this suppresses concurrent duplicates, never sequential retries.
//
// Fixing the frontend to try addresses sequentially is the other half of
// this and belongs in localLauncher.ts; doing it here too is deliberate —
// the launcher shouldn't spawn four copies just because it was asked four
// times in the same instant, regardless of which client is asking.
const inFlightLaunches = new Map();

function launchDedupeKey(body) {
  return [
    String(body?.gameId ?? ''),
    String(body?.platform ?? ''),
    String(body?.title ?? ''),
    // Netplay host vs client are genuinely different actions on the same
    // game, so they must not collapse into each other.
    String(body?.netplay?.role ?? ''),
  ].join(' ');
}

// A launch that has already STARTED an emulator stays claimed for this long
// after it finishes. The in-flight promise alone isn't enough: the duplicate
// requests from one click don't all arrive within the same instant — the
// frontend's per-base fallback can re-POST after the first launch already
// resolved (handleLaunch returns ~1.2s after spawn, while the click's other
// requests may still be retrying), so a purely in-flight guard lets the
// second one through and spawns a second emulator. Confirmed in practice:
// one click still produced two running instances with in-flight-only dedup.
const LAUNCH_CLAIM_MS = 15_000;
const recentLaunches = new Map(); // key -> { result, at }

// A DIFFERENT game starting within a moment of one that just started is not
// something a person does — emulators open fullscreen and you cannot play two
// at once. Observed for real: one click on 007 in Big Picture Mode launched
// both 007 and Shrek 2, because the UI fired launches for the focused card
// and a stale selection. The same-game guard above cannot catch that (the
// keys differ), so this blocks any second, different game in the same beat.
//
// Deliberately short — long enough to absorb one bad click (which resolves
// in milliseconds), far too short to interfere with genuinely deciding to
// play something else, which takes seconds of navigating at minimum.
const CROSS_GAME_LOCKOUT_MS = 4_000;
let lastStartedLaunch = null; // { key, title, at }

function dedupeLaunch(body, run) {
  const key = launchDedupeKey(body);

  const existing = inFlightLaunches.get(key);
  if (existing) return existing;

  const recent = recentLaunches.get(key);
  if (recent && Date.now() - recent.at < LAUNCH_CLAIM_MS) {
    // Same game, launched moments ago and still counts as "this click".
    // Returning the original success (rather than launching again, or
    // erroring) keeps the UI's success path intact while spawning nothing.
    return Promise.resolve(recent.result);
  }

  if (
    lastStartedLaunch &&
    lastStartedLaunch.key !== key &&
    Date.now() - lastStartedLaunch.at < CROSS_GAME_LOCKOUT_MS
  ) {
    const blocked = String(body?.title || 'game');
    console.warn(`[client-launcher] Suppressed near-simultaneous launch of "${blocked}" — "${lastStartedLaunch.title}" started ${Date.now() - lastStartedLaunch.at}ms ago. This is the UI firing two launches for one click.`);
    return Promise.resolve({
      status: 200,
      json: { success: true, launched: false, suppressed: true, reason: `Ignored a second launch (${blocked}) fired immediately after ${lastStartedLaunch.title}.` },
    });
  }

  // Armed BEFORE the work starts, not after it finishes. A launch takes over
  // a second (download check + spawn + liveness wait), while the duplicate
  // from the same click arrives in a few hundred milliseconds — arming on
  // completion left that entire window unguarded, and both games still
  // launched. Cleared again below if this launch turns out to fail, so a
  // failure never blocks the next game the user tries.
  const armedAt = Date.now();
  lastStartedLaunch = { key, title: String(body?.title || 'a game'), at: armedAt };

  const promise = (async () => run())()
    .then((result) => {
      // Only claim on an actual successful spawn — a failed launch must stay
      // freely retryable, which is exactly when a user clicks Play again.
      if (result?.json?.success) {
        recentLaunches.set(key, { result, at: Date.now() });
      }
      if (result?.json?.success && result.json.launched) {
        // Re-stamp to completion time so the lockout covers the moments
        // just after the emulator actually appears, not just the request.
        lastStartedLaunch = { key, title: String(body?.title || 'a game'), at: Date.now() };
      } else if (lastStartedLaunch && lastStartedLaunch.at === armedAt) {
        lastStartedLaunch = null; // this launch didn't start anything — unblock others
      }
      return result;
    })
    .catch((err) => {
      // A thrown launch must also release the cross-game lockout, otherwise
      // one crash would silently block every other game for its duration.
      if (lastStartedLaunch && lastStartedLaunch.at === armedAt) lastStartedLaunch = null;
      throw err;
    })
    .finally(() => {
      inFlightLaunches.delete(key);
      // Bound the map so a long session can't accumulate stale keys.
      if (recentLaunches.size > 64) {
        const cutoff = Date.now() - LAUNCH_CLAIM_MS;
        for (const [k, v] of recentLaunches) if (v.at < cutoff) recentLaunches.delete(k);
      }
    });

  inFlightLaunches.set(key, promise);
  return promise;
}

async function handleLaunch(body) {
  const { romUrl, platform, title, gameId, netplay, relativePath } = body;
  const cfg = loadConfig();
  const dir = platformRomDir(cfg, platform);

  // Check the emulator (and netplay compatibility) BEFORE touching the ROM —
  // this used to run after the ROM find/download step, so a multi-GB PS2/
  // GameCube ISO would download in full before the user found out there was
  // never an emulator to run it with. Nothing here depends on the ROM file
  // existing, so there's no reason to make someone wait through a download
  // just to hit a failure that was already knowable up front.
  let emu = getEmulatorPath(platform);
  const { hostUrl, token } = getHostUrlAndToken(body);
  if (!emu) {
    // "Auto setup" previously only ever covered RetroArch — a PS2/PS3/PSP/
    // Wii U game just failed outright here with no attempt to get the user
    // unblocked, even though the whole point of Play is that nothing needs
    // to be pre-installed.
    const plat = String(platform || '').toLowerCase();
    // RetroArch platforms are the bulk of a library (NES/SNES/N64/GBA/Genesis/
    // PS1/…), and they had NO self-install path here at all: the map below only
    // covered the four standalone emulators, so everything else fell straight
    // through to performCloneHostSetup — which needs both a host URL and a
    // token. A client launching a local ROM without those (or against a host
    // that has no clonable copy) dead-ended on "No emulator found" even though
    // ensureRetroArchInstalled() can fetch RetroArch itself from the official
    // buildbot with no host involved at all.
    // Standalone emulators are checked FIRST: ps2 and psp appear in
    // PLATFORM_CORES too (as 'pcsx2'/'ppsspp' core ids), so testing RetroArch
    // first would quietly divert them away from their dedicated installers.
    const autoInstaller =
      { ps2: ensurePCSX2Installed, ps3: ensureRPCS3Installed, psp: ensurePPSSPPInstalled, wiiu: ensureCemuInstalled }[plat]
      || (PLATFORM_CORES[plat] ? ensureRetroArchInstalled : null);
    if (autoInstaller) {
      const install = await autoInstaller();
      if (install.ok) emu = getEmulatorPath(platform);
    }
    // Covers everything the direct installers above don't (Dolphin/GameCube,
    // Switch — no verified public download source for either — plus a
    // second chance for ps2/ps3/psp/wiiu if the direct installer failed,
    // e.g. GitHub rate-limited) by cloning the host's own already-working
    // copy instead. Only attempted once we genuinely have both a host to
    // ask and a token to authenticate with; either missing just falls
    // through to the existing explicit failure below.
    if (!emu && hostUrl && token) {
      const clone = await performCloneHostSetup(hostUrl, token);
      if (clone.ok || clone.steps?.some((s) => s.ok)) emu = getEmulatorPath(platform);
    }
    if (!emu) {
      return { status: 404, json: { success: false, error: `No emulator found for '${platform}'. Place emulator in ${emuRoot}/<EmulatorName>/, or set its path in Client Setup.` } };
    }
  }
  // A RetroArch platform can have the emulator itself but not yet the
  // specific core it needs (fresh RetroArch install, or a core Play has
  // never touched before) — previously this just launched RetroArch with
  // no -L core argument at all, which opens RetroArch's own menu instead of
  // the game, indistinguishable from a hang to someone expecting Play to
  // just work.
  //
  // Fetched straight from RetroArch's own buildbot (ensureRetroArchCore),
  // NOT cloned from the host: a core is compiled native code, so a Linux
  // host's cores are .so files a Windows client can never load no matter
  // how faithfully they're copied — /clone-host-setup's cores step already
  // does exactly that unconditional copy (confirmed on this exact client:
  // it has 13 real *_libretro.so files sitting in its cores folder, cloned
  // from the Linux host, that getCorePath() can never match since it only
  // ever looks for *_libretro.dll on Windows — every one of them is dead
  // weight). The buildbot always has the right binary for whatever OS this
  // code is actually running on, which cloning fundamentally cannot.
  if (isRetroArch(emu) && !getCorePath(emu, platform)) {
    await ensureRetroArchCore(emu, platform);
  }
  // Separate from the core itself — a core can be present while its
  // supporting system files are not (exactly the state a fresh Dolphin core
  // download leaves behind), so this is checked on every RetroArch launch
  // rather than only when the core was just installed. No-ops instantly for
  // cores that need nothing, and once the files exist.
  if (isRetroArch(emu)) {
    const coreId = PLATFORM_CORES[String(platform || '').toLowerCase()];
    if (coreId && CORE_SYSTEM_FILES[coreId]) await ensureCoreSystemFiles(emu, coreId);
  }
  // Netplay requires the ROM to actually load and run here, on this device —
  // the server-side /api/games/launch route this used to go through instead
  // always spawns RetroArch on the host, regardless of which player's browser
  // tab made the request. A guest clicking "Connect to <host>:<port>" got the
  // *host* connecting to itself; nothing ever ran on the guest's own machine.
  if (netplay && !isRetroArch(emu)) {
    return { status: 400, json: { success: false, error: 'Netplay requires RetroArch — this platform is configured to use a standalone emulator instead.' } };
  }
  if (netplay?.role === 'client' && !netplay.hostAddress) {
    return { status: 400, json: { success: false, error: 'netplay.hostAddress required to join as a client' } };
  }

  // Prefer the mirrored host-structure path (see safeRelativeSubpath) when
  // we have one, then anything already sitting in romDirectory/extraRomDirs
  // (findRomAnywhere — this is what picks up a GameCube collection kept on a
  // completely separate drive) before ever falling back to downloading a
  // fresh copy from the host.
  const mirroredRel = safeRelativeSubpath(relativePath);
  const mirroredFile = mirroredRel ? path.join(resolveRomDirectory(cfg), mirroredRel) : null;
  let mirroredValid = false;
  if (mirroredFile && fs.existsSync(mirroredFile)) {
    try { mirroredValid = fs.statSync(mirroredFile).size > 0; } catch { /* treat as invalid */ }
  }
  let romFile = mirroredValid
    ? mirroredFile
    : findRomAnywhere(cfg, gameId, title, platform);

  // Heal ROMs saved under the generic ".rom" fallback extension.
  //
  // romExtFromUrl() derives the extension from the download URL, but the
  // host's URL is /api/games/<id>/download — no extension — so those files
  // landed as "<gameId>.rom". Emulators identify disc images by extension:
  // the Dolphin core rejects a perfectly valid 1.46 GB GameCube ISO named
  // .rom with "Could not recognize file", then "Could not boot", which
  // surfaces as a game that simply refuses to start. Confirmed on this
  // exact file.
  //
  // The host does tell us the real name via relative_path (e.g.
  // "./GAMECUBE/007 - From Russia with Love.iso"), so when a cached file
  // is the generic .rom and we know the intended path+extension, rename it
  // into place. A rename (not a re-download) because these are multi-GB
  // discs and the bytes are already correct — only the name was wrong.
  if (romFile && !mirroredValid && mirroredFile && path.extname(romFile).toLowerCase() === '.rom') {
    const properExt = path.extname(mirroredFile).toLowerCase();
    if (properExt && properExt !== '.rom') {
      try {
        ensureDirSync(path.dirname(mirroredFile));
        fs.renameSync(romFile, mirroredFile);
        invalidateRomIndexes();
        romFile = mirroredFile;
      } catch { /* keep the original path — a failed rename must not block the launch */ }
    }
  }

  const usedCache = !!romFile;
  if (!romFile) {
    if (!romUrl) return { status: 400, json: { success: false, error: 'romUrl required when no cached ROM exists' } };
    const base = gameId || sanitizeName(title);
    const dest = mirroredFile || path.join(dir, `${base}${romExtFromUrl(romUrl)}`);
    try {
      romFile = await downloadToFile(romUrl, dest);
      invalidateRomIndexes(); // a file just landed under resolveRomDirectory(cfg) — see /cache-rom's identical note
    } catch (e) {
      return { status: 500, json: { success: false, error: `ROM download failed: ${e && e.message ? e.message : e}` } };
    }
  }
  try {
    // Standalone emulators (PCSX2, Dolphin, RPCS3, PPSSPP) generally
    // black-screen or silently no-op when handed an archive instead of the
    // disc image inside it — see extractRomIfArchived's own comment. No-op
    // for RetroArch-core platforms, which load zips natively.
    // Legacy ".rom" repair BEFORE the archive check — a zip misnamed ".rom"
    // would otherwise skip extraction here and then be unloadable in RetroArch.
    romFile = ensureLoadableRom(romFile, platform);
    romFile = await extractRomIfArchived(romFile, platform);

    const args = [];
    if (isRetroArch(emu)) {
      ensureSaneVideoDriver(emu);
      const core = getCorePath(emu, platform);
      if (!core) {
        // Launching RetroArch with no -L core opens its own menu instead of
        // the game — from the outside indistinguishable from "Play did
        // nothing." The clone/auto-install attempts above already had their
        // shot at fixing this; a still-missing core here means both failed
        // (no host reachable, no token, or the host doesn't have this core
        // either) and the honest answer is to say so, not launch a blank menu.
        return { status: 404, json: { success: false, error: `No RetroArch core for '${platform}' — the host doesn't have it available to clone, or couldn't be reached. Check Client Setup or try Auto-Install from Host.` } };
      }
      args.push('-L', core);
      if (netplay?.role === 'host') {
        args.push('--host', '--port', String(netplay.port || 55435));
        if (netplay.nick) args.push('--nick', String(netplay.nick).replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 32));
      } else if (netplay?.role === 'client') {
        // hostAddress presence already validated up front, before the ROM was found/downloaded.
        args.push('--connect', netplay.hostAddress, '--port', String(netplay.port || 55435));
        if (netplay.nick) args.push('--nick', String(netplay.nick).replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 32));
      }
    } else if (String(platform || '').toLowerCase() === 'ps3') {
      // RPCS3 needs --no-gui to auto-boot straight into the game instead of
      // just opening its own library window with nothing loaded.
      args.push('--no-gui');
    } else if (String(platform || '').toLowerCase() === 'xbox') {
      // xemu will not boot a disc image passed as a bare positional argument —
      // it opens its own GUI with nothing loaded, which looks identical to the
      // PS2/PS3 "black window / Play did nothing" failures handled above. The
      // image has to come in via -dvd_path, matching what the host's own
      // STANDALONE_LAUNCHERS does for this platform.
      args.push('-dvd_path');
    } else if (String(platform || '').toLowerCase() === 'ps2') {
      // Standalone PCSX2-QT: without -batch, passing just the ROM path can load
      // the game behind PCSX2's own library/main window instead of actually
      // booting into it fullscreen — from the outside that looks exactly like
      // "the game window is just black," which is what this was reported as.
      args.push('-batch');
    }
    args.push(romFile);
    const { pid, alive, stderr } = await spawnAndVerify(emu, args);
    if (!alive) {
      const plat = String(platform || '').toLowerCase();
      const hint = plat === 'ps2'
        ? 'Ensure a PS2 BIOS (.bin) is configured — in standalone PCSX2, add it via Settings > BIOS; with the RetroArch core, place it in retroarch/system/pcsx2/bios/.'
        : plat === 'ps3'
        ? 'RPCS3 needs its firmware installed once (Settings > Install Firmware).'
        : 'Check the emulator opens correctly on its own outside NexusEmu first.';
      return { status: 500, json: { success: false, error: `${emu.split(/[\\/]/).pop()} crashed on start: ${stderr || 'unknown error'}`, hint } };
    }
    return { status: 200, json: { success: true, launched: true, pid, file: romFile, emulator: emu, usedCache } };
  } catch (e) {
    return { status: 500, json: { success: false, error: `Launch failed: ${e && e.message ? e.message : e}` } };
  }
}

// A game's executablePath is recorded on whichever machine scanned it (the
// host) — it's only ever launchable here, on the client, if this same path
// genuinely exists on this machine too (shared/synced install, or this
// client *is* the machine that was scanned). That's a real precondition, not
// a bug to work around: if the path isn't here, the honest answer is "this
// game isn't installed on this device," surfaced clearly instead of silently
// doing nothing (the previous behavior for any executablePath-only game,
// since getLocalLaunchUri() had no branch for it at all).
async function handleLaunchExe(body) {
  const executablePath = String((body && body.executablePath) || '').trim();
  if (!executablePath) return { status: 400, json: { success: false, error: 'executablePath required' } };
  if (!fs.existsSync(executablePath)) {
    return { status: 404, json: { success: false, error: `Not installed on this device: ${executablePath}` } };
  }
  try {
    const child = spawn(executablePath, [], {
      detached: true, stdio: 'ignore', windowsHide: false,
      cwd: path.dirname(executablePath),
    });
    child.unref();
    return { status: 200, json: { success: true, launched: true, executablePath } };
  } catch (e) {
    return { status: 500, json: { success: false, error: `Launch failed: ${e && e.message ? e.message : e}` } };
  }
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────
//
// SECURITY: this server binds to 127.0.0.1 only, but a wildcard
// 'Access-Control-Allow-Origin: *' (what the old PowerShell launcher used)
// means ANY website open in ANY browser tab — not just NexusEmu — can script
// a fetch() to /launch or /cache-rom and have this process download
// attacker-controlled content to disk and spawn the local emulator with it,
// with zero user interaction. Folding this into the Electron app makes it run
// automatically for every desktop user instead of only those who opted into
// installing the old separate service, which raises the real-world exposure
// enough that the wildcard needs to go. Since a client can legitimately point
// at localhost, a LAN IP, or the tunnel domain, we can't use a fixed allowlist —
// instead we only ever echo back an Origin that matches localhost or the
// previously-established trusted host (the same file/precedent already used
// by the /config preferredHostUrl check below), and omit the CORS header
// entirely for anything else so the browser blocks the response/preflight.
function isTrustedOrigin(origin) {
  if (!origin) return true; // non-browser callers (no Origin header) — nothing to restrict
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  let trusted = '';
  try { trusted = fs.readFileSync(hostUrlFile, 'utf8').trim(); } catch { /* none recorded yet */ }
  if (trusted) return origin.startsWith(trusted);
  // Trust-on-first-use: the client always calls GET /health BEFORE its first
  // POST /config (which is what records preferred-host-url.txt — see
  // useLauncherWatcher.ts), so nothing is trusted yet on a fresh install.
  // Bootstrapping open here (rather than rejecting every install's first-ever
  // call, which would break the feature entirely for any non-localhost host —
  // LAN IP or the tunnel domain) closes itself the moment that first /config
  // call succeeds and a trusted host gets recorded. The remaining exposure is a
  // narrow race on first launch, not a permanent hole.
  return true;
}

function corsHeaders(origin) {
  if (!isTrustedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function sendJson(res, obj, status = 200, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(origin),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); return; } catch { /* try form */ }
      try {
        const params = new URLSearchParams(data);
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        resolve(obj);
      } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function healthPayload() {
  const cfg = loadConfig();
  return {
    ok: true,
    port: PORT,
    version: 4,
    native: true,
    embedded: 'electron',
    canPickFolder: true,
    // True once the user has explicitly chosen a folder via /pick-folder.
    // False means we're still using the silent LOCALAPPDATA default — the
    // one-time folder-choice prompt in the UI uses this to decide whether to
    // offer "Choose your folder" at all.
    folderCustomized: !!cfg.emulationRoot,
    clientRoot,
    romDirectory: resolveRomDirectory(cfg),
    emulationRoot: cfg.emulationRoot || null,
    emulatorRoot: emuRoot,
    retroarchFound: !!getEmulatorPath('nes'),
    dolphinFound: !!getEmulatorPath('gamecube'),
    pcsx2Found: !!getEmulatorPath('ps2'),
    autostart: true,
    autostartMethod: 'electron-app',
    protocolHandler: false,
  };
}

/**
 * Start the embedded launcher HTTP server.
 * @param {{ getMainWindow?: () => import('electron').BrowserWindow | null }} opts
 * @returns {import('http').Server | null}
 */
function startEmbeddedLauncher(opts = {}) {
  ensureDirSync(clientRoot);
  ensureDirSync(defaultRomDir);
  ensureDirSync(path.join(emuRoot, 'RetroArch'));
  ensureDirSync(path.join(clientRoot, 'Logs'));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      const p = url.pathname.toLowerCase();
      const origin = req.headers.origin;
      // Bound per-request so every response below gets the same origin check
      // sendJson() enforces — see the security note above sendJson's definition.
      const send = (obj, status = 200) => sendJson(res, obj, status, origin);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
      }

      if (req.method === 'GET' && (p === '/health' || p === '/wake' || p === '/')) {
        send(healthPayload());
        return;
      }

      // THIS machine's installed PC games — not the host's.
      //
      // /api/pc-games/library on the host enumerates the HOST's Steam
      // library, which is why PC Games and the Multiplayer "PC" option show
      // the host's 3 installed games instead of this PC's. Hosting a
      // splitscreen session for a game that lives HERE needs the client's
      // own list, and only code running on the client can produce it.
      // Pre-install cores for every platform up front, instead of only when
      // a game from that platform is first launched. On-demand install works
      // (handleLaunch calls ensureRetroArchCore), but it makes the very first
      // launch of each system stall on a download — and if the network hiccups
      // at that moment the launch fails outright. Running this once after
      // setup means every system is genuinely ready to play.
      if (req.method === 'POST' && p === '/ensure-cores') {
        try {
          const body = await readBody(req);
          const emu = getEmulatorPath('nes'); // any RetroArch-backed platform resolves to RetroArch
          if (!emu || !isRetroArch(emu)) {
            send({ ok: false, error: 'RetroArch is not installed yet — run setup first.' }, 400);
            return;
          }
          const requested = Array.isArray(body.platforms) && body.platforms.length
            ? body.platforms.map((x) => String(x).toLowerCase())
            : Object.keys(PLATFORM_CORES);
          // De-dupe by core id so aliases (megadrive/genesis, gb/gbc/gba…)
          // don't download the same core several times.
          const seenCore = new Set();
          const results = [];
          for (const platform of requested) {
            const coreId = PLATFORM_CORES[platform];
            if (!coreId || seenCore.has(coreId)) continue;
            seenCore.add(coreId);
            if (getCorePath(emu, platform)) {
              results.push({ platform, coreId, ok: true, installed: false, detail: 'Already present' });
              continue;
            }
            const r = await ensureRetroArchCore(emu, platform);
            if (r.ok) await ensureCoreSystemFiles(emu, coreId);
            results.push({ platform, coreId, ok: !!r.ok, installed: !!r.installed, detail: r.detail });
          }
          send({ ok: results.every((r) => r.ok), installed: results.filter((r) => r.installed).length, results });
        } catch (e) {
          send({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
        }
        return;
      }

      if (req.method === 'GET' && p === '/pc-games/local') {
        try {
          send({ ok: true, games: scanLocalPcGames() });
        } catch (e) {
          send({ ok: false, error: String(e && e.message ? e.message : e), games: [] }, 500);
        }
        return;
      }

      if (req.method === 'GET' && p === '/preflight') {
        const platform = url.searchParams.get('platform') || 'nes';
        const cfg = loadConfig();
        const emu = getEmulatorPath(platform);
        const coreRequired = !!(emu && isRetroArch(emu));
        const corePath = coreRequired ? getCorePath(emu, platform) : null;
        send({
          ok: true, platform, launcherRunning: true,
          emulatorFound: !!emu, emulatorPath: emu,
          coreRequired, coreFound: !!corePath, corePath,
          romDirectory: resolveRomDirectory(cfg),
          autostart: true,
        });
        return;
      }

      // GET /manual-setup-info — the last-resort fallback when auto-setup
      // (ROM download / clone-host-setup) fails: tells the UI exactly which
      // folders to drop files into so the existing /launch, /preflight, and
      // /clone-host-setup lookups pick them up on the next attempt — this
      // process never downloads anything for this endpoint, it only reports
      // paths and whether something is already sitting there.
      if (req.method === 'GET' && p === '/manual-setup-info') {
        const cfg = loadConfig();
        const platform = url.searchParams.get('platform') || '';
        const relativePath = url.searchParams.get('relativePath') || '';
        const gameId = url.searchParams.get('gameId') || '';
        const title = url.searchParams.get('title') || '';
        const safeName = sanitizeName(title);
        const dir = platformRomDir(cfg, platform);
        const mirroredRel = safeRelativeSubpath(relativePath);
        const mirroredFile = mirroredRel ? path.join(resolveRomDirectory(cfg), mirroredRel) : null;
        let mirroredValid = false;
        if (mirroredFile && fs.existsSync(mirroredFile)) {
          try { mirroredValid = fs.statSync(mirroredFile).size > 0; } catch { /* treat as invalid */ }
        }
        const existing = mirroredValid ? mirroredFile : findCachedRom(dir, gameId, safeName);
        send({
          ok: true,
          romTargetPath: mirroredFile,
          romFallbackFolder: dir,
          romFallbackNameHint: `${gameId || safeName}.<file extension, e.g. .zip, .sfc, .iso>`,
          romFound: !!existing,
          romFoundAt: existing || null,
          coresDir: cfg.emulationRoot ? path.join(cfg.emulationRoot, 'cores') : null,
          biosDir: cfg.emulationRoot ? path.join(cfg.emulationRoot, 'bios') : null,
          emulatorRoot: emuRoot,
        });
        return;
      }

      if (req.method === 'GET' && p === '/setup') {
        const cfg = loadConfig();
        // Used to always report the fixed clientRoot/Emulators default here
        // and omit emulationRoot entirely — any UI reading /setup instead of
        // /health showed stale info after a folder pick. Now sourced from the
        // same place /health already gets it right from.
        send({
          success: true,
          clientRoot,
          romDirectory: resolveRomDirectory(cfg),
          extraRomDirs: Array.isArray(cfg.extraRomDirs) ? cfg.extraRomDirs : [],
          emulationRoot: cfg.emulationRoot || null,
          folderCustomized: !!cfg.emulationRoot,
          emulatorRoot: cfg.emulationRoot ? path.join(cfg.emulationRoot, 'emulators') : emuRoot,
          emulators: {
            retroarch: getEmulatorPath('nes'),
            dolphin: getEmulatorPath('gamecube'),
            pcsx2: getEmulatorPath('ps2'),
            ppsspp: getEmulatorPath('psp'),
            cemu: getEmulatorPath('wiiu'),
            rpcs3: getEmulatorPath('ps3'),
          },
          emulatorPaths: cfg.emulators || {},
          autostart: { ok: true, method: 'electron-app' },
          protocolHandler: { ok: false },
        });
        return;
      }

      if (req.method === 'POST' && p === '/cache-rom') {
        const body = await readBody(req);
        if (!body.romUrl) { send({ success: false, error: 'romUrl required' }, 400); return; }
        const cfg = loadConfig();
        const dir = platformRomDir(cfg, body.platform);
        const mirroredRel = safeRelativeSubpath(body.relativePath);
        const mirroredFile = mirroredRel ? path.join(resolveRomDirectory(cfg), mirroredRel) : null;
        // Check romDirectory/extraRomDirs for an existing copy before ever
        // downloading — without this, "Get & Play" always fetched a fresh
        // copy from the host even when the exact ROM already sat on a
        // completely different drive (e.g. an existing GameCube collection).
        // Same zero-byte guard as findCachedRom below — a direct existsSync
        // here bypassed that guard entirely, so a truncated mirrored file
        // could still get treated as a valid cache hit forever.
        const mirroredValid = mirroredFile && fs.existsSync(mirroredFile) && (() => {
          try { return fs.statSync(mirroredFile).size > 0; } catch { return false; }
        })();
        const existing = mirroredValid
          ? mirroredFile
          : findRomAnywhere(cfg, body.gameId, body.title, body.platform);
        if (existing) {
          send({ success: true, cached: true, alreadyExisted: true, file: existing, romDirectory: path.dirname(existing) });
          return;
        }
        const dest = mirroredFile || path.join(dir, `${body.gameId || sanitizeName(body.title)}${romExtFromUrl(body.romUrl)}`);
        try {
          const savedPath = await downloadToFile(body.romUrl, dest, body.gameId || dest);
          // A file just landed under resolveRomDirectory(cfg) — invalidate so
          // a subsequent findRomAnywhere() (a different game entirely, or
          // this same one reached through a path the live mirroredFile/
          // flat-folder checks don't cover) sees it immediately rather than
          // waiting out ROM_INDEX_TTL_MS on a now-stale cached listing.
          invalidateRomIndexes();
          send({ success: true, cached: true, alreadyExisted: false, file: savedPath, romDirectory: path.dirname(savedPath) });
        } catch (e) {
          send({ success: false, error: `Download failed: ${e && e.message ? e.message : e}` }, 500);
        }
        return;
      }

      // Polled by the frontend WHILE the /cache-rom POST above is still in
      // flight (that request only answers once the whole file is saved) —
      // this is the only way to show real progress instead of a static
      // message for the several minutes a large PS2/PSP ISO can take.
      if (req.method === 'GET' && p === '/cache-rom/progress') {
        const gameId = url.searchParams.get('gameId') || '';
        const progress = gameId ? downloadProgress.get(gameId) : null;
        send({ ok: true, active: !!progress, received: progress?.received ?? 0, total: progress?.total ?? 0 });
        return;
      }

      // Same shape as /cache-rom above, for MusicHub's Collection tab "Download"
      // button — persists a track that's already in the host's own library to
      // this device for offline playback. Always fixed at <clientRoot>/Music/,
      // no separate config knob (unlike ROMs, there's no equivalent need for
      // extra search directories here — this only ever writes what the host
      // already indexed, never fetches anything from outside the host).
      if (req.method === 'POST' && p === '/cache-music') {
        const body = await readBody(req);
        if (!body.streamUrl) { send({ success: false, error: 'streamUrl required' }, 400); return; }
        const musicDir = path.join(clientRoot, 'Music');
        ensureDirSync(musicDir);
        const safeName = sanitizeName(body.title || 'track');
        // Prefer the real extension the caller already knows (from the
        // track's actual file path) over guessing from streamUrl — that URL
        // is always /api/music/stream?rel=<encoded path>, so its extension-
        // bearing part sits inside the query string, not the pathname
        // romExtFromUrl actually looks at. Guessing there always fell through
        // to romExtFromUrl's ROM-specific ".rom" fallback, saving every
        // cached track under a music player won't recognize by extension.
        const ext = /^\.[a-zA-Z0-9]{1,8}$/.test(body.ext || '') ? body.ext : (romExtFromUrl(body.streamUrl) || '.mp3');
        const dest = path.join(musicDir, `${body.trackId || safeName}${ext}`);
        let destValid = false;
        try { destValid = fs.statSync(dest).size > 0; } catch { /* not present */ }
        if (destValid) {
          send({ success: true, cached: true, alreadyExisted: true, file: dest });
          return;
        }
        try {
          await downloadToFile(body.streamUrl, dest);
          send({ success: true, cached: true, alreadyExisted: false, file: dest });
        } catch (e) {
          send({ success: false, error: `Download failed: ${e && e.message ? e.message : e}` }, 500);
        }
        return;
      }

      if (req.method === 'POST' && p === '/ensure-local') {
        const body = await readBody(req);
        const platform = String(body.platform || 'nes').toLowerCase();
        const steps = [];
        let emu = getEmulatorPath(platform);
        if (!emu && STANDALONE_ONLY_PLATFORMS.has(platform)) {
          // Auto-install only knows how to fetch RetroArch — for a platform
          // that specifically needs Dolphin/PCSX2/etc, "installing RetroArch"
          // was a no-op dressed up as progress: the step reported ok:true
          // ("RetroArch installed") right next to a launch that still
          // couldn't work, since RetroArch was never going to run this
          // platform anyway. Report the real, actionable gap instead.
          steps.push({
            name: 'Emulator',
            ok: false,
            detail: `No auto-install available for ${platform.toUpperCase()} — install it yourself, then either place it in ${emuRoot}/<EmulatorName>/ or set its path via Client Setup so this device can find it.`,
          });
        } else if (!emu) {
          const r = await ensureRetroArchInstalled();
          steps.push({ name: 'RetroArch', ok: !!r.ok, detail: String(r.detail || '') });
          if (r.ok) emu = r.path;
        } else {
          steps.push({ name: 'RetroArch', ok: true, detail: `Found: ${emu}` });
        }
        let coreOk = true;
        let corePath = null;
        if (emu && isRetroArch(emu)) {
          const r = await ensureRetroArchCore(emu, platform);
          coreOk = !!r.ok;
          corePath = r.path || null;
          steps.push({ name: 'Core', ok: !!r.ok, detail: String(r.detail || '') });
        } else {
          steps.push({ name: 'Core', ok: true, detail: 'Not required for this emulator' });
        }
        send({ ok: !!(emu && coreOk), platform, emulatorPath: emu || null, corePath, steps });
        return;
      }

      if (req.method === 'POST' && p === '/install-emulator') {
        const body = await readBody(req);
        const target = String(body.emulator || 'retroarch').toLowerCase();
        if (target === 'retroarch') {
          send(await ensureRetroArchInstalled());
        } else {
          send({ ok: false, detail: `Unknown emulator '${target}'. Supported: retroarch` });
        }
        return;
      }

      if (req.method === 'POST' && p === '/config') {
        const body = await readBody(req);
        const cfg = loadConfig();
        if (body.romDirectory) cfg.romDirectory = String(body.romDirectory);
        if (body.emulationRoot) cfg.emulationRoot = String(body.emulationRoot);
        // Full replace, not merge — the UI owns the complete list (add/remove
        // happen client-side) and sends it back whole each time, same as any
        // other array-of-strings settings field.
        if (Array.isArray(body.extraRomDirs)) {
          cfg.extraRomDirs = body.extraRomDirs.map((d) => String(d || '').trim()).filter(Boolean);
        }
        // A folder just got added/removed/changed (or a drive got plugged in
        // since the cache was built) — the next lookup must see it right
        // away, not wait out the rest of ROM_INDEX_TTL_MS serving whatever
        // was cached under the old configuration.
        if (body.romDirectory || Array.isArray(body.extraRomDirs)) {
          invalidateRomIndexes();
        }
        if (body.emulators && typeof body.emulators === 'object') {
          cfg.emulators = cfg.emulators || {};
          for (const k of ['retroarch', 'dolphin', 'pcsx2', 'ppsspp', 'cemu', 'rpcs3']) {
            if (body.emulators[k]) cfg.emulators[k] = String(body.emulators[k]);
          }
        }
        if (body.preferredHostUrl) {
          // Same origin policy as the PowerShell launcher: only loopback pages
          // or the already-trusted host may change the self-update source.
          const origin = String(req.headers.origin || '');
          let currentHost = '';
          try { currentHost = fs.readFileSync(hostUrlFile, 'utf8').trim(); } catch { /* none yet */ }
          const originOk = !origin
            || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
            || (currentHost && origin.startsWith(currentHost));
          if (originOk) {
            try { fs.writeFileSync(hostUrlFile, String(body.preferredHostUrl), 'utf8'); } catch { /* ignore */ }
          }
        }
        const saved = saveConfig(cfg);
        send({ ok: true, romDirectory: resolveRomDirectory(saved), extraRomDirs: saved.extraRomDirs || [] });
        return;
      }

      // Proactive "scan my drives" report — walks romDirectory and every
      // configured extraRomDirs entry and counts recognized ROM files, so a
      // "Scan Now" button in Client Setup can show "found 342 ROMs across 2
      // folders" instead of the UI only ever discovering existing files one
      // game at a time as each is individually launched.
      if (req.method === 'POST' && p === '/rom-scan') {
        const cfg = loadConfig();
        const roots = [resolveRomDirectory(cfg), ...(Array.isArray(cfg.extraRomDirs) ? cfg.extraRomDirs : [])]
          .filter((r) => r && String(r).trim());
        const perRoot = [];
        let totalFound = 0;
        let filesScanned = 0;
        for (const root of roots) {
          const exists = fs.existsSync(root);
          // "Scan Now" is a deliberate, user-initiated request for a current
          // answer — force a fresh walk rather than serving a cached index
          // that might be minutes stale, and this also warms the cache that
          // findRomAnywhere() reads from on the next launch attempt.
          const entries = exists ? getRomIndex(root, true) : [];
          perRoot.push({ root, filesFound: entries.length, exists });
          totalFound += entries.length;
          filesScanned += entries.length;
        }
        send({ ok: true, totalFound, roots: perRoot, filesScanned });
        return;
      }

      if (req.method === 'POST' && p === '/launch') {
        const body = await readBody(req);
        const result = await dedupeLaunch(body, () => handleLaunch(body));
        send(result.json, result.status);
        return;
      }

      if (req.method === 'POST' && p === '/launch-exe') {
        const body = await readBody(req);
        const result = await handleLaunchExe(body);
        send(result.json, result.status);
        return;
      }

      if (req.method === 'POST' && p === '/pick-path') {
        // Electron-only: plain native file/folder dialog, no side effects (unlike
        // /pick-folder above, this never touches launcher-config.json or creates
        // subfolders). Used by the HOST setup wizard's individual path fields
        // (ROMs dir, BIOS dir, RetroArch executable) where each field is picked
        // independently and none of them should silently reconfigure the local
        // client launcher's own root folder.
        try {
          const body = await readBody(req);
          let dialog = null;
          try { ({ dialog } = require('electron')); } catch { /* Tauri build: no electron */ }
          if (!dialog) {
            // This build has no native picker of its own (the app migrated from
            // Electron to Tauri). Previously the require() threw and this
            // answered a bare 500, which the setup wizard surfaced as an
            // unexplained failure on every Browse button. Say what's actually
            // true so the UI can fall back to its own dialog or a typed path.
            send({
              ok: false,
              unsupported: true,
              error: 'This build has no native file picker. Type the path directly, or use the app\'s own folder picker.',
            }, 400);
            return;
          }
          const win = typeof opts.getMainWindow === 'function' ? opts.getMainWindow() : null;
          const mode = body && body.mode === 'file' ? 'file' : 'folder';
          const dialogOpts = mode === 'folder'
            ? { title: (body && body.title) || 'Select a folder', buttonLabel: 'Select Folder', properties: ['openDirectory', 'createDirectory'] }
            : { title: (body && body.title) || 'Select a file', buttonLabel: 'Select File', properties: ['openFile'] };
          const result = win
            ? await dialog.showOpenDialog(win, dialogOpts)
            : await dialog.showOpenDialog(dialogOpts);
          if (result.canceled || !result.filePaths?.[0]) {
            send({ ok: false, canceled: true });
            return;
          }
          send({ ok: true, path: result.filePaths[0] });
        } catch (e) {
          send({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
        }
        return;
      }

      if (req.method === 'POST' && p === '/pick-folder') {
        // Chooses the ONE root folder where everything (ROMs, cores, bios,
        // saves, states) lives.
        //
        // Accepts an explicit { path } in the body FIRST. That is now the
        // primary route: this handler used to depend solely on Electron's
        // native dialog, and the app has since migrated fully to Tauri, so
        // require('electron') throws MODULE_NOT_FOUND and the picker answered
        // 500 on every install — leaving emulationRoot permanently unset and
        // auto-setup permanently blocked. The Tauri UI opens its own dialog
        // (tauri-plugin-dialog) and posts the chosen path here. The Electron
        // branch is kept only so an older packaged build keeps working.
        try {
          const body = await readBody(req).catch(() => ({}));
          const explicit = String(body?.path || '').trim();
          let root = '';

          if (explicit) {
            try {
              const st = fs.statSync(explicit);
              if (!st.isDirectory()) { send({ ok: false, error: `Not a directory: ${explicit}` }, 400); return; }
              root = explicit;
            } catch {
              // Allow choosing a folder that doesn't exist yet (the picker's
              // "create new folder" case) rather than rejecting it outright.
              try { fs.mkdirSync(explicit, { recursive: true }); root = explicit; }
              catch (e) { send({ ok: false, error: `Could not use folder: ${String(e && e.message ? e.message : e)}` }, 400); return; }
            }
          } else {
            let dialog = null;
            try { ({ dialog } = require('electron')); } catch { /* Tauri build: no electron */ }
            if (!dialog) {
              send({
                ok: false,
                error: 'No folder path supplied. Pick a folder in the app and send it as {"path":"..."} — this build has no native picker of its own.',
              }, 400);
              return;
            }
            const win = typeof opts.getMainWindow === 'function' ? opts.getMainWindow() : null;
            const dialogOpts = {
              title: 'Choose your NexusEmu emulation folder',
              buttonLabel: 'Use this folder',
              properties: ['openDirectory', 'createDirectory'],
            };
            const result = win
              ? await dialog.showOpenDialog(win, dialogOpts)
              : await dialog.showOpenDialog(dialogOpts);
            if (result.canceled || !result.filePaths?.[0]) {
              send({ ok: false, canceled: true });
              return;
            }
            root = result.filePaths[0];
          }
          const romDirectory = path.join(root, 'roms');
          for (const sub of ['roms', 'cores', 'bios', 'saves', 'states', 'screenshots']) {
            ensureDirSync(path.join(root, sub));
          }
          const cfg = loadConfig();
          cfg.romDirectory = romDirectory;
          cfg.emulationRoot = root;
          saveConfig(cfg);
          send({ ok: true, root, romDirectory, emulatorRoot: emuRoot, folderName: path.basename(root) });
        } catch (e) {
          send({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
        }
        return;
      }

      if (req.method === 'POST' && p === '/clone-host-setup') {
        try {
          const body = await readBody(req);
          const hostUrl = String(body.hostUrl || '').replace(/\/+$/, '');
          const token = String(body.token || '');
          if (!hostUrl) { send({ ok: false, error: 'hostUrl required' }, 400); return; }
          const result = await performCloneHostSetup(hostUrl, token);
          send(result, result.ok === false && result.error ? 400 : 200);
        } catch (e) {
          send({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
        }
        return;
      }

      if (req.method === 'GET' && p === '/share/status') {
        const cfg = loadConfig();
        const lanIp = getLanAddress();
        const fileCount = cfg.shareEnabled && cfg.shareFolder ? listSharedFiles(cfg.shareFolder).length : 0;
        send({
          ok: true,
          enabled: !!cfg.shareEnabled,
          folder: cfg.shareFolder || '',
          fileCount,
          lanUrl: lanIp ? `http://${lanIp}:${SHARE_PORT}` : null,
        });
        return;
      }

      if (req.method === 'POST' && p === '/share/set') {
        const body = await readBody(req);
        const cfg = loadConfig();
        if (typeof body.folder === 'string' && body.folder.trim()) {
          try {
            if (!fs.statSync(body.folder).isDirectory()) throw new Error('Not a directory');
          } catch {
            send({ ok: false, error: 'That folder does not exist or is not accessible.' }, 400);
            return;
          }
          cfg.shareFolder = body.folder.trim();
        }
        if (typeof body.enabled === 'boolean') cfg.shareEnabled = body.enabled;
        const saved = saveConfig(cfg);
        // Fire immediately rather than waiting for the next 5-minute
        // heartbeat — turning sharing on should show up in everyone's
        // library right away, not after an arbitrary delay.
        void registerShareWithHost(saved);
        const fileCount = saved.shareEnabled && saved.shareFolder ? listSharedFiles(saved.shareFolder).length : 0;
        send({ ok: true, enabled: !!saved.shareEnabled, folder: saved.shareFolder || '', fileCount });
        return;
      }

      send({ success: false, error: 'Not found' }, 404);
    } catch (e) {
      try { sendJson(res, { success: false, error: String(e && e.message ? e.message : e) }, 500); } catch { /* socket gone */ }
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.log('[electron] Launcher port 17373 already in use (external launcher running) — embedded launcher idle');
    } else {
      console.error('[electron] Embedded launcher error:', err);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[electron] Embedded client launcher listening on 127.0.0.1:${PORT}`);
  });

  // Always start the share server — its own handler already checks
  // cfg.shareEnabled per-request, so toggling sharing on/off from the UI
  // takes effect immediately without needing to restart this process.
  startShareServer();
  // Registers once at startup (covers "app was closed, folder changed, app
  // reopened") and then periodically, so the host notices this device going
  // offline (a stale registration) rather than showing files forever that
  // can no longer actually be streamed. 5 minutes matches the cadence
  // already used elsewhere in this file for similar refresh-in-background work.
  void registerShareWithHost(loadConfig());
  setInterval(() => { void registerShareWithHost(loadConfig()); }, 5 * 60_000).unref();

  return server;
}

// loadConfig/persistEmulatorPath are exported for the config-race regression
// test — the emulator-path wipe they guard against is only observable by
// interleaving two writes, which needs the real functions, not a re-creation
// of them.
module.exports = {
  startEmbeddedLauncher, LAUNCHER_PORT: PORT, SHARE_PORT, getClientRoot,
  loadConfig, persistEmulatorPath,
};

if (require.main === module) {
  startEmbeddedLauncher();
}

