# SaveState Engine: specification and progress

The living plan for replacing external RetroArch (and, later, the other
emulator windows) with SaveState's own libretro host. Every session that
works on the engine reads this first and updates it after each task.

Status: **Phase 1 (reconnaissance and blueprint) done, waiting for approval.**

---

## 1. What exists today (reconnaissance, 2026-10-19)

### SaveState
| Part | Stack | Where |
|---|---|---|
| Web app (the "app" on every device) | React, compiled bundles patched by `web-src/app/build.mjs`, own components in `web-src/app/*.jsx` | `dist/`, served by the host |
| Host / media server | Node 22, Express, one bundled `server.ts` + `server/*.ts`, Postgres (Neon) | this PC (port 3000), NAS (Node 18, ARM) |
| PC game launcher | Node, `client-launcher.cjs`, HTTP on `127.0.0.1:17373` | `%LOCALAPPDATA%\NexusEmuClient` (v10) |
| Android app | Capacitor thin client of the site + `NxAndroidPlugin` | `android/` |
| PS Vita app | C, vita2d/libcurl | `vita/` |
| Browser play | EmulatorJS (libretro cores compiled to WebAssembly) | `EmulatorPlayer` chunk |

SaveState on a PC is a **web page** (a browser tab or the installed web app).
There is no native desktop shell in use (the old Tauri build, 1.0.41, is retired).

### How a game starts today
1. The page calls the launcher: `POST http://127.0.0.1:17373/launch`.
2. `client-launcher.cjs` `handleLaunch()` (line ~2765) downloads the game to its
   cache (`/cache-rom`), picks the emulator, and spawns it as a **separate
   window**: RetroArch `retroarch.exe -L <core> <rom> -f`, or PCSX2 / Dolphin /
   RPCS3 / Ryujinx / Cemu / xemu / Xenia with their own full-screen flags.
3. `PlayOverlay.jsx` follows the process (`/launch/status`, `/launch/stop`).

That separate window is what the owner wants gone.

### This PC
- CPU Ryzen 5 5600, GPU **RTX 3060 Ti** (NVENC H.264/HEVC/AV1 available).
- RetroArch installed at `C:\RetroArch-Win64` (binaries only), with cores:
  fceumm, snes9x, mgba, genesis_plus_gx, mednafen_pce(_fast), mednafen_lynx,
  stella, fbneo, mame / mame2003_plus, pcsx_rearmed, mupen64plus_next,
  flycast, yabause, mednafen_saturn, melonds / melondsds, citra, ppsspp,
  **dolphin**, **pcsx2** (LRPS2). So PS2, GameCube/Wii, PSP, N64, Dreamcast,
  Saturn, DS and 3DS can all run through a libretro host.
- **No RetroArch source on this PC** (searched G:\Projects, E:\, Downloads,
  Documents, D:\). The engine needs only the public ABI: `libretro.h` and a
  few `libretro-common` files as reference, fetched from
  github.com/libretro/RetroArch (MIT-licensed header) in Phase 2.
- Rust is installed with the MSVC toolchain, **but there is no MSVC linker**
  (Visual Studio folders are empty). The Build Tools install was cancelled at
  the Windows permission prompt (error 1602), so **the engine builds with
  Rust's GNU toolchain instead** (`stable-x86_64-pc-windows-gnu`, pinned in
  `engine/rust-toolchain.toml`): it ships its own linker, needs no Visual
  Studio and no C compiler, and produces the same kind of exe. Two
  consequences, both handled:
  - Its bundled `dlltool` can't build "raw-dylib" import libraries (it has
    no assembler), so dependencies stay on versions that link through
    prebuilt import libraries: `libloading 0.8.6`, `native-tls 0.2.14`,
    `schannel 0.1.27` (pinned in `Cargo.lock`).
  - `engine/build.cmd` puts the toolchain's `self-contained` folder on PATH
    and runs `cargo build`; tests run the same way with `cargo test`.
- ViGEmBus (virtual Xbox controllers) is installed (with Sunshine).

---

## 2. Decisions

### 2.1 Language and process model: a Rust engine, one process per game
`savestate-engine.exe`, a Rust program the launcher starts for each game:

- **Crash armour:** a core is native C/C++ code with global state; if it
  crashes, only that game's engine process dies. The launcher, the page and
  the host carry on, and the page shows "the game stopped" with Try again.
  Exiting the process wipes the core's static memory.
- **Why Rust:** memory-safe host code around an unsafe C ABI; `cargo` is
  already installed; `libloading` (dynamic libraries), the `windows` crate
  (Media Foundation, Windows Graphics Capture, WASAPI, XInput), `gilrs`
  (SDL controller database), `tokio-tungstenite` (WebSocket) and `zstd` are
  mature; it builds to one self-contained exe the installer can ship.
- **Not chosen:** a Node native addon inside the launcher (a core crash
  would take the launcher down); in-browser WebAssembly (that is EmulatorJS
  already: no PS2/GameCube, no GPU cores, no native controllers).

### 2.2 Getting the game "inside SaveState"
SaveState is a web page, so the engine cannot draw into it directly. The
engine streams to the page over a local WebSocket on `127.0.0.1`, and the
page draws in its own player (the same full-screen player EmulatorJS uses):

| Path | Used for | How (as built in Phase 3) |
|---|---|---|
| **Raw frames** | every core on this PC, 2D and GPU | Software cores: the core's own format (RGB565 kept 16-bit, XRGB8888; 0RGB1555 repacked to RGB565). GPU cores: the framebuffer read back asynchronously (pixel-pack buffer + fence, collected while the engine waits for the next frame's time), RGBA8, flagged bottom-up for the page to flip. Sent as binary WebSocket messages; the page uploads them to a WebGL2 texture once per display refresh. Measured: GameCube at 640x528 RGBA, 60 pictures/s, about 80 MB/s on loopback, under a frame of delay. |
| **Encoded video** | other devices (Phase 6) | Not needed on the same PC: the raw path holds 60 fps for GPU cores and for captured emulators. For other devices (phones, tablets, other PCs) the page's own canvas goes out over WebRTC (`canvas.captureStream`), so Chrome's hardware encoder does the encoding; no encoder of our own was needed (see 13). |
| **Audio** | everything | Resampled in the engine (windowed sinc) to 48 kHz stereo 16-bit, sent over the same socket into an `AudioWorklet` ring buffer that reports its fill for rate control. |
| **Input** | everything | Xbox-type controllers are read by the engine itself through XInput (loaded at run time; Guide through XInputGetStateEx), every frame on the emulation thread, with rumble back to the controller. Other controllers (DualSense, Switch Pro...) and the keyboard (remappable) come from the page (Gamepad API), on the ports after the engine's. `gilrs` was not used: its Windows backend pulls in crates this toolchain can't link (see 1). |

The page applies the **shader presets** in WebGL (raw integer scale, CRT
aperture grille, handheld LCD grid, smooth upscale), so they look the same
locally and, later, on other devices.

Phase 6 added **WebRTC** so phones, tablets and other PCs can play what the
engine (or a captured emulator) shows (see 13). Still possible later: an
optional native desktop shell (WebView2 + DirectComposition) for a zero-copy
GPU path on this PC.

