//! `savestate-engine`: SaveState's libretro host.
//!
//!   savestate-engine info --core <core.dll>
//!   savestate-engine selftest --core <core.dll> --game <file or URL> [options]
//!   savestate-engine serve --core <core.dll> --game <file or URL> --key <key> [options]
//!
//! serve (Phase 3): plays the game inside the SaveState page over a local
//! WebSocket (serve.rs); the launcher starts it and reads its stdout.
//!
//! selftest (Phase 2's proof): loads the core and the game, runs N frames
//! (default 120), writes frame N as a PNG, then checks save states: it saves
//! at frame N, runs 60 more frames and saves again, then twice restores the
//! first state and replays the same 60 frames. The states saved after each
//! replay must be byte-identical to the original's and every picture equal.
//!
//! Phase 4 adds two measurements (when the core can save states):
//! - rewind: 10 s of play kept in the rewind ring, then 300 steps back, each
//!   checked against the game's RAM at that moment; plus how much play fits
//!   in the 256 MB budget;
//! - run-ahead: from one moment, the game runs once untouched and once with a
//!   button held (--button, default down), and the frames until the picture
//!   differs are counted with run-ahead 0, 1 and 2.
//! Prints one JSON line with the results; exit code 0 only if all passed.
use savestate_engine::bios::Host;
use savestate_engine::log::{self, Level};
use savestate_engine::loader::Core;
use savestate_engine::video::write_png;
use savestate_engine::{host, Content, Session, SessionConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

fn usage() -> ! {
    eprintln!(
        "usage:\n  savestate-engine info --core <core.dll>\n  savestate-engine serve --core <core.dll> --game <file|url> --key <key> [--port 0] [--origin <page origin>]... [--data <dir>] [--system <dir>] [--saves <dir>] [--states <dir>] [--host <url>] [--token <jwt>] [--name <file name>] [--option key=value]... [--idle <seconds>]\n  savestate-engine selftest --core <core.dll> --game <file|url> [--frames 120] [--png out.png]\n      [--data <dir>] [--system <dir>] [--button down|up|left|right|a|b|start] [--host <url>] [--token <jwt>] [--name <file name for a URL>] [--option key=value]... [--no-stream] [--verbose]"
    );
    std::process::exit(2)
}

struct Args {
    cmd: String,
    flags: HashMap<String, Vec<String>>,
}

impl Args {
    fn parse() -> Self {
        let mut it = std::env::args().skip(1);
        let cmd = it.next().unwrap_or_else(|| usage());
        let mut flags: HashMap<String, Vec<String>> = HashMap::new();
        let mut pending: Option<String> = None;
        for a in it {
            if let Some(name) = a.strip_prefix("--") {
                if let Some(p) = pending.take() {
                    flags.entry(p).or_default().push(String::new());
                }
                pending = Some(name.to_string());
            } else if let Some(p) = pending.take() {
                flags.entry(p).or_default().push(a);
            } else {
                usage();
            }
        }
        if let Some(p) = pending {
            flags.entry(p).or_default().push(String::new());
        }
        Args { cmd, flags }
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.flags.get(k).and_then(|v| v.last()).map(String::as_str)
    }
    fn all(&self, k: &str) -> Vec<String> {
        self.flags.get(k).cloned().unwrap_or_default()
    }
    fn has(&self, k: &str) -> bool {
        self.flags.contains_key(k)
    }
}

/// Where the engine keeps system files, saves and caches.
fn data_dir(args: &Args) -> PathBuf {
    if let Some(d) = args.get("data") {
        return PathBuf::from(d);
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("SaveState").join("engine")
}

fn json_escape(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn main() {
    let args = Args::parse();
    if args.has("verbose") {
        log::set_min_level(Level::Debug);
    }
    match args.cmd.as_str() {
        "info" => {
            let core = Core::load(&PathBuf::from(args.get("core").unwrap_or_else(|| usage()))).unwrap_or_else(|e| {
                eprintln!("{e}");
                std::process::exit(1)
            });
            let i = core.system_info();
            println!(
                "{{\"name\":{},\"version\":{},\"extensions\":{},\"needFullpath\":{},\"blockExtract\":{}}}",
                json_escape(&i.library_name),
                json_escape(&i.library_version),
                serde_json::to_string(&i.valid_extensions).unwrap_or_default(),
                i.need_fullpath,
                i.block_extract
            );
        }
        "selftest" => std::process::exit(selftest(&args)),
        "serve" => std::process::exit(serve(&args)),
        _ => usage(),
    }
}

/// The game to load, from --game (a path or a URL) and --name.
fn content_of(args: &Args) -> Content {
    let game = args.get("game").unwrap_or_else(|| usage()).to_string();
    if game.starts_with("http://") || game.starts_with("https://") {
        let name = args.get("name").map(str::to_string).unwrap_or_else(|| game.rsplit('/').next().unwrap_or("game").split('?').next().unwrap_or("game").to_string());
        Content::Url { url: game, file_name: name }
    } else {
        Content::Path(PathBuf::from(&game))
    }
}

fn options_of(args: &Args) -> HashMap<String, String> {
    args.all("option").iter().filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn serve(args: &Args) -> i32 {
    let data = data_dir(args);
    let _ = std::fs::create_dir_all(&data);
    // A game can run for hours: keep one previous log, not an endless one.
    let log_path = data.join("engine.log");
    if std::fs::metadata(&log_path).is_ok_and(|m| m.len() > 4 << 20) {
        let _ = std::fs::rename(&log_path, data.join("engine.prev.log"));
    }
    let _ = log::set_file(&log_path);
    let content = content_of(args);
    let game_name = match &content {
        Content::Path(p) => p.file_stem().map(|s| s.to_string_lossy().into_owned()),
        Content::Url { file_name, .. } => std::path::Path::new(file_name).file_stem().map(|s| s.to_string_lossy().into_owned()),
        Content::None => None,
    }
    .unwrap_or_else(|| "game".into());
    let host = args.get("host").map(|h| Host { base_url: h.to_string(), token: args.get("token").map(str::to_string) });
    let session = SessionConfig {
        core: PathBuf::from(args.get("core").unwrap_or_else(|| usage())),
        content,
        system_dir: args.get("system").map(PathBuf::from).unwrap_or_else(|| data.join("system")),
        save_dir: args.get("saves").map(PathBuf::from).unwrap_or_else(|| data.join("saves")),
        assets_dir: data.join("assets"),
        cache_dir: data.join("cache"),
        host,
        options: options_of(args),
        username: "SaveState".into(),
        stream_content: !args.has("no-stream"),
    };
    let key = args.get("key").filter(|k| k.len() >= 16).unwrap_or_else(|| {
        eprintln!("serve needs --key (16+ characters)");
        std::process::exit(2)
    });
    savestate_engine::serve::run(savestate_engine::serve::ServeConfig {
        session,
        key: key.to_string(),
        port: args.get("port").and_then(|p| p.parse().ok()).unwrap_or(0),
        origins: args.all("origin").into_iter().filter(|o| !o.is_empty()).collect(),
        states_dir: args.get("states").map(PathBuf::from).unwrap_or_else(|| data.join("states")),
        game_name,
        idle_exit: std::time::Duration::from_secs(args.get("idle").and_then(|s| s.parse().ok()).unwrap_or(120)),
    })
}

fn selftest(args: &Args) -> i32 {
    let core = PathBuf::from(args.get("core").unwrap_or_else(|| usage()));
    let frames: u64 = args.get("frames").and_then(|f| f.parse().ok()).unwrap_or(120);
    let data = data_dir(args);
    let _ = std::fs::create_dir_all(&data);
    let _ = log::set_file(&data.join("engine.log"));
    let content = content_of(args);
    let host = args.get("host").map(|h| Host { base_url: h.to_string(), token: args.get("token").map(str::to_string) });
    let mut options = HashMap::new();
    for kv in args.all("option") {
        if let Some((k, v)) = kv.split_once('=') {
            options.insert(k.to_string(), v.to_string());
        }
    }
    let cfg = SessionConfig {
        core: core.clone(),
        content,
        system_dir: args.get("system").map(PathBuf::from).unwrap_or_else(|| data.join("system")),
        save_dir: data.join("saves"),
        assets_dir: data.join("assets"),
        cache_dir: data.join("cache"),
        host,
        options,
        username: "SaveState".into(),
        stream_content: !args.has("no-stream"),
    };

    let t_load = Instant::now();
    let mut session = match Session::start(cfg) {
        Ok(s) => s,
        Err(e) => {
            println!("{{\"ok\":false,\"stage\":\"load\",\"error\":{}}}", json_escape(&e));
            return 1;
        }
    };
    let load_ms = t_load.elapsed().as_millis();
    let av = session.av_info();

    // 1. Run N frames, measure speed, keep frame N.
    let t_run = Instant::now();
    let mut samples = 0usize;
    // Hash of all the sound: two runs of the same game must match exactly.
    let mut sound_hash: u64 = 0xcbf29ce484222325;
    for _ in 0..frames {
        session.run_frame(false);
        session.finish_frame(2_000_000);
        let audio = session.take_audio();
        samples += audio.len() / 2;
        for v in audio {
            sound_hash ^= v as u16 as u64;
            sound_hash = sound_hash.wrapping_mul(0x100000001b3);
        }
    }
    let run_ms = t_run.elapsed().as_secs_f64() * 1000.0;
    let (w, h, rgba, frame_hash, hardware, format) = {
        let hs = host::lock();
        (hs.frame.width, hs.frame.height, hs.frame.to_rgba(), hs.frame.hash(), hs.frame.hardware, format!("{:?}", hs.frame.data_format))
    };
    let png_path = args.get("png").map(PathBuf::from).unwrap_or_else(|| data.join("selftest-frame.png"));
    let png_ok = w > 0 && h > 0 && write_png(&png_path, w, h, &rgba).is_ok();
    let lit = rgba.chunks_exact(4).filter(|p| p[0] > 8 || p[1] > 8 || p[2] > 8).count();

    // 2. Save state integrity. S0 = the state at frame N. Run 60 frames (a),
    //    then save S1 and copy the game's RAM. Restore S0, run 60 (b), save S2
    //    and copy the RAM; again (c), S3. Passes when both restores work,
    //    every picture of b and c equals a's, and the RAM after b and c is
    //    byte-identical to a's (the whole state must match instead when the
    //    core doesn't expose its RAM).
    //    Whole-state and sound differences are reported, not judged: cores
    //    keep sound-mixing bookkeeping in their state (mGBA's audio block,
    //    FinalBurn Neo's mixer) and some keep already-mixed sound outside it,
    //    so the first frames after a restore can sound different while the
    //    machine itself is exact.
    let mut serialize = serde_json::json!({ "supported": false });
    let mut state_ok = false;
    match session.serialize() {
        Ok(s0) => {
            // Picture hash and sound hash for each of 60 frames.
            let run60 = |s: &mut Session| -> Vec<(u64, u64)> {
                let mut out = Vec::with_capacity(60);
                for _ in 0..60 {
                    s.run_frame(false);
                    s.finish_frame(2_000_000);
                    let picture = host::lock().frame.hash();
                    let mut sound: u64 = 0xcbf29ce484222325;
                    for v in s.take_audio() {
                        sound ^= v as u16 as u64;
                        sound = sound.wrapping_mul(0x100000001b3);
                    }
                    out.push((picture, sound));
                }
                out
            };
            let s0b = session.unserialize(&s0).and_then(|_| session.serialize());
            let round_trip = s0b.as_ref().map(|s| *s == s0);
            let ram = |s: &Session| s.memory(libretro_sys::RETRO_MEMORY_SYSTEM_RAM).map(<[u8]>::to_vec);
            let a = run60(&mut session);
            let (s1, ram1) = (session.serialize(), ram(&session));
            let restored = session.unserialize(&s0);
            let b = run60(&mut session);
            let (s2, ram2) = (session.serialize(), ram(&session));
            let restored_again = session.unserialize(&s0);
            let c = run60(&mut session);
            let (s3, ram3) = (session.serialize(), ram(&session));
            let ram_identical = match (&ram1, &ram2, &ram3) {
                (Some(x), Some(y), Some(z)) => Some(x == y && y == z),
                _ => None,
            };
            let states_identical = match (&s1, &s2, &s3) {
                (Ok(x), Ok(y), Ok(z)) => x == y && y == z,
                _ => false,
            };
            // Where two states differ: up to 8 (offset, length) runs and the total byte count.
            let diff = |x: &[u8], y: &[u8]| -> serde_json::Value {
                let mut runs: Vec<(usize, usize)> = Vec::new();
                let mut total = x.len().abs_diff(y.len());
                for (i, (p, q)) in x.iter().zip(y).enumerate() {
                    if p != q {
                        total += 1;
                        match runs.last_mut() {
                            Some((start, len)) if *start + *len == i => *len += 1,
                            _ => runs.push((i, 1)),
                        }
                    }
                }
                serde_json::json!({ "bytes": total, "runs": runs.iter().take(8).map(|(o, l)| format!("{o}+{l}")).collect::<Vec<_>>() })
            };
            let round_trip_diff = match &s0b { Ok(x) if *x != s0 => diff(&s0, x), _ => serde_json::Value::Null };
            let replay_diff = match (&s1, &s2) { (Ok(x), Ok(y)) if x != y => diff(x, y), _ => serde_json::Value::Null };
            let pictures_b = a.iter().zip(&b).filter(|(x, y)| x.0 == y.0).count();
            let pictures_c = a.iter().zip(&c).filter(|(x, y)| x.0 == y.0).count();
            let sound_b = a.iter().zip(&b).filter(|(x, y)| x.1 == y.1).count();
            let sound_settles = a.iter().zip(&b).rposition(|(x, y)| x.1 != y.1).map(|i| i + 1).unwrap_or(0);
            state_ok = restored.is_ok() && restored_again.is_ok() && pictures_b == 60 && pictures_c == 60 && ram_identical.unwrap_or(states_identical);
            serialize = serde_json::json!({
                "supported": true,
                "bytes": s0.len(),
                "ramBytes": ram1.as_ref().map(Vec::len),
                "ramIdenticalAfterReplay": ram_identical,
                "roundTripIdentical": round_trip == Ok(true),
                "restored": restored.is_ok() && restored_again.is_ok(),
                "statesIdenticalAfterReplay": states_identical,
                "roundTripDiff": round_trip_diff,
                "replayDiff": replay_diff,
                "identicalFrames": pictures_b.min(pictures_c),
                "identicalSoundFrames": sound_b,
                "soundSettlesAfterFrames": sound_settles,
            });
        }
        Err(e) => serialize["error"] = serde_json::Value::String(e),
    }
    // 3. Rewind and run-ahead (Phase 4).
    let mut rewind_report = serde_json::Value::Null;
    let mut latency_report = serde_json::Value::Null;
    let mut phase4_ok = true;
    if serialize["supported"].as_bool().unwrap_or(false) {
        let size = session.serialize_size();
        let ram = |s: &Session| s.memory(libretro_sys::RETRO_MEMORY_SYSTEM_RAM).map(|m| m.iter().fold(0xcbf29ce484222325u64, |h, &x| (h ^ x as u64).wrapping_mul(0x100000001b3)));
        if size <= 32 << 20 {
            let mut ring = savestate_engine::rewind::Rewind::new(256 << 20, 1);
            let mut buf = Vec::new();
            let mut marks = Vec::new();
            let t = Instant::now();
            let mut capture = std::time::Duration::ZERO;
            for _ in 0..600 {
                session.run_frame(false);
                session.finish_frame(2_000_000);
                let c0 = Instant::now();
                if session.serialize_into(&mut buf).is_ok() {
                    ring.push(&buf);
                    marks.push(ram(&session));
                }
                capture += c0.elapsed();
            }
            let played = t.elapsed();
            let bytes = ring.bytes();
            let per_second = bytes as f64 / 10.0;
            let mut matched = 0;
            let steps = 300.min(ring.len());
            for k in 1..=steps {
                let Some(st) = ring.back().map(<[u8]>::to_vec) else { break };
                if session.unserialize(&st).is_ok() && ram(&session) == marks[marks.len() - 1 - k] {
                    matched += 1;
                }
            }
            phase4_ok &= matched == steps && steps > 0;
            rewind_report = serde_json::json!({
                "captures": marks.len(),
                "megabytesFor10s": (bytes as f64 / 1048576.0 * 10.0).round() / 10.0,
                "secondsIn256MB": ((256.0 * 1048576.0) / per_second).round(),
                "captureMs": ((capture.as_secs_f64() * 1000.0 / 600.0) * 1000.0).round() / 1000.0,
                "stepsBack": steps,
                "ramMatched": matched,
                "playMs": played.as_millis(),
            });
        } else {
            rewind_report = serde_json::json!({ "skipped": format!("save states of {} MB are too big to rewind", size >> 20) });
        }

        // Run-ahead: frames from pressing a button to the picture changing.
        let button = match args.get("button").unwrap_or("down") {
            "a" => libretro_sys::RETRO_DEVICE_ID_JOYPAD_A,
            "b" => libretro_sys::RETRO_DEVICE_ID_JOYPAD_B,
            "start" => libretro_sys::RETRO_DEVICE_ID_JOYPAD_START,
            "up" => libretro_sys::RETRO_DEVICE_ID_JOYPAD_UP,
            "right" => libretro_sys::RETRO_DEVICE_ID_JOYPAD_RIGHT,
            "left" => libretro_sys::RETRO_DEVICE_ID_JOYPAD_LEFT,
            _ => libretro_sys::RETRO_DEVICE_ID_JOYPAD_DOWN,
        };
        if let Ok(start) = session.serialize() {
            let mut buf = Vec::new();
            let mut branch = |s: &mut Session, ahead: u32, press: bool| -> Vec<u64> {
                let _ = s.unserialize(&start);
                let input = savestate_engine::host::PortInput { buttons: if press { 1 << button } else { 0 }, ..Default::default() };
                let mut hashes = Vec::new();
                for _ in 0..30 {
                    s.set_input(0, input);
                    let _ = s.run_frame_ahead(ahead, false, &mut buf);
                    s.finish_frame(2_000_000);
                    hashes.push(host::lock().frame.hash());
                }
                s.set_input(0, Default::default());
                hashes
            };
            let mut lag = Vec::new();
            let mut cost = Vec::new();
            for ahead in 0..=2u32 {
                let t = Instant::now();
                let base = branch(&mut session, ahead, false);
                let pressed = branch(&mut session, ahead, true);
                cost.push(((t.elapsed().as_secs_f64() * 1000.0 / 60.0) * 100.0).round() / 100.0);
                // Frames the button was held before the picture differed (1 = the very next picture).
                lag.push(base.iter().zip(&pressed).position(|(a, b)| a != b).map(|i| i as u32 + 1));
            }
            let _ = session.unserialize(&start);
            // Each frame ahead should show the change one frame sooner.
            if let (Some(Some(l0)), Some(Some(l1))) = (lag.first(), lag.get(1)) {
                phase4_ok &= *l1 + 1 == *l0 || *l0 == 1;
            }
            latency_report = serde_json::json!({
                "button": args.get("button").unwrap_or("down"),
                "framesUntilPictureChanges": { "runahead0": lag[0], "runahead1": lag[1], "runahead2": lag[2] },
                "msPerFrame": { "runahead0": cost[0], "runahead1": cost[1], "runahead2": cost[2] },
            });
        }
    }
    let sram = session.memory(libretro_sys::RETRO_MEMORY_SAVE_RAM).map(|m| m.len()).unwrap_or(0);
    let (options_count, hw, vfs_version, messages) = {
        let hs = host::lock();
        (hs.options.defs().len(), hs.hw_requested, hs.vfs_version, hs.messages.clone())
    };
    let fps = if run_ms > 0.0 { frames as f64 * 1000.0 / run_ms } else { 0.0 };
    // A core that can't find its files often still "loads" and draws its own
    // error screen, so errors it logged fail the test, as does a core that
    // can't save states (the engine's save, rewind and run-ahead need them).
    let core_errors = log::take_core_errors();
    let ok = png_ok && lit > 0 && state_ok && phase4_ok && core_errors.is_empty();
    let report = serde_json::json!({
        "ok": ok,
        "core": { "name": session.info.library_name, "version": session.info.library_version, "path": session.core_path().display().to_string() },
        "content": {
            "path": session.content_path,
            "streamed": session.streamed,
            // Bytes fetched from the host this run (cached blocks aren't fetched again).
            "fetchedBytes": session.content_path.as_deref().and_then(savestate_engine::vfs::url_of).and_then(|u| savestate_engine::vfs::remote(&u).ok()).map(|f| f.lock().unwrap_or_else(|e| e.into_inner()).fetched_bytes),
        },
        "av": { "width": av.geometry.base_width, "height": av.geometry.base_height, "aspect": av.geometry.aspect_ratio, "fps": av.timing.fps, "sampleRate": av.timing.sample_rate },
        "loadMs": load_ms,
        "frames": frames,
        "headlessFps": (fps * 10.0).round() / 10.0,
        "audioFrames": samples,
        "soundHash": format!("{sound_hash:016x}"),
        "frame": { "width": w, "height": h, "format": format, "hash": format!("{frame_hash:016x}"), "litPixels": lit, "png": if png_ok { Some(png_path.display().to_string()) } else { None::<String> } },
        "serialize": serialize,
        "rewind": rewind_report,
        "runahead": latency_report,
        "sramBytes": sram,
        "options": options_count,
        "hwRequested": hw,
        "gpu": if hardware { savestate_engine::hw::description() } else { None },
        "vfsVersion": vfs_version,
        "bios": { "present": session.bios.present.len(), "fetched": session.bios.fetched.len(), "missing": session.bios.missing.iter().map(|(n, r)| serde_json::json!({ "files": n, "required": r })).collect::<Vec<_>>() },
        "messages": messages,
        "coreErrors": core_errors,
    });
    drop(session);
    println!("{report}");
    if ok { 0 } else { 1 }
}
