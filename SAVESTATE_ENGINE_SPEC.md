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
| **Encoded video** | moved to Phase 6 (other devices) | On the same PC the raw path already holds 60 fps for GPU cores, so the hardware encoder (Media Foundation/NVENC + WebCodecs) is built with WebRTC in Phase 6, where it is needed: to send the picture to phones, the Vita browser and other PCs. |
| **Audio** | everything | Resampled in the engine (windowed sinc) to 48 kHz stereo 16-bit, sent over the same socket into an `AudioWorklet` ring buffer that reports its fill for rate control. |
| **Input** | everything | Xbox-type controllers are read by the engine itself through XInput (loaded at run time; Guide through XInputGetStateEx), every frame on the emulation thread, with rumble back to the controller. Other controllers (DualSense, Switch Pro...) and the keyboard (remappable) come from the page (Gamepad API), on the ports after the engine's. `gilrs` was not used: its Windows backend pulls in crates this toolchain can't link (see 1). |

The page applies the **shader presets** in WebGL (raw integer scale, CRT
aperture grille, handheld LCD grid, smooth upscale), so they look the same
locally and, later, on other devices.

Later upgrades (not in Phases 2-5): **WebRTC** transport so phones, the Vita
browser and other PCs can play the engine's output (replacing Moonlight),
and an optional native desktop shell (WebView2 + DirectComposition) for a
zero-copy GPU path on this PC.

### 2.3 Emulators that are not libretro cores
RPCS3 (PS3), Ryujinx/Eden (Switch), Cemu (Wii U), xemu (Xbox) and Xenia (Xbox
360) have no usable libretro core. They get a **capture bridge** (Phase 6,
after this plan): the engine starts the emulator off to the side, captures
its window with Windows Graphics Capture, sends it through the encoded-video
path, and drives it through a ViGEm virtual controller, so these play inside
SaveState too. PS2 and GameCube/Wii move to their libretro cores (pcsx2,
dolphin) and stop needing their standalone windows.

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
4. **Encoder tuned for play** (Phase 6, with WebRTC; see 2.2).
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
1. **Run-ahead** (done in Phase 4, single instance, RetroArch's default):
   the hidden frames run in the same core between a save and a restore. The
   second-instance variant needs a second set of callbacks routed to a
   second host state (libretro callbacks carry no user pointer); it is left
   for when a core turns out to need it.
2. **Disc streaming** (done in Phase 2): VFS v3 over range requests with a
   block cache on disk.
3. **Per-game profiles on the host** (Phase 5); the page already remembers
   the look per console and the save slot.
4. **Live stats** (done): fps, time per frame, sound buffer, skipped
   pictures, in the player's Stats overlay.
5. **Watch and later play together** (Phase 6).
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
  Phase 6 adds:
    src/encode.rs               Media Foundation hardware encoder (with WebRTC)
web-src/app/
  EnginePlayer.jsx              the in-SaveState player (WebGL2 with the four looks, AudioWorklet, keyboard/gamepads, menu)
  PlayOverlay.jsx               opens EnginePlayer when the launcher answers with an engine session
  build.mjs                     patches: Play asks for the engine; the app's controller navigation pauses during a game
client-launcher.cjs             v11: fetches/updates the engine from the host (SHA-256), runs RetroArch-system
                                games in it on request, falls back to RetroArch; RetroArch spawning removed in Phase 5
server.ts                       /api/client-launcher/engine(/info): serves releases/engine (scripts/publish-engine.mjs)
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
| 5 | Saves/states/thumbnails to the host with versions, pause overlay, launcher switched to the engine, RetroArch spawning removed | Play from Games opens inside SaveState; RetroArch not installed or needed |
| 6 (after) | Capture bridge for RPCS3/Switch/Wii U/Xbox; WebRTC for other devices | PS3 game plays inside SaveState |

## 7. Honest limits

- Latency: raw-frame path adds well under a frame; the encoded path adds
  about 1-2 frames (NVENC low-latency + WebCodecs), comparable to Moonlight
  on a LAN.
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

## 8. Checklist

- [x] Phase 1: reconnaissance, decisions, layout, protocol, plan
- [x] Prerequisite: a working Rust toolchain (GNU toolchain instead of the Build Tools, see 1)
- [x] Phase 2: core host and headless runner; results in 9 (approved 2026-10-19)
- [x] Phase 3: games play inside the SaveState page; results in 10 (approved 2026-10-19)
- [x] Phase 4: controllers, hotkeys, rewind, run-ahead; results in 11 (awaiting approval)
- [ ] Phase 5
- [ ] Phase 6

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