### 2.3 Emulators that are not libretro cores
RPCS3 (PS3), Ryujinx/Eden (Switch), Cemu (Wii U), xemu (Xbox) and Xenia (Xbox
360) have no usable libretro core. They get a **capture bridge** (built in
Phase 6, see 13): `savestate-engine capture` starts the emulator, moves its
window off the screen, captures it with Windows Graphics Capture (on the GPU,
halved there when wider than 1600 pixels), sends it through the same raw
path as a core's picture, and drives it through a ViGEm virtual Xbox
controller, so these play inside SaveState too. The same bridge serves any
standalone emulator the launcher starts (PCSX2 and PPSSPP when installed,
standalone Dolphin, DuckStation...). GameCube/Wii moved to the dolphin core
in Phase 5.

### 2.4 What is taken from RetroArch, and what is left out
Taken (as reference, reimplemented in Rust): the ABI in `libretro.h`; the
environment switchboard and frame loop ideas from `runloop.c` /
`core_impl.c`; dynamic loading (`dylib.c`); the rate-control idea from
`audio_driver.c`; the VFS interface (`vfs_implementation.c`); run-ahead and
rewind ideas.
Left out entirely: every menu driver (XMB, Ozone, RGUI, MaterialUI), the
config-file system, playlists, the online updater, overlays, input remapping
menus, netplay, achievements (possible later), all legacy video/audio
drivers. SaveState is the frontend.

---

### 2.5 Efficiency and power upgrades (added on approval, 2026-10-19)

Efficiency (status after Phase 3):
1. **No wasted frames** (done): duplicate frames are never sent; RGB565
   cores stay 16-bit on the wire; pictures are never sent faster than the
   page's display refreshes (it reports its rate), and a page that falls
   behind gets the newest picture, never a queue of old ones.
2. **One copy less** (done): `GET_CURRENT_SOFTWARE_FRAMEBUFFER` hands
   software cores the engine's own frame buffer; GPU pictures swap buffers
   instead of copying.
3. **GPU readback without stalls** (done, replacing the zero-copy D3D11
   interop for now): pixel-pack buffer + fence, collected in the engine's
   idle time before the next frame. The D3D11 interop belongs with the
   hardware encoder in Phase 6.
4. **Encoder tuned for play** (done in Phase 6): the WebRTC video is marked
   as motion, keeps 60 frames a second over sharpness, up to 12 Mbit/s.
5. **Pre-warmed worker** (Phase 5): engine start-up measured at 0.2-1.4 s
   including the game, so this is a smaller win than expected.
