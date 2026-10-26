// Where each console's games can run, and what this device is. One answer
// for the whole app: game cards, the Games filter, Play on this phone and
// Set up games all ask here (also as window.nxRuns, which boot.js sets up
// before the compiled app runs).
//
//   browser  plays inside SaveState on any device (EmulatorJS)
//   pc       the Windows app's emulators (every console)
//   phone    an emulator app on Android that SaveState hands the game to

// Platform names as games are stored (games.platform), with their aliases.
const ALIAS = {
  psx: "ps1", playstation: "ps1", "playstation 2": "ps2", playstation2: "ps2",
  gbc: "gb", "game boy": "gb", megadrive: "genesis", "mega drive": "genesis", md: "genesis",
  gamegear: "mastersystem", gg: "mastersystem", sms: "mastersystem",
  arcade: "mame", fbneo: "mame", fba: "mame",
  atari2600: "atari", atari7800: "atari", a2600: "atari",
  turbografx: "pce", "turbografx-16": "pce", pcengine: "pce",
  gc: "gamecube", ngc: "gamecube", famicom: "nes", sfc: "snes", superfamicom: "snes",
  segacd: "segacd", megacd: "segacd", "sega cd": "segacd",
};
export const norm = (p) => { const k = String(p ?? "").toLowerCase().trim(); return ALIAS[k] ?? k; };

// Plays in the browser on phones and computers alike.
const BROWSER = new Set(["nes", "snes", "n64", "gb", "gba", "nds", "genesis", "mastersystem", "segacd", "neogeo", "mame", "pce", "atari", "lynx", "ps1"]);

// Android emulator apps, best first. `mode` is how the game is handed over
// (NxAndroidPlugin.open). Links go to each emulator's own page or its Play
// Store listing.
const DOLPHIN = { pkg: "org.dolphinemu.dolphinemu", name: "Dolphin", mode: "autostart", get: "https://play.google.com/store/apps/details?id=org.dolphinemu.dolphinemu" };
export const PHONE_APPS = {
  psp: [
    { pkg: "org.ppsspp.ppssppgold", name: "PPSSPP Gold", mode: "view" },
    { pkg: "org.ppsspp.ppsspp", name: "PPSSPP", mode: "view", get: "https://play.google.com/store/apps/details?id=org.ppsspp.ppsspp" },
  ],
  ps2: [
    { pkg: "xyz.aethersx2.android", name: "NetherSX2", mode: "bootPath", get: "https://github.com/Trixarian/NetherSX2-patch/releases", bios: true,
      note: "NetherSX2 isn't in the Play Store: its page explains how to install it. On its first start it asks for a PS2 BIOS." },
  ],
  gamecube: [DOLPHIN],
  wii: [DOLPHIN],
  // Azahar's Play Store build keeps Lime3DS's package name; its GitHub build
  // is org.azahar_emu.azahar (".debug" for test builds). Only the second was
  // known, so a Play Store Azahar showed as "not installed" (2026-10-21).
  "3ds": [
    { pkg: "io.github.lime3ds.android", name: "Azahar", mode: "view", get: "https://play.google.com/store/apps/details?id=io.github.lime3ds.android" },
    { pkg: "org.azahar_emu.azahar", name: "Azahar", mode: "view" },
    { pkg: "org.azahar_emu.azahar.debug", name: "Azahar", mode: "view" },
    { pkg: "io.github.lime3ds.android.debug", name: "Azahar", mode: "view" },
  ],
  dreamcast: [{ pkg: "com.flycast.emulator", name: "Flycast", mode: "view", get: "https://play.google.com/store/apps/details?id=com.flycast.emulator" }],
  saturn: [
    { pkg: "org.devmiyax.yabasanshioro2.pro", name: "Yaba Sanshiro 2 Pro", mode: "view" },
    { pkg: "org.devmiyax.yabasanshioro2", name: "Yaba Sanshiro 2", mode: "view", get: "https://play.google.com/store/apps/details?id=org.devmiyax.yabasanshioro2" },
  ],
};
// Folder names under Downloads/SaveState on the phone.
export const PHONE_FOLDER = { psp: "PSP", ps2: "PS2", gamecube: "GameCube", wii: "Wii", "3ds": "3DS", dreamcast: "Dreamcast", saturn: "Saturn",
  gb: "Game Boy", gbc: "Game Boy", gba: "GBA", snes: "SNES", nes: "NES" };

// Consoles SaveState's Android app plays itself (Phase 7: our own builds of
// these cores, engine/cores/build-core.ps1), no other app needed.
export const NATIVE_CORES = { gb: "gambatte", gbc: "gambatte", gba: "mgba", snes: "snes9x", nes: "fceumm", psp: "ppsspp" };
/** The core the app plays this console with, when the app's engine works on this phone. */
export const nativeCore = (platform) => (inAndroidApp() && typeof window !== "undefined" && window.__nxEngineOK ? NATIVE_CORES[norm(platform)] ?? null : null);

const ua = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);
export const isAndroid = () => /Android/i.test(ua());
export const isIOS = () => /iPhone|iPad|iPod/i.test(ua()) || (/Macintosh/i.test(ua()) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
export const isPhone = () => isAndroid() || isIOS() || /Mobi/i.test(ua());
export const isWindows = () => /Windows/i.test(ua()) && !isPhone();
export const isLinux = () => /Linux|X11|CrOS/i.test(ua()) && !isPhone();
export const inAndroidApp = () => { try { return !!window.Capacitor?.isNativePlatform?.() && isAndroid(); } catch { return false; } };

/** Where a console's games run: { browser, pc, phone: [apps] | null }. */
export function runsOn(platform) {
  const p = norm(platform);
  return { browser: BROWSER.has(p), pc: p !== "" && p !== "unknown", phone: PHONE_APPS[p] ?? null };
}

/** This device: "android", "ios", "windows", "linux" or "computer" (a Mac). */
export const here = () => (isAndroid() ? "android" : isIOS() ? "ios" : isWindows() ? "windows" : isLinux() ? "linux" : "computer");

/**
 * Whether a game can be played right here without streaming:
 *   Android  the browser consoles, plus those with an Android emulator app
 *   iPhone   the browser consoles
 *   Windows, Linux  everything (SaveState for Windows / Linux runs the rest)
 *   Mac      the browser consoles
 */
export function playsHere(platform) {
  const r = runsOn(platform);
  const d = here();
  if (d === "windows" || d === "linux") return r.pc;
  if (d === "android") return r.browser || !!r.phone;
  return r.browser;
}

/** A short label for a card: where this game plays. */
export function whereLabel(platform) {
  const r = runsOn(platform);
  if (r.browser) return "Any device";
  if (r.phone) return "PC and Android";
  return "PC only";
}

/** The Android apps for a console, on an Android phone only. */
export const phoneHere = (platform) => (isAndroid() ? PHONE_APPS[norm(platform)] ?? null : null);

if (typeof window !== "undefined") window.nxRuns = { norm, runsOn, playsHere, phoneHere, here, whereLabel, isPhone, inAndroidApp, nativeCore, PHONE_APPS, PHONE_FOLDER, NATIVE_CORES };
