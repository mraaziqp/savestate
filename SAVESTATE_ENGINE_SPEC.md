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

| Path | Used for | How |
|---|---|---|
| **Raw frames** | 2D cores (frames up to ~640x480) | Core framebuffer, converted to RGBA8 or kept RGB565, sent as binary frames; the page uploads them to a WebGL2 texture. ~70 MB/s at worst on loopback; no compression, no quality loss, < 1 frame of delay. |
| **Encoded video** | 3D / upscaled cores (PS2, GameCube, N64...) and captured windows | GPU frame read back (PBO) or captured, encoded with the hardware H.264/HEVC encoder through Media Foundation (NVENC here), low-latency, no B-frames; the page decodes with **WebCodecs** `VideoDecoder` straight to WebGL. ~1-2 frames of delay. |
| **Audio** | everything | 16-bit stereo PCM at 48 kHz over the same socket into an `AudioWorklet` ring buffer. |
| **Input** | everything | Controllers read natively by the engine (XInput + SDL database through `gilrs`), so input never waits on the browser; keyboard and touch from the page as a fallback. |

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

Efficiency:
1. **No wasted frames:** duplicate frames (`GET_CAN_DUPE`, NULL frame) are
   never sent; RGB565 cores stay 16-bit on the wire and are expanded by the
   page's shader (half the bandwidth of RGBA).
2. **One copy less:** `GET_CURRENT_SOFTWARE_FRAMEBUFFER` hands software cores
   the engine's own frame buffer, so they draw straight into what is sent.
3. **Zero-copy GPU path:** HW-rendered cores render into an OpenGL texture
   shared with Direct3D 11 (`WGL_NV_DX_interop2`), which the hardware
   encoder reads directly: no CPU readback for PS2/GameCube/N64.
4. **Encoder tuned for play, not files:** low-latency NVENC through Media
   Foundation, no B-frames, gradual intra refresh (no keyframe spikes),
   one-frame VBV.
5. **Pre-warmed worker:** while a game runs, the launcher keeps one idle
   engine process started, so the next game skips process start-up.
6. **Precise pacing:** high-resolution waitable timers (no 15.6 ms Windows
   timer slop), the core paced to its own fps, audio rate control absorbing
   the difference.
7. **Small, fast rewind:** XOR against the previous state + zstd, within a
   fixed RAM budget (default 256 MB).

Power:
1. **Second-instance run-ahead:** a second copy of the core (the DLL copied to
   a temporary name, since cores keep global state) runs ahead, so run-ahead
   costs no audio glitches and works with cores whose serialize is slow.
2. **Disc streaming** (VFS v3 over the host's range requests with a block
   cache on disk): big discs start in seconds; the cache makes the second
   play local.
3. **Per-game profiles on the host:** shader, core options and button layout
   follow the person between PCs.
4. **Live stats for the overlay:** fps, frame time, audio drift, encoder
   delay, so problems are visible rather than guessed.
5. **Watch and later play together:** the same session stream can go to a
   second viewer (Phase 6 WebRTC), the foundation for netplay.
6. **Core options with curated defaults** per core (e.g. internal
   resolution for 3D cores scaled to the GPU), so no game needs tuning.

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
    src/main.rs                 `info` and `selftest` (Phase 2); WebSocket session in Phase 3
  Phase 3+ adds:
    src/hw_render.rs            SET_HW_RENDER: hidden window, OpenGL core context, FBO, PBO readback
    src/audio.rs                SPSC ring, dynamic rate control, resampler
    src/input.rs                gilrs/XInput polling, per-console mapping, hotkey chords
    src/state.rs                save-state slots, rewind ring, run-ahead
    src/stream.rs               raw-frame + encoded-video + audio + input protocol
    src/encode.rs               Media Foundation hardware H.264/HEVC encoder
web-src/app/
  EnginePlayer.jsx              the in-SaveState player for engine sessions (WebGL, WebCodecs, AudioWorklet, shaders, pause overlay)
  engine-shaders.js             the four curated presets (GLSL ES 3.0)
client-launcher.cjs             /engine/* routes: start, stop, status; RetroArch spawning removed in Phase 5
```

## 4. Engine <-> page protocol (WebSocket `ws://127.0.0.1:<port>/session/<id>?key=<one-time key>`)

The launcher starts the engine on a random free port with a one-time key
and returns both to the page (the key stops other local pages from attaching).

Engine -> page (binary messages, 1-byte type + header + payload):
- `V` raw frame: width, height, pitch, format (RGBA8 / RGB565), frame number, pixels
- `E` encoded frame: codec (avc1/hev1), key flag, timestamp, NAL data (+ `C` config record once)
- `A` audio: frame count, interleaved s16 stereo at 48 kHz
Engine -> page (JSON text):
- `ready` {system, core, fps, sampleRate, aspect, geometry}, `geometry` changes,
  `status` {fps, frameTime, audioFill, rewindSeconds}, `saved` {slot, thumb},
  `error` {message}, `exit` {code}

Page -> engine (JSON text):
- `input` {port, buttons, axes} (keyboard/touch fallback), `pause`, `resume`,
  `reset`, `save` {slot}, `load` {slot}, `rewind` {on}, `ff` {on},
  `runahead` {frames 0-2}, `shader` (page-only), `audioFill` {ms} (rate control),
  `disk` {index}, `option` {key, value}, `quit`

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
| 3 | WebSocket stream, raw + encoded video, HW render context, DRC audio, `EnginePlayer.jsx` with shaders | A game plays inside SaveState in the browser at a steady 60 fps with no audio crackle; HW core (mupen64plus_next / dolphin) shows its picture |
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

## 8. Checklist

- [x] Phase 1: reconnaissance, decisions, layout, protocol, plan
- [x] Prerequisite: a working Rust toolchain (GNU toolchain instead of the Build Tools, see 1)
- [x] Phase 2: core host and headless runner; results in 9 (awaiting approval)
- [ ] Phase 3
- [ ] Phase 4
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