6. **Precise pacing** (done): high-resolution waitable timer plus a short
   spin; dynamic rate control (±0.5 %); audio sync (the emulation follows
   the sound card when the page's buffer runs far over target); pacing by
   the frame rate the core's sound implies when it disagrees with the
   declared one (Dolphin declares 119.88 fps and runs at 60).
7. **Small, fast rewind** (done in Phase 4): XOR against the next state +
   LZ4 (pure Rust, `lz4_flex`; zstd needs a C compiler), 256 MB budget.

Power:
1. **Run-ahead** (done in Phase 4; second instance added in Phase 5's
   refinements): software cores run the hidden frames on a second copy of the
   core (its own DLL copy and its own host state, swapped in around its calls
   since libretro callbacks carry no instance pointer), so the real instance
   is never rewound and its sound stays exact; GPU cores use one instance.
2. **Disc streaming** (done in Phase 2): VFS v3 over range requests with a
   block cache on disk.
3. **Preferences on the account** (done in Phase 5): look and run-ahead per
   console, rewind, fast-forward speed, button layout, keyboard keys, save
   slot (`/api/engine/prefs`), newest copy wins.
4. **Live stats** (done): fps, time per frame, sound buffer, skipped
   pictures, in the player's Stats overlay.
5. **Watch and play together** (done in Phase 6): a game on this PC can be
   shared with the person's own phone or tablet, or with a friend, who sees
   and hears it and plays as player 2 (or 1).
6. **Curated core options** (done in Phase 2).

## 3. Layout

```
engine/                         Rust workspace (GNU toolchain, see 1)
  Cargo.toml, Cargo.lock        workspace; release = thin LTO, panic=abort
  rust-toolchain.toml           stable-x86_64-pc-windows-gnu
  build.cmd                     build with the toolchain's linker on PATH
  libretro-sys/                 the ABI: libretro.h (vendored, MIT) + Rust bindings
    include/libretro.h          RetroArch master, API version 1
    src/lib.rs                  constants, #[repr(C)] structs (size-tested), entry-point types
  engine/                       the savestate-engine library + savestate-engine.exe
    src/log.rs                  engine log + the core's printf log callback; core errors collected
    src/loader.rs               load a core DLL, bind all 25 retro_* symbols, API check, unload
    src/env.rs                  retro_environment_t switchboard
    src/host.rs                 host state shared by the callbacks (video, audio, input, options...)
    src/options.rs              core options v0/v1/v2 + curated defaults per core
    src/video.rs                pixel formats, zero-copy software framebuffer, RGBA conversion, PNG
    src/vfs.rs                  VFS v3: local files + HTTP range streaming with block cache
    src/bios.rs                 BIOS check (MD5) and fetch from the host
    src/session.rs              one game: content (local, download, stream, zip), load, run, states, SRAM
    src/hw.rs                   SET_HW_RENDER: hidden window, WGL context (GL core/compat, GLES), FBO, async readback
    src/audio.rs                windowed-sinc resampler to 48 kHz, dynamic rate control
    src/timing.rs               high-resolution frame pacing
    src/ws.rs                   minimal WebSocket server (handshake, frames)
    src/serve.rs                `serve`: one game streamed to the page (threads, outbox, commands)
    src/main.rs                 `info`, `selftest`, `serve`
    src/input.rs                XInput controllers (run-time loaded), layouts, Guide/Back hotkeys, rumble
    src/rewind.rs               rewind ring: XOR deltas + LZ4 within a budget
    src/sync.rs                 the host's copy of saves: battery saves, save states with versions
    src/capture.rs              `capture`: a standalone emulator's window (Windows Graphics Capture, D3D11) streamed like a core
    src/vigem.rs                ViGEmBus virtual Xbox controllers (driver IOCTLs, no SDK), fed by the page's controls
web-src/app/
  EnginePlayer.jsx              the in-SaveState player (WebGL2 with the four looks, AudioWorklet, keyboard/gamepads, menu,
                                capture mode, sharing to another device over WebRTC)
  RemotePlayer.jsx              the other device's side (?play=<code>): video, sound, keyboard/controllers/touch buttons
  PlayOverlay.jsx               opens EnginePlayer when the launcher answers with an engine session, RemotePlayer for ?play=
  build.mjs                     patches: Play asks for the engine; the app's controller navigation pauses during a game
client-launcher.cjs             v14: fetches/updates the engine from the host (SHA-256), runs RetroArch-system
                                games in it, standalone emulators through `capture`; RetroArch only as fallback/netplay;
                                PS3 games kept as a folder fetched whole (or used in place on the host PC)
server.ts                       /api/client-launcher/engine(/info): serves releases/engine (scripts/publish-engine.mjs)
server/enginestates.ts          /api/engine/states (save states, 5 versions per slot, in the database) and /api/engine/prefs
server/rtc.ts                   /api/rtc/rooms: introduces the PC and the other device (offer/answer under a short code)
server.ts                       /api/games/:id/folder(/*): a folder game's file list and files
```

## 4. Engine <-> page protocol (as built)

The launcher starts `savestate-engine serve` with the game, the core, a
one-time key (24 random bytes) and the page's origin. The engine prints
`{"listening":port}` then `{"ready":{...}}` (or `{"error":"..."}`) on stdout;
the launcher hands `{port, key, ready}` to the page, which opens
`ws://127.0.0.1:<port>/session?key=<key>`. The engine refuses any other key
or origin, listens on loopback only, and accepts one page at a time (a new
one replaces the old).

Engine -> page, binary:
- `V` fmt flags 0 | width u32 | height u32 | frame u64 | 0 u32 | pixels
  (fmt 0 = RGB565, 1 = XRGB8888 as B,G,R,X bytes, 2 = RGBA8; flags bit 0 =
  rows bottom-up). The 24-byte header keeps the pixels aligned for typed arrays.
- `A` 0 0 0 | frames u32 | interleaved stereo i16 at 48 kHz

Engine -> page, JSON text: `ready` {info: game, core, version, gpu, fps,
sampleRate, width, height, aspect, rotation}, `geometry`, `status` {fps,
frameMs, audioFillMs, dropped, late, canSave} each second, `saved`/`loaded`
{slot}, `error` {message}, `exit`.

Page -> engine, JSON text: `{"t":"in","p":port,"b":buttons,"a":[lx,ly,rx,ry],"g":[l2,r2]}`
(only on change), `pause`, `resume`, `reset`, `save`/`load` {slot}, `slot`
{n} (the slot hotkeys use), `slots`, `ff` {on}, `ffspeed` {x; 0 = as fast as
it goes}, `rewind` {on} (held), `rewinding` {enabled}, `runahead` {frames},
`layout` {labels}, `audio` {fill, target} (10 a second), `display` {hz},
`option` {key, value}, `quit`.

Phase 5 additions: page -> engine `load` {slot, version} (an earlier
version from the host), `versions` {slot}; engine -> page `synced` {slot,
version} / `syncError` {slot, message} after a slot reached the host,
`versions` {slot, versions}, `slot` {n} (a controller changed the slot),
`nav` {buttons} (the engine's controllers while the menu is open, XInput
bits); `slots` entries add onHost, versions and device; `status` runahead
adds copies (1 or 2).

Phase 5 refinements: page -> engine `delete` {slot} (here and on the
account); engine -> page `deleted` {slot}; `ready` info adds `saveFrom`
{device, backup} when the account's battery save was newer and used.

Phase 6, both `serve` and `capture`: engine -> page `stuck` {stuck: true}
after 20 s without the emulation loop coming round (a core stuck inside a
frame), `stuck` {stuck: false} if it recovers. While stuck, the socket's own
thread still reads `quit`: 8 s after it the process ends (exit code 3);
after 5 minutes stuck it ends anyway.

Phase 6, capture (`savestate-engine capture --key K --title T --emulator
NAME [--origin O]... [--data DIR] -- <emulator> <args>`): the same socket
and messages. `ready` info adds `capture: true`, `nativeControllers`,
`virtualControllers` (ViGEmBus present); pictures are fmt 1 (BGRA as
captured); no `A` messages (the emulator plays its sound on the PC);
`status` is {capture, fps, dropped, pads (virtual controllers plugged in),
width, height, canSave: false}. Page -> engine `in` goes to virtual Xbox
controllers (one per port, plugged in on its first press); `quit` closes
the emulator (WM_CLOSE, then after 3 s the whole process tree).

Phase 6, another device (WebRTC, between two pages; the engine is not
involved): the PC page sends its canvas (60 frames/s) and the game's sound
as media tracks; a data channel "controls" (unordered, no retransmits)
carries `{"t":"in","b","a","g"}` from the other device, and `{"t":"bye"}`
from the PC when it stops sharing. Signalling through `/api/rtc/rooms` (see
server/rtc.ts): codes of 6 letters, 15 minutes, one device per code, the
owner's own account only unless shared with "anyone".

Phase 4 engine -> page additions: `pads` {native} when the engine's own
controllers change, `menu` (a controller hotkey asked for the menu), `ff`
{on}, `rumble` {port, strong, weak} for the page's controllers, `slots`
{slots: [{slot, saved, thumb (PNG, base64, 200 px wide)}]}; `status` adds
pads, rewind {available, on, seconds, megabytes}, runahead {max, frames},
audioTargetMs, stateBytes, stateMs.

The game pauses while no page is connected; the engine exits (after saving
the battery save) when the page quits or after 2 minutes without a page,
and writes the battery save every 30 s when it changed.

## 5. Subsystems (the brief's seven, mapped)

1. **Loader and switchboard** (`loader.rs`, `env.rs`, `options.rs`): all
   `retro_*` symbols bound and checked for API version 1; environment
   commands handled: pixel format, geometry/AV info, system/save/core-assets
   directories (SaveState folders), core options v0/v1/v2 (+ update display
   callback), variables, log interface, perf interface, message, shutdown,
   rumble, input descriptors, controller info, memory maps, disk control
   (ext), VFS (v3), HW render (GL core / GLES; Vulkan cores fall back to
   their GL path), frame-time callback, audio callback, throttle state,
   language, username, fastforwarding override, savestate context. Unknown
   commands return false and are logged once.
2. **Video** (`video.rs`, `hw_render.rs`, page `EnginePlayer.jsx`): software
   frames (0RGB1555, RGB565, XRGB8888) converted with SIMD to RGBA8; HW cores
   get a hidden OpenGL 3.3+ core context with an FBO (`get_current_framebuffer`,
   `get_proc_address`), read back through a PBO ring without stalling, then
   encoded. Four shader presets in the page.
3. **Audio** (`audio.rs`): lock-free SPSC ring; sinc resampler from the
   core's rate to 48 kHz; dynamic rate control
   `R = R_base * (1 + d_max * (C_target - C_current) / C_target)` with
   d_max = 0.005, fed by the page's buffer fill.
4. **VFS and BIOS** (`vfs.rs`, `bios.rs`): VFS v3 serves local files and
   `http(s)://` game addresses with range requests and a disk block cache;
   cores without VFS support get the existing full download first. Required
   BIOS files (the host's `REQUIRED_BIOS` list) checked by MD5 and fetched
   from the host before `retro_load_game`.
5. **Input** (`input.rs`): `gilrs` with the SDL controller database (Xbox,
   PlayStation, Switch, 8BitDo...), per-console layouts (Nintendo A/B
   positions, N64 C-buttons on the right stick), chords: Guide+RB save,
   Guide+LB load, Guide+LT rewind (hold), Guide+RT fast-forward, Guide+Start
   pause overlay.
6. **SaveState extras** (`state.rs`): atomic save states with a thumbnail
   (PNG/WebP of the last frame) and SHA-256, uploaded as versions to the
   host (`/api/emulator/savestates`, and SRAM through `/api/savefile`, which
   the browser player and PS Vita app already use); rewind as an XOR-delta +
   zstd ring of states every N frames within a RAM budget; run-ahead of
   1-2 frames for cores that can serialize.
7. **Crash isolation**: one process per game (2.1), a watchdog in the
   launcher, and the page told why a session ended.

## 6. Phases

| Phase | Delivers | Proven by |
|---|---|---|
| 1 | This spec | Owner approval |
| 2 | `libretro-sys`, loader, switchboard, options, VFS, BIOS/dirs, headless runner | Loads real cores from `C:\RetroArch-Win64\cores` with real games; 120 frames; frame 120 saved as PNG; serialize -> run -> unserialize gives identical game memory and frames (results in 9) |
| 3 | WebSocket stream, raw video (encoded video moved to 6), HW render context, DRC audio, `EnginePlayer.jsx` with shaders | A game plays inside SaveState in the browser at a steady 60 fps with no audio crackle; HW core (dolphin) shows its picture (results in 10) |
| 4 | Native controllers, mappings, chords, rewind, fast-forward, run-ahead | Controller works with no setup; rewind 60 s; run-ahead measured |
| 5 | Saves/states/thumbnails to the host with versions, pause overlay, launcher switched to the engine (RetroArch kept only as fallback and for netplay) | Play from Games opens inside SaveState; RetroArch not installed or needed (results in 12) |
| 6 | Capture bridge for RPCS3/Switch/Wii U/Xbox (and every standalone emulator); WebRTC for other devices | PS3 game plays inside SaveState (results in 13) |

## 7. Honest limits

- Latency: the raw-frame path adds well under a frame; a captured emulator
  adds about one frame (the capture); another device over WebRTC adds the
  network plus Chrome's encoder and the other device's decoder, comparable
  to Moonlight on a LAN.
- Not every core supports VFS streaming or serialization (needed for rewind
  and run-ahead); those features turn off per core with a reason shown.
- PS2 (pcsx2 core) and GameCube (dolphin core) are heavy and render through
  OpenGL; they are the hardest part of Phase 3.
- Libretro cores are mostly GPL; SaveState loads them as separate DLLs. Giving
  cores to other people's PCs (the launcher already copies them from this
  host) should come with their licence files and source links.

- Cores that only offer Vulkan or Direct3D get no context (the engine
  provides OpenGL); they are refused with that reason, and remembered.
- A PC with browser hardware acceleration turned off draws the page's WebGL
  on the CPU; GPU-heavy cores then slow down (measured in 10).
- What follows the person to other PCs is a core's battery save (libretro
  SRAM) and its save states up to 48 MB. Saves some cores keep in their own
  folders (GameCube memory cards in Dolphin's User folder, PCSX2/PPSSPP
  memory cards) stay on the PC they were made on; they are carried over from
  RetroArch once. GameCube save states (about 90 MB) also stay on the PC.
