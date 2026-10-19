//! `savestate-engine`: SaveState's libretro host.
//!
//!   savestate-engine info --core <core.dll>
//!   savestate-engine selftest --core <core.dll> --game <file or URL> [options]
//!
//! selftest (Phase 2's proof): loads the core and the game, runs N frames
//! (default 120), writes frame N as a PNG, then checks save states: it saves
//! at frame N, runs 60 more frames and saves again, then twice restores the
//! first state and replays the same 60 frames. The states saved after each
//! replay must be byte-identical to the original's and every picture equal.
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
        "usage:\n  savestate-engine info --core <core.dll>\n  savestate-engine selftest --core <core.dll> --game <file|url> [--frames 120] [--png out.png]\n      [--data <dir>] [--host <url>] [--token <jwt>] [--name <file name for a URL>] [--option key=value]... [--no-stream] [--verbose]"
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
        _ => usage(),
    }
}

fn selftest(args: &Args) -> i32 {
    let core = PathBuf::from(args.get("core").unwrap_or_else(|| usage()));
    let game = args.get("game").unwrap_or_else(|| usage()).to_string();
    let frames: u64 = args.get("frames").and_then(|f| f.parse().ok()).unwrap_or(120);
    let data = data_dir(args);
    let _ = std::fs::create_dir_all(&data);
    let _ = log::set_file(&data.join("engine.log"));
    let content = if game.starts_with("http://") || game.starts_with("https://") {
        let name = args.get("name").map(str::to_string).unwrap_or_else(|| game.rsplit('/').next().unwrap_or("game").split('?').next().unwrap_or("game").to_string());
        Content::Url { url: game.clone(), file_name: name }
    } else {
        Content::Path(PathBuf::from(&game))
    };
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
        system_dir: data.join("system"),
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
        (hs.frame.width, hs.frame.height, hs.frame.to_rgba(), hs.frame.hash(), hs.frame.hardware, format!("{:?}", hs.frame.format))
    };
    let png_path = args.get("png").map(PathBuf::from).unwrap_or_else(|| data.join("selftest-frame.png"));
    let png_ok = w > 0 && h > 0 && !hardware && write_png(&png_path, w, h, &rgba).is_ok();
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
    let ok = png_ok && lit > 0 && state_ok && core_errors.is_empty();
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
        "sramBytes": sram,
        "options": options_count,
        "hwRequested": hw,
        "vfsVersion": vfs_version,
        "bios": { "present": session.bios.present.len(), "fetched": session.bios.fetched.len(), "missing": session.bios.missing.iter().map(|(n, r)| serde_json::json!({ "files": n, "required": r })).collect::<Vec<_>>() },
        "messages": messages,
        "coreErrors": core_errors,
    });
    drop(session);
    println!("{report}");
    if ok { 0 } else { 1 }
}
