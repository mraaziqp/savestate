// What each system needs before a game will run, for the setup guide.
//
// The app ships no games and no console system files. Everything here tells
// someone exactly which files they have to bring, what they are called and
// where they go. Links only point at emulator authors' own sites and at
// documentation for dumping files from hardware the reader owns; the one
// system file that is published by its maker (PS3 firmware) links there.
//
// `play` is where a system runs: "browser" needs nothing installed, "retroarch"
// needs the desktop or Android app's RetroArch, "standalone" needs its own
// emulator. BIOS names match REQUIRED_BIOS in server.ts, which is what the
// launcher actually checks for.

export const EMULATORS = {
  retroarch: { name: "RetroArch", url: "https://www.retroarch.com/?page=platforms" },
  duckstation: { name: "DuckStation", url: "https://www.duckstation.org/" },
  pcsx2: { name: "PCSX2", url: "https://pcsx2.net/downloads" },
  rpcs3: { name: "RPCS3", url: "https://rpcs3.net/download" },
  ppsspp: { name: "PPSSPP", url: "https://www.ppsspp.org/download" },
  dolphin: { name: "Dolphin", url: "https://dolphin-emu.org/download/" },
  cemu: { name: "Cemu", url: "https://cemu.info/" },
  xemu: { name: "xemu", url: "https://xemu.app/" },
  xenia: { name: "Xenia", url: "https://xenia.jp/download/" },
  flycast: { name: "Flycast", url: "https://github.com/flyinghead/flycast/releases" },
  melonds: { name: "melonDS", url: "https://melonds.kuribo64.net/downloads.php" },
  mgba: { name: "mGBA", url: "https://mgba.io/downloads.html" },
  mame: { name: "MAME", url: "https://www.mamedev.org/release.html" },
  azahar: { name: "Azahar", url: "https://azahar-emu.org/" },
};

const SYSTEM_DIR = "RetroArch's system folder";
const none = { need: "none" };