- RetroArch is no longer installed for engine games. It remains in use where
  it is already installed for netplay and as the fallback when the engine
  can't start a game.
- Captured emulators (Phase 6): their sound plays on the PC itself, not
  through the page, so a friend on another device sees a captured game but
  doesn't hear it (cores' sound does go along). Saving and loading use the
  emulator's own keys or the game's saves; SaveState's slots, rewind,
  run-ahead and fast-forward are cores-only; the menu doesn't pause a
  captured emulator. On Windows 10, Windows draws a yellow border around a
  captured window (it is off the screen, so nobody sees it); Windows 11
  lets the engine turn it off. Virtual controllers need the ViGEmBus driver
  (the person's own controllers work with the emulator directly without it).
  Switch games need the person's own keys and firmware in Ryujinx.
- Another device: there is no relay (TURN) server, so the two devices must be
  able to reach each other directly: the same network always works; across
  the internet it depends on both routers. A code lets one device in at a
  time.

## 8. Checklist

- [x] Phase 1: reconnaissance, decisions, layout, protocol, plan
- [x] Prerequisite: a working Rust toolchain (GNU toolchain instead of the Build Tools, see 1)
- [x] Phase 2: core host and headless runner; results in 9 (approved 2026-10-19)
- [x] Phase 3: games play inside the SaveState page; results in 10 (approved 2026-10-19)
- [x] Phase 4: controllers, hotkeys, rewind, run-ahead; results in 11 (approved 2026-10-19)
- [x] Phase 5: the engine stands alone, saves follow the person; results in 12 (approved 2026-10-19)
- [x] Phase 6: capture bridge (PS3 plays inside SaveState) and other devices over WebRTC; results in 13 (awaiting approval)

## 9. Phase 2 results (2026-10-19)

`savestate-engine selftest` loads a core and a game, runs N frames, writes
frame N to a PNG, then checks save states: save S0, run 60 frames, save;
restore S0, run the same 60 frames, save; and once more. It passes when both
restores work, every replayed picture equals the original, and the game's
RAM after each replay is byte-identical to the original's (the whole state
must match where a core doesn't expose its RAM). A core that logs an error
or can't save states fails. Unit tests: 7 passed (ABI struct sizes, printf
log formatting, pixel conversion, options, VFS local files and URL forms).

| Test | Core | Content | Result |
|---|---|---|---|
| NES | FCEUmm | 240p Test Suite (open-source homebrew) | pass; 4,300 fps headless; state 21,976 B; RAM, whole state, pictures and sound identical after replay |
| Game Boy | mGBA | 144p Test Suite (open-source homebrew) | pass; 4,300-7,000 fps; RAM, whole state and pictures identical |
| GBA | mGBA | Pokemon Fire Red (host library) | pass; 1,800 fps; RAM, whole state, pictures and sound identical |
| Neo Geo | FinalBurn Neo | Metal Slug 2 + neogeo.zip | pass; 2,400 fps; RAM (64 KB) and pictures identical |
| GBA by URL | mGBA | Fire Red from the host (`/api/games/<id>/download/<name>`) | pass; downloaded to the cache (0.6-7.9 s; 183 s the very first time, while Google Drive fetched the file to the host) |
| Neo Geo streamed | FinalBurn Neo | Metal Slug X from the host through the VFS | pass; first run 28.9 MB fetched by range requests, playing in 1.9 s; second run 0 bytes fetched, 0.5-0.6 s |
| BIOS fetch | FinalBurn Neo | neogeo.zip missing locally | fetched from the host's BIOS route with the owner token, placed in system/ and beside the game |
| Missing BIOS | FinalBurn Neo | Metal Slug 2 without neogeo.zip | fails as it should: the core draws its own error screen, the engine reports the 4 missing ROM chips |
| GPU-only core | Dolphin | Crazy Taxi (GameCube) | refused: "dolphin-emu draws with the graphics card, which this build of SaveState Engine doesn't provide yet" (Phase 3 adds it) |

Determinism: for every core, two separate engine processes running the same
game produce bit-identical pictures and sound, so the host adds no
randomness. Sound right after a restore can differ in two cores (FinalBurn
Neo; mGBA in Game Boy mode) because they keep some sound-mixing state
outside their save state; pictures and game memory are exact, and the sound
is that core's own behaviour (RetroArch runs the same core code). The test
reports it (`identicalSoundFrames`, `soundSettlesAfterFrames`) without
failing on it.

Content not on this PC: the SNES, Mega Drive and PlayStation games were in
the library lost on 2026-09-20, so snes9x, genesis_plus_gx and pcsx_rearmed
load (`info`) but weren't run with a game. The NES and Game Boy tests use
the open-source 240p Test Suite from its official GitHub releases instead.

Fixed while testing (each would have broken real games):
- VFS seek returned the new position, as libretro.h says; RetroArch returns 0
  and cores' zip readers (minizip in FinalBurn Neo, MAME) treat anything else
  as an error. Now 0, matching RetroArch.
- Calls that libretro.h says answer true "even if data is NULL" (savestate
  context, variables, audio callback, disk control) answered false to that
  probe; FinalBurn Neo then assumed no savestate-context support. Fixed; the
  legacy SET_SERIALIZATION_QUIRKS_2 (87) is handled too.
- GET_GAME_INFO_EXT left `full_path` empty for games loaded into memory;
  libretro.h requires it and FCEUmm crashed reading it. Always set now.
- FinalBurn Neo finds a game's folder by splitting on `\` only, so streamed
  games are given to cores as `http:\\host\...`; the VFS turns that back into
  the URL. Cores probe for companion files next to the game, and the host's
  download route answers any name under a game with that game's file, so the
  VFS lets a core open only the game it is streaming; other URLs are "not
  found" and the core falls back to the system folder.
- Cores that ask for the VFS only inside `retro_load_game` are remembered in
  `cache/core-caps.json` (per core build) and stream from their second game
  on. Multi-file formats (cue, gdi, ccd, m3u, toc) are downloaded, not
  streamed.
- Cores that need a GPU context (Dolphin, LRPS2, PPSSPP, Citra, Flycast, and
  any core that asks for one and then fails) are refused before they can
  crash, until Phase 3 provides the context; a core that asks and then loads
  in software is remembered as able to.
- A core's error screen used to pass the PNG check; core errors now fail it.

Run it: `engine\build.cmd --release`, then
`engine\target\release\savestate-engine.exe selftest --core <core.dll> --game <file or URL> [--frames 120] [--png out.png] [--host <url> --token <jwt>]`.

## 10. Phase 3 results (2026-10-19)

Phase 2 refinements first: OpenGL contexts for GPU cores (hw.rs), so
Dolphin, PCSX2, PPSSPP, Flycast, Citra and Mupen64Plus-Next are no longer
refused; 0RGB1555 repacked to RGB565 on arrival; sound buffers reused (no
allocation per frame); the selftest takes `--system` and collects GPU
frames. Selftest regression: all earlier tests still pass, and Dolphin
(Crazy Taxi) now passes too: OpenGL 3.3 core on the RTX 3060 Ti, frame
600 correct (the Acclaim intro), game RAM (24 MB) and pictures identical
after replay. Release builds no longer carry debug info: 1.7 MB.
Unit tests: 12 passed (adds resampler rates and level, rate control,
pacing accuracy, WebSocket handshake, 1555 repacking and GPU flip).

Streaming (`serve`), measured with a client that plays the page's part
(drains sound at exactly 48 kHz, reports its fill, 60 Hz display):

| Core | Game | Pictures/s | Gap p50 / p99 | Sound | Underruns |
|---|---|---|---|---|---|
| mGBA | Fire Red | 59.8 | 16.7 / 17.5 ms | 48,071 Hz, buffer exactly on its 64 ms target | 0 |
| FinalBurn Neo | Metal Slug 2 | 59.2 | 16.9 / 17.9 ms | 48,139 Hz | 0 |
| Dolphin (GPU) | Crazy Taxi | ~60 while running | 16.7 / 25-28 ms (shader-compile hitches) | 46-48 kHz | only while its 92 MB state saves/loads |

In the browser (Chrome on savestate.co.za, Games > Play on this PC, launcher v11):
- Fire Red: the in-page player opened, 59.3 pictures/s, 47,954 Hz sound,
  keys reached the game (Start/A moved through the intro to the controls
  tutorial), the menu saved to a slot, Close ended the engine and the page
  showed "closed".
- Crazy Taxi (GameCube, GPU core): 55-58 pictures/s, 48.2-48.3 kHz sound,
  WebGL on ANGLE/D3D11 on the RTX 3060 Ti, save to slot 4 (92 MB state)
  confirmed, Close ended the engine.
- With Chrome forced onto its CPU renderer (SwiftShader) the GameCube run
  fell to 7-22 pictures/s: SwiftShader and Dolphin compete for the CPU.
  Real browsers draw WebGL on the GPU; noted as a limit for PCs where
  hardware acceleration is turned off.
- The launcher fetched engine 0.3.0 from the host on first use, checked its
  SHA-256, and started Fire Red in 1.4 s.

Fixed while testing:
- `ready` held the host lock while asking the core a question, and mGBA logs
  from inside that call: a deadlock. Locks are never held across core calls.
- Dolphin crashes if asked its save-state size before its first frame: the
  engine asks after a second of play.
- Dolphin declares 119.88 fps but runs at 60: the engine paces by the rate
  its sound implies (two agreeing one-second windows after a 3-second
  settle), plus audio sync and a flood guard for the boot.
- After quitting, Dolphin's leftover threads blocked the process exit
  (thread detach under the loader lock): once the game is closed and saved
  the engine keeps the core mapped and ends its process directly.
- The Games library under the player saw Enter and started the focused game
  again: the player now takes keys first (capture phase) and the app's
  controller navigation stands down while a game is open.
- A last animation frame could run after the player closed: fixed.
- If the engine can't close within 5 s, the page has the launcher stop it.

How it reaches people: the page asks for the engine on every Play of a
RetroArch-system game (unless "Open games in RetroArch instead" was
chosen). Launchers before v11 ignore the request and open RetroArch as
before; v11 fetches the engine from this host and falls back to RetroArch
when the engine can't run a game. Standalone emulators (PCSX2, RPCS3,
Ryujinx...) are unchanged until Phase 6's capture bridge.

Publishing a new engine: `engine\build.cmd --release`, then
`node scripts/publish-engine.mjs`; launchers pick it up within 10 minutes.

## 11. Phase 3 refinements and Phase 4 results (2026-10-19)

Phase 3 refinements:
- Sound latency adapts: the page's target buffer starts at 64 ms, comes
  down 8 ms after every 20 s without a gap (to 32 ms) and goes up 16 ms after
  a gap (to 128 ms); the worklet's restart threshold follows it.
- Save slots show a picture (200 px) and when they were saved.
- Fast-forward has a speed: 2x, 4x (default) or as fast as it goes
  (measured 238-240 fps at 4x for a 60 fps game).
- "Controller connected/disconnected" notices; the stats overlay adds
  run-ahead, the sound target and rewind seconds.
- Measuring a core's save states no longer saves three 92 MB Dolphin states
  in a row (a visible hitch): sizes over the rewind limit are measured once.