export const SYSTEMS = [
  // ── Sony ──
  { id: "ps1", name: "PlayStation", maker: "Sony", play: "browser", core: "PCSX-ReARMed", alt: "duckstation",
    formats: ".chd, .cue + .bin, .pbp, .iso",
    bios: { need: "required", anyOne: true, folder: SYSTEM_DIR,
      files: [
        { name: "scph5501.bin", note: "North America", md5: "490f666e1afb15b7362b406ed1cea246" },
        { name: "scph5500.bin", note: "Japan", md5: "8dd7d5296a650fac7319bce665a6a53c" },
        { name: "scph5502.bin", note: "Europe", md5: "32736f17079d0b2b7024407c39bd3050" },
        { name: "scph1001.bin", note: "North America, early model" },
      ],
      how: "Dump it from your own PlayStation. Any one of these is enough; use the one that matches your games' region.",
      links: [{ label: "BIOS names and checksums (libretro docs)", url: "https://docs.libretro.com/library/pcsx_rearmed/" }] } },
  { id: "ps2", name: "PlayStation 2", maker: "Sony", play: "standalone", emu: "pcsx2",
    formats: ".iso, .chd, .cso",
    bios: { need: "required", anyOne: true, folder: "PCSX2's bios folder (Settings > BIOS shows the path)",
      files: [
        { name: "scph70012.bin", note: "North America, slim" },
        { name: "scph39001.bin", note: "North America" },
        { name: "scph30004r.bin", note: "Europe" },
      ],
      how: "Dump it from your own PlayStation 2 with PCSX2's BIOS dumper. Any PS2 BIOS dump works; these are the names the launcher looks for.",
      links: [{ label: "How to dump your PS2 BIOS (PCSX2 docs)", url: "https://pcsx2.net/docs/setup/bios" }] } },
  { id: "ps3", name: "PlayStation 3", maker: "Sony", play: "standalone", emu: "rpcs3",
    formats: "Disc folders (PS3_GAME), .iso, .pkg",
    bios: { need: "required", folder: "Installed inside RPCS3 (File > Install Firmware)",
      files: [{ name: "PS3UPDAT.PUP", note: "System software, free from Sony" }],
      how: "Download the official PS3 system software from PlayStation and install it in RPCS3. This one is published by Sony, so no console is needed.",
      links: [
        { label: "PS3 system software (playstation.com)", url: "https://www.playstation.com/en-us/support/hardware/ps3/system-software/" },
        { label: "RPCS3 quickstart", url: "https://rpcs3.net/quickstart" },
      ] } },
  { id: "psp", name: "PSP", maker: "Sony", play: "retroarch", core: "PPSSPP", alt: "ppsspp",
    formats: ".iso, .cso, .pbp", bios: none },

  // ── Nintendo ──
  { id: "nes", name: "NES", maker: "Nintendo", play: "browser", core: "FCEUmm", formats: ".nes, .zip", bios: none },
  { id: "snes", name: "Super NES", maker: "Nintendo", play: "browser", core: "Snes9x", formats: ".sfc, .smc, .zip", bios: none },
  { id: "n64", name: "Nintendo 64", maker: "Nintendo", play: "browser", core: "Mupen64Plus-Next", formats: ".z64, .n64, .v64", bios: none },
  { id: "gb", name: "Game Boy / Color", maker: "Nintendo", play: "browser", core: "mGBA", formats: ".gb, .gbc, .zip", bios: none },
  { id: "gba", name: "Game Boy Advance", maker: "Nintendo", play: "browser", core: "mGBA", alt: "mgba",
    formats: ".gba, .zip",
    bios: { need: "optional", folder: SYSTEM_DIR, files: [{ name: "gba_bios.bin", md5: "a860e8c0b6d573d191e4ec7db1b1e4f6" }],
      how: "Games run without it. Add a dump from your own GBA only if you want the original boot logo or a game misbehaves.",
      links: [{ label: "mGBA core (libretro docs)", url: "https://docs.libretro.com/library/mgba/" }] } },
  { id: "nds", name: "Nintendo DS", maker: "Nintendo", play: "browser", core: "DeSmuME", alt: "melonds",
    formats: ".nds, .zip",
    bios: { need: "required", folder: SYSTEM_DIR,
      files: [{ name: "bios7.bin", note: "ARM7 BIOS" }, { name: "bios9.bin", note: "ARM9 BIOS" }, { name: "firmware.bin", note: "DS firmware" }],
      how: "Dump all three from your own Nintendo DS. The launcher checks for bios7.bin; the other two belong alongside it.",
      links: [{ label: "DS BIOS files (libretro docs)", url: "https://docs.libretro.com/library/melonds/" }] } },
  { id: "3ds", name: "Nintendo 3DS", maker: "Nintendo", play: "retroarch", core: "Citra", alt: "azahar",
    formats: ".3ds, .cci, .cxi (decrypted)",
    bios: { need: "none", how: "Decrypted game dumps need no system files. Dump your own cartridges with a modded 3DS." } },
  { id: "gamecube", name: "GameCube", maker: "Nintendo", play: "standalone", emu: "dolphin",
    formats: ".rvz, .iso, .gcz, .ciso",
    bios: { need: "none", how: "Dolphin needs no system files.",
      links: [{ label: "Dumping your own discs (Dolphin wiki)", url: "https://wiki.dolphin-emu.org/index.php?title=Ripping_Games" }] } },
  { id: "wii", name: "Wii", maker: "Nintendo", play: "standalone", emu: "dolphin",
    formats: ".rvz, .wbfs, .iso",
    bios: { need: "none", how: "Dolphin needs no system files.",
      links: [{ label: "Dumping your own discs (Dolphin wiki)", url: "https://wiki.dolphin-emu.org/index.php?title=Ripping_Games" }] } },
  { id: "wiiu", name: "Wii U", maker: "Nintendo", play: "standalone", emu: "cemu",
    formats: ".wua, .wud, .wux, .rpx folders",
    bios: { need: "none", how: "Cemu runs dumps made from your own console without extra system files. Online play needs files dumped from your Wii U." } },
  { id: "switch", name: "Nintendo Switch", maker: "Nintendo", play: "standalone",
    formats: ".nsp, .xci",
    bios: { need: "required", folder: "Your Switch emulator's keys and firmware folders",
      files: [{ name: "prod.keys", note: "Console keys" }, { name: "Firmware", note: "System firmware dump" }],
      how: "Both must be dumped from your own Switch. There is nowhere legitimate to download them." } },

  // ── Sega ──
  { id: "genesis", name: "Genesis / Mega Drive", maker: "Sega", play: "browser", core: "Genesis Plus GX", formats: ".md, .gen, .bin, .zip", bios: none },
  { id: "mastersystem", name: "Master System / Game Gear", maker: "Sega", play: "browser", core: "Genesis Plus GX", formats: ".sms, .gg, .zip", bios: none },
  { id: "segacd", name: "Sega CD", maker: "Sega", play: "browser", core: "Genesis Plus GX",
    formats: ".chd, .cue + .bin",
    bios: { need: "required", anyOne: true, folder: SYSTEM_DIR,
      files: [{ name: "bios_CD_U.bin", note: "North America" }, { name: "bios_CD_E.bin", note: "Europe" }, { name: "bios_CD_J.bin", note: "Japan" }],
      how: "Dump it from your own Sega CD / Mega-CD. Use the one that matches your games' region.",
      links: [{ label: "Sega CD BIOS names and checksums (libretro docs)", url: "https://docs.libretro.com/library/genesis_plus_gx/" }] } },
  { id: "saturn", name: "Saturn", maker: "Sega", play: "retroarch", core: "Yabause",
    formats: ".chd, .cue + .bin",
    bios: { need: "required", anyOne: true, folder: SYSTEM_DIR,
      files: [{ name: "saturn_bios.bin" }, { name: "sega_101.bin", note: "Japan" }, { name: "mpr-17933.bin", note: "North America / Europe" }],
      how: "Dump it from your own Saturn.",
      links: [{ label: "Saturn BIOS (libretro docs)", url: "https://docs.libretro.com/library/yabause/" }] } },
  { id: "dreamcast", name: "Dreamcast", maker: "Sega", play: "retroarch", core: "Flycast", alt: "flycast",
    formats: ".chd, .gdi, .cdi",
    bios: { need: "optional", folder: `${SYSTEM_DIR}, in a subfolder named dc`,
      files: [{ name: "dc_boot.bin", note: "BIOS" }, { name: "dc_flash.bin", note: "Settings and date" }],
      how: "Most games boot without them. Add dumps from your own Dreamcast for the best compatibility.",
      links: [{ label: "Dreamcast BIOS (libretro docs)", url: "https://docs.libretro.com/library/flycast/" }] } },

  // ── Arcade and others ──
  { id: "neogeo", name: "Neo Geo", maker: "SNK", play: "browser", core: "FinalBurn Neo",
    formats: ".zip romsets (do not unzip)",
    bios: { need: "required", folder: "The same folder as your Neo Geo games",
      files: [{ name: "neogeo.zip", note: "Neo Geo BIOS set" }],
      how: "It comes from your own board or an official collection you bought. Keep it zipped, next to the game zips.",
      links: [{ label: "FinalBurn Neo romsets (libretro docs)", url: "https://docs.libretro.com/library/fbneo/" }] } },
  { id: "mame", name: "Arcade (MAME)", maker: "Arcade", play: "browser", core: "MAME", alt: "mame",
    formats: ".zip romsets (do not unzip)",
    bios: { need: "varies", folder: "The same folder as your arcade games",
      how: "Some boards need a BIOS set (for example neogeo.zip) in the games folder. Romsets must match the MAME version; a set made for another version often will not start." } },
  { id: "pce", name: "PC Engine / TurboGrafx-16", maker: "NEC", play: "browser", core: "Beetle PCE", formats: ".pce, .zip, .chd",
    bios: { need: "optional", folder: SYSTEM_DIR, files: [{ name: "syscard3.pce", note: "Only for CD games" }],
      how: "Cartridge (HuCard) games need nothing. CD games need the System Card dumped from your own console.",
      links: [{ label: "PC Engine CD BIOS (libretro docs)", url: "https://docs.libretro.com/library/beetle_pce_fast/" }] } },
  { id: "atari", name: "Atari 2600 / 7800", maker: "Atari", play: "browser", core: "Stella / ProSystem", formats: ".a26, .a78, .bin, .zip", bios: none },
  { id: "lynx", name: "Atari Lynx", maker: "Atari", play: "browser", core: "Beetle Lynx", formats: ".lnx",
    bios: { need: "required", folder: SYSTEM_DIR, files: [{ name: "lynxboot.img" }], how: "Dump it from your own Lynx.",
      links: [{ label: "Lynx BIOS (libretro docs)", url: "https://docs.libretro.com/library/beetle_lynx/" }] } },
  { id: "xbox", name: "Xbox", maker: "Microsoft", play: "standalone", emu: "xemu",
    formats: ".iso (XISO)",
    bios: { need: "required", folder: "Chosen in xemu under Machine > System",
      files: [{ name: "MCPX boot ROM", note: "mcpx_1.0.bin" }, { name: "Flash ROM (BIOS)", note: "for example Complex 4627" }, { name: "Hard disk image", note: "xbox_hdd.qcow2" }],
      how: "xemu needs three files from an original Xbox. Its documentation explains each one and how to make them from your own console.",
      links: [{ label: "Required files (xemu docs)", url: "https://xemu.app/docs/required-files/" }] } },
  { id: "xbox360", name: "Xbox 360", maker: "Microsoft", play: "standalone", emu: "xenia",
    formats: ".iso, .xex, GOD folders", bios: { need: "none", how: "Xenia needs no system files." } },
];

export const PLAY = {
  browser: { label: "Plays in the browser", detail: "Nothing to install. Also runs in the desktop and Android apps." },
  retroarch: { label: "Needs the desktop or Android app", detail: "Runs in RetroArch, which the app sets up for you." },
  standalone: { label: "Needs its own emulator", detail: "Install it on the PC you play on; the app launches it for you." },
};