Phase 4:
- Controllers read by the engine (input.rs): XInput loaded at run time
  (xinput1_4, 1_3, 9_1_0) with the Guide button through ordinal 100; polled
  every frame on the emulation thread (empty slots once a second: asking an
  empty slot is slow); radial dead zones, triggers as analog L2/R2, rumble to
  the controller. They take the first ports; the page's controllers follow.
  Tested with a virtual Xbox 360 controller (ViGEmBus): the engine saw it in
  a frame, its d-pad moved the game with no page input at all.
- Button layout per person: by position (RetroArch's default: the bottom
  button is the console's bottom button) or by label, for the engine's and
  the page's controllers.
- Keyboard remapping in the player (Keyboard keys: pick a button, press a
  key; stored in the browser), plus F2 save, F4 load, hold Tab fast-forward,
  hold ` rewind, Esc menu.
- Hotkeys: Guide or Back with RB save, LB load, Start menu, RT fast-forward
  (held), LT rewind (held); Guide tapped alone opens the menu. Back alone
  stays Select for the game; only a combination is kept from it. Back exists
  because Windows often keeps Guide for Xbox Game Bar: with the virtual
  controller, reads of Guide dropped out and one update after it never
  arrived, so Guide releases are also debounced (3 reads). With Back the
  virtual controller's save, menu and fast-forward each fired exactly once.
- Rewind (rewind.rs): every frame for states up to 1 MB (every 2 frames to
  4 MB, every 4 to 32 MB; bigger states, like Dolphin's 92 MB, have no
  rewind), 256 MB budget, speeding up while held (1x, then 2x after a
  second, then 4x). Measured with `selftest`, 300 steps back each checked
  against the game's RAM at that moment:

  | Core | 10 s of play | Fits in 256 MB | Steps back matching RAM | Capture cost |
  |---|---|---|---|---|
  | FCEUmm (NES) | 0.1 MB | hours | 300 / 300 | 0.01 ms |
  | mGBA (Game Boy) | 0.7 MB | ~59 min | 300 / 300 | 0.26 ms |
  | mGBA (GBA, Fire Red) | 2.4 MB | ~18 min | 300 / 300 | 0.69 ms |
  | FinalBurn Neo (Metal Slug 2) | 2.1 MB | ~20 min | 300 / 300 | 0.17 ms |

  In the browser, holding ` showed "Rewinding" and played earlier pictures
  backwards; with the virtual controller, Back+LT replayed 68 earlier
  pictures in reverse order.
- Run-ahead (Session::run_frame_ahead): the real frame runs with sound and
  no picture, the state is saved, the next frames run hidden (the last one
  shows its picture), the state is restored; GET_AUDIO_VIDEO_ENABLE and the
  savestate context tell the core. Offered when the core's frames plus a
  save and a restore fit in 70 % of a frame. Measured with `selftest`
  (frames from holding a button to the picture changing, from one moment,
  once untouched and once with the button):

  | Game | Without | Run-ahead 1 | Run-ahead 2 | Cost per frame (0 / 1 / 2) |
  |---|---|---|---|---|
  | NES 240p suite (Right, A) | 3 | 2 | 1 | 0.45 / 0.70 / 0.95 ms |
  | Game Boy 144p suite (Right, A) | 2 | 1 | 1 | 0.15 / 0.54 / 0.65 ms |
  | Fire Red (Start) | 2 | 1 | 1 | 0.71 / 2.13 / 2.82 ms |

  Each frame ahead removes one frame of the game's own lag until the next
  frame is reached. In the browser, choosing "1 frame ahead" in the menu set
  it (status showed run-ahead 1).
- Browser test (Chrome on the GPU, launcher v11, engine 0.4.0): the menu
  showed the slot pictures, run-ahead switched on, rewind ran, Start was
  remapped to P and stored, F2 saved to the chosen slot, Close ended the
  engine; Crazy Taxi still plays at 59.7 pictures/s with 47.6 kHz sound.
- Unit tests: 18 passed (adds controller mapping by position and label,
  stick dead zones, Guide and Back hotkeys including a Guide dropout, rewind
  exactness and budget, states that change size).

## 12. Phase 4 refinements and Phase 5 results (2026-10-19)

Phase 4 refinements:
- Run-ahead on a second instance (see 2.5). Measured with `selftest`, from
  the same moment and the same 20 warm-up frames for every branch, comparing
  the sound with run-ahead to the sound without it:

  | Core | Saving alone changes its sound | Exact sound with run-ahead, one instance / two |
  |---|---|---|
  | FCEUmm (NES) | no | yes / yes |
  | mGBA (GBA, Fire Red) | no | no / **yes** |
  | mGBA (Game Boy) | yes | no / partly (run-ahead 2 exact) |
  | FinalBurn Neo (Metal Slug 2) | yes | no / no |

  Where saving a state by itself changes a core's sound (the core flushes its
  sound when it saves), no frontend can keep it bit-exact; RetroArch has the
  same limit. Input lag removed is unchanged (each frame ahead, one frame).
  Marking the run-ahead save as a "fast save state" (bit 4) made mGBA's Game
  Boy sound worse, so it isn't set.
- The menu by controller: the d-pad (or stick) moves to the nearest button
  in that direction, A chooses, B or Start goes back; the engine forwards its
  own controllers' presses while paused. Guide or Back with d-pad left/right
  changes the save slot. Tested with a virtual Xbox controller in Chrome:
  Back+Start opened the menu, two d-pad presses moved the focus, B closed
  it, Back+Right changed to slot 2.

Phase 5:
- The engine stands alone. Launcher v12 runs RetroArch-system games (and
  GameCube/Wii even with standalone Dolphin installed) in the engine with its
  own folders: engine/cores (copied from RetroArch when present, otherwise
  the host's mirror or libretro's buildbot), engine/system (a core's support
  files such as Dolphin's Sys folder, the person's BIOS files from Set up
  games, RetroArch's when present), engine/saves and engine/states. On first
  use a game's battery save and a core's save folder (Dolphin's User folder
  with the GameCube memory cards and shader cache, FinalBurn Neo's, PCSX2's,
  PPSSPP's, Flycast's, Citra's) come over from RetroArch once, keeping their
  file times. RetroArch is not installed for engine games; it stays the
  fallback where installed, and for netplay. PS2 and PSP keep their
  standalone emulators when installed.
- Proof (a "fresh PC"): a second launcher with an empty client folder,
  RetroArch treated as absent (`NEXUS_NO_RETROARCH=1`, port 17374), pressed
  Play on Fire Red: it fetched the game, the engine and the mGBA core
  (94 s, mostly the 16 MB game through Google Drive), played at 60
  pictures/s, saved slot 3 to the host (version 1, with its picture and the
  PC's name) and sent the battery save up when the game closed.
- Saves follow the person (sync.rs, server/enginestates.ts):
  - battery saves through `/api/savefile` (the same saves the browser
    player and the PS Vita app use): before a game starts, the newer of this
    PC's copy and the host's is used (the one replaced kept as `.srm.bak`);
    after each battery save (every 30 s when changed, and on closing) it
    goes up in the background;
  - save states up to 48 MB go up after saving, LZ4-compressed with their
    picture; the host keeps the 5 newest versions of each slot in the
    database (so the PC and the NAS share them); loading uses the newer of
    the two copies; the menu marks slots on the account and lists earlier
    versions to load;
  - preferences through `/api/engine/prefs`.
  Proof: on this PC, after the "fresh PC" saved slot 3, the menu showed slot
  3 as on the account with its picture; loading it came from the host;
  saving again made version 2; "Earlier saves" listed versions 2 and 1 and
  version 1 loaded; choosing the CRT look reached the account.
- The old `/api/emulator/savestates` routes used the game id in a file path
  unchecked; it is now limited to safe characters.
- Unit tests: 19 passed (adds CRC-32 against zlib's). Selftest regression:
  all pass, including Dolphin.
- The pause overlay is the player's menu (Phase 3-4): it pauses the game,
  and holds the slots, rewind, run-ahead, looks, controls and closing.

## 13. Phase 5 refinements and Phase 6 results (2026-10-19)

Phase 5 refinements:
- Saves that don't make it to the account are kept and sent again every
  30 s (a host restart or a dropped connection no longer loses them); the
  page hears `synced` when they arrive.
- The 48 MB limit for the account applies after LZ4 compression, so states
  that compress under it go up (raw states up to 512 MB are kept on the PC).
- A slot can be deleted from the menu, here and on the account, after a
  confirmation that says which. Tested in Chrome: saved Fire Red to slot 4,
  it reached the account (version 1), "Delete slot 4" then "Yes, delete slot
  4 (here and on your account)" emptied it on this PC and on the host.
- When the account's battery save was newer and used, the page says which
  device it came from and that this PC's copy is kept as a backup
  (`/api/savefile` info now returns the device). Not exercised in a browser
  here: it needs a newer save from another device than the one on this PC,
  and making one would replace a real save.
- Run-ahead on a second instance and the menu by controller (see 12).

Phase 6, the capture bridge (`capture.rs`, `vigem.rs`, launcher v13):
- `savestate-engine capture` starts the emulator (full-screen flags removed),
  finds its game window among the process tree (the largest visible
  top-level window), moves it past the right edge of the screens, gives the
  focus back to the browser, and captures the window's client area with
  Windows Graphics Capture on the GPU (D3D11; frames wider than 1600 pixels
  halved there with a mip level). The picture goes out on the same socket
  as a core's (BGRA). It follows a new game window (emulators often replace
  their first one) and puts the window back on the screen if a parked
  window stops giving frames (some emulators stop drawing off-screen).
- The page's keyboard and controllers become virtual Xbox 360 controllers
  through the ViGEmBus driver (its IOCTLs directly; no SDK), one per player,
  plugged in on the first press; the state is sent again for 3 s after
  plugging in, because XInput misses the first reports. The person's own
  controllers keep working with the emulator directly.
- Close sends WM_CLOSE, waits 3 s, then ends the emulator's whole process
  tree (PCSX2 asks for confirmation on close); the launcher's stop does the
  same, before stopping the engine, so nothing is orphaned.
- **Proof, PS3:** in Chrome, Play on Uncharted: Drake's Fortune (RPCS3,
  through launcher v14) opened it inside the SaveState page in 9.6 s: the
  game's loading screen (the turning coin) at 960x540 (captured at
  1920x1080 and halved on the GPU), 51.6 pictures/s in the page; Enter on
  the keyboard reached RPCS3 as a virtual controller; Close ended RPCS3.
  Directly (without the page), 58.9 pictures/s with no dropped frames.
- PS2 (PCSX2, Ape Escape 2) in Chrome: 57.3 pictures/s in the page, the
  keyboard reached PCSX2 as a controller, Close ended it.
- Found on the way: the host swapped a Drive game for a local file with the
  same name, and every extracted PS3 game's file is EBOOT.BIN, so Uncharted
  resolved to another, half-copied folder (17 of 21 GB, no PARAM.SFO), and
  RPCS3 said "Invalid file or folder". The swap now also requires the
  game's folder to match for EBOOT.BIN/default.xex. The launcher had also
  fetched only the 9 MB EBOOT.BIN of a 21 GB game: launcher v14 lists the
  folder (`/api/games/:id/folder`) and fetches every file (shown as "being
  copied, n %", resumable), refuses a host copy without PARAM.SFO with that
  reason, and on the host's own PC (the owner) plays the library's folder
  where it is.

Phase 6, other devices (WebRTC, `EnginePlayer.jsx`, `RemotePlayer.jsx`,
`server/rtc.ts`):
- In a game's menu, "Play on my phone or tablet" (same account) or "Let a
  friend play" (anyone signed in) gives a code and a link. The PC's page
  sends its canvas (with the chosen look) at 60 frames/s, motion-tuned, up
  to 12 Mbit/s, and the game's sound; Chrome encodes it on the GPU, so no
  encoder of our own was needed. The other device's keyboard, controllers
  or on-screen buttons come back on a data channel as player 2 (or 1).
  Nothing of the game passes through the host.
- Tested with two Chromes (the "phone" at 844x390 with touch): the picture
  arrived 1.8-2.1 s after opening the link, at 58 frames/s; the phone's
  Start reached the engine as player 2; the PC showed "Also on another
  device"; stopping sharing told the phone at once ("The game on the PC
  stopped sharing"); closing ended the engine.

Phase 6, crash isolation:
- A watchdog in the socket thread (see 4). Tested by freezing the engine's
  emulation thread from outside during Fire Red: after 20 s the page said
  the game stopped responding; when the thread ran again the notice went;
  frozen again, Close ended the engine in 5.5 s.
- The regression found Dolphin's core can spin forever inside its own
  save-state code when states are saved and loaded every frame (2 of ~14
  selftests; sampled: a wait loop in dolphin_libretro.dll with every other
  thread idle). Play never does that with states this big (run-ahead is
  off over 16 MB, rewind over 32 MB); the selftest now follows the same rule.

Tests: unit tests 20 passed (adds the ViGEm report mapping). Selftest
regression: all pass (NES, Game Boy, GBA, Neo Geo local and streamed,
GameCube; the Neo Geo game without its BIOS refused with the reason).

## 14. Phase 7 plan: every console inside SaveState, no other emulator apps (2026-10-25)

The owner asked (2026-10-25) to build all emulators into the app so that no
other emulator is needed. Where things stand:

| Device | Today | Gap |
|---|---|---|
| Windows PC | The engine runs libretro cores inside the page; PS2 and PSP also go through it (with the standalone emulator as fallback); PS3, Switch, Wii U and Xbox run in their standalone emulators, installed by the launcher and captured into the page (Phase 6) | Those four have no libretro core, so their emulators stay separate programs, installed and driven by SaveState |
| Linux PC | No engine (Windows only); standalone emulators from Flathub or official AppImages | The engine, built for Linux |
| Android phone or tablet | Retro consoles in the browser player; PSP, PS2, GameCube, Wii, 3DS, Dreamcast and Saturn need separate apps (PPSSPP, NetherSX2, Dolphin, Azahar, Flycast...) | The engine inside the Android app, with cores for every console |
| Browser anywhere | EmulatorJS for the retro consoles | (stays as is) |

The Android gap is the one the owner hits. The libretro buildbot publishes
arm64 Android builds of the cores needed (checked 2026-10-25): ppsspp,
dolphin, armsx2 (PS2), citra (3DS), cemu (Wii U), flycast, yabasanshiro,
swanstation, pcsx_rearmed, parallel_n64, melonds/melondsds, mgba, gambatte,
snes9x, bsnes, mesen, nestopia, genesis_plus_gx, picodrive, fbneo,
mame2003_plus, opera, stella, handy.

### 14.1 Design (Android)

The engine already splits into portable parts (loader, core callbacks,
options, VFS streaming, BIOS lookup, sessions, saves, rewind, timing:
about 6,000 lines with no Windows code) and Windows parts (hw.rs's WGL
context, the capture bridge, ViGEm, XInput). For Android:

- **Library:** the engine crate also builds as a `cdylib` for
  `aarch64-linux-android` (Android NDK, Rust target), with the Windows
  modules behind `cfg(windows)`. The APK carries it as `libsavestate_engine.so`.
- **Picture:** a full-screen `GameActivity` with a `SurfaceView`; the engine
  makes an EGL/GLES 3 context on it (hardware cores like Dolphin, PPSSPP,
  ARMSX2 and Citra draw straight to it) and presents software frames as a
  texture. No WebSocket frames on the phone: the picture never leaves the GPU.
- **Sound:** AAudio (Android 8.1+), fed by the engine's rate-control buffer.
- **Controls:** the touch overlay drawn natively over the picture (layouts
  per console, like the browser player's); Bluetooth and USB controllers
  through Android's InputDevice, mapped like the engine's native pads.
- **Cores:** downloaded on first use from the buildbot (official), kept in
  the app's own storage, loaded with dlopen (allowed for an app's private
  files). BIOS from the person's own BIOS folder, as on the PC.
- **Games:** the file already downloaded to Downloads/SaveState (PhonePlay's
  download), so Play becomes: download once, then the game opens inside
  SaveState. The external apps stay as a choice, no longer a requirement.
- **Saves:** the same save endpoints as the PC engine (Phase 5), so a game
  started on the PC carries on on the phone.

### 14.2 Steps

| Step | Delivers | Proven by |
|---|---|---|
| 7.1 | The engine's portable core builds for Android (NDK, target, `cfg(windows)` gates) and still builds and passes its tests on Windows | `cargo build --target aarch64-linux-android` succeeds; Windows unit tests and selftest regression pass |
| 7.2 | Android host: EGL/GLES on a SurfaceView, AAudio, JNI entry, `GameActivity`, core download | A Game Boy game and a PSP game play inside the SaveState app on a phone |
| 7.3 | Touch overlay per console, controllers, pause menu, save states, saves to the host | Play, save, close, reopen on the PC and carry on |
| 7.4 | Heavy cores: dolphin, armsx2, citra, cemu (performance settings per device) | GameCube and PS2 play on a mid-range phone |
| 7.5 | PhonePlay switches to "Play here" by default; the external apps become an option | The phone screenshots' flows (download, then play) work with no other app installed |
| 7.6 | The engine for Linux (x86_64): GLX/EGL context, ALSA/Pulse sound | A Linux laptop plays a GameCube game inside SaveState |

Each step stops for the owner's approval, as before. Honest limits: PS3,
Switch and Xbox have no Android cores; Wii U (cemu) and PS2 (armsx2) on
Android are new cores and heavy, so they may run slowly on some phones;
streaming from the PC (Phase 6, `?play=CODE`) covers what a phone can't run.

### 14.3 Step 7.1 results (2026-10-25)

- `engine\build-android.cmd` builds `libsavestate_engine.so` (ELF 64-bit,
  ARM64, shared library; 27 MB debug) with NDK 27.3.13750724 and Rust's
  `aarch64-linux-android` target on the GNU toolchain, as a cdylib, with no
  warnings. Android API 26 (AAudio's minimum).
- Windows-only modules (capture, hw, serve, vigem, ws) are behind
  `cfg(windows)`; `hw_none.rs` stands in for the GPU context until step 7.2
  (software cores run; a core asking for OpenGL is told it isn't available
  yet). XInput loading is Windows-only. Frame pacing on Linux/Android is a
  plain sleep plus the same 400 us spin. TLS: Windows keeps the system's
  (schannel); elsewhere ureq's rustls. On arm64 the engine reports NEON and
  ASIMD to cores (RETRO_SIMD_NEON, RETRO_SIMD_ASIMD added to libretro-sys).
- Windows is unchanged: unit tests 20 passed; selftest regression all pass
  (NES, Game Boy, GBA, GBA from the host, Neo Geo local and streamed twice,
  GameCube; the Neo Geo game without its BIOS refused with the reason).
  In the first regression run Dolphin hung in its own save-state code (the
  known spin, see 13); it passed the next five runs.
- Next: step 7.2 (EGL/GLES on a SurfaceView, AAudio, JNI, GameActivity,
  core download) after the owner's approval.

### 14.4 Step 7.2 results (2026-10-26)

Our own cores, built from official sources by `engine\cores\build-core.ps1`
(arm64-v8a, NDK 27.3, stripped; sources in G:\Projects\savestate-cores,
outputs in releases\cores\android with cores.json: source, commit, SHA-256):
gambatte (Game Boy/Color), mgba (GBA), snes9x (SNES), fceumm (NES) and
ppsspp (PSP, 21 MB, CMake/Ninja with -DLIBRETRO=ON) plus ppsspp-system.zip
(PPSSPP's flash0 fonts, atlases and compatibility lists from its own tree).

The Android player (engine/engine/src/android, hw_egl.rs): one GLES 3
context on the emulation thread; GPU cores draw into a framebuffer that is
blitted straight to the SurfaceView, software frames are uploaded to a
texture (RGB565, XRGB8888 via texture swizzle, RGBA8) and blitted the same
way; no shaders, no read-back. AAudio at the device rate with a resampler
whose ratio follows the buffer fill (+-0.5%). Paced at the core's own fps
with eglSwapInterval 0 (90/120 Hz screens don't speed games up). Battery
saves every 30 s and on exit; save/load state to a file. JNI:
com.savestate.nexus.NxEngine (start, surface, input, pause, save/load state,
stop, status). Log lines go to logcat (tag SaveState).

The app: GameActivity (full screen, sideways, on-screen controls per console
in TouchPad, Bluetooth/USB controllers, Back menu: resume, save, load, quit)
downloads a core from /api/engine/android/files on first use, checks its
SHA-256 against /api/engine/android/cores and keeps it; PPSSPP's system files
likewise. NxAndroid 5 adds `engine` and `play`; the page sends Game Boy,
GBA, SNES, NES and PSP games to the app's player (PhonePlay), with the
emulator apps as "instead". The APK carries the engine for arm64, armeabi-v7a
and x86_64 (Android refuses an APK with no native build for the device);
games play inside the app on arm64 phones. APK 1.0.72 (9.9 MB).

Verified here: the cores and the APK build; the library exports the JNI
calls and needs only Android system libraries; the host routes refuse
anonymous requests and odd file names, and a downloaded core matches its
checksum; the browser flows are unchanged. Not verified yet: playing on a
real phone (no ARM device or emulator on this PC). Next, after the owner's
phone test: 7.3 (saves to the host, menu polish), then 7.4 (dolphin, armsx2,
citra, cemu).
