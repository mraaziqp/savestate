//! `savestate-engine serve`: one game, played inside the SaveState page.
//!
//! The launcher starts the engine with the core, the game and a one-time key.
//! The engine loads the game, prints `{"listening":port}` and then
//! `{"ready":{...}}` (or `{"error":"..."}`) on stdout, and waits for the page
//! to open `ws://127.0.0.1:<port>/session?key=<key>`.
//!
//! Threads:
//! - emulation: owns the core (and its OpenGL context); runs frames paced to
//!   the console's rate, resamples sound to 48 kHz under rate control, and
//!   hands pictures and sound to the outbox;
//! - writer: sends the outbox to the page. It always sends the newest
//!   picture: if the page falls behind, older pictures are dropped rather
//!   than queued, so the delay never builds up. Sound is never dropped;
//! - reader (one per connection): turns the page's messages into commands;
//! - main: accepts connections (one page at a time; a new one replaces the old).
//!
//! The game pauses while no page is connected and the engine exits (saving
//! the battery save) after `idle_exit` without one, or when the page quits.
//!
//! Wire format (engine -> page), binary:
//!   'V' fmt flags 0 | width u32 | height u32 | frame u64 | 0 u32 | pixels
//!       fmt 0 = RGB565, 1 = XRGB8888 (bytes B,G,R,X), 2 = RGBA8; flags bit 0 = rows bottom-up
//!   'A' 0 0 0 | frames u32 | interleaved stereo i16 at 48 kHz
//! and JSON text: ready, geometry, status, saved, loaded, error, exit.
//! Page -> engine, JSON text: {"t":"in","p":port,"b":buttons,"a":[lx,ly,rx,ry],"g":[l2,r2]},
//! pause, resume, reset, save {slot}, load {slot}, ff {on}, audio {fill, target},
//! option {key, value}, quit.
use crate::audio::{RateControl, Resampler, OUTPUT_RATE};
use crate::host::{self, PortInput};
use crate::timing::Pacer;
use crate::video::{write_png, PixelFormat};
use crate::ws;
use crate::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write;

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn TerminateProcess(process: *mut std::ffi::c_void, code: u32) -> i32;
}
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub struct ServeConfig {
    pub session: SessionConfig,
    /// The one-time key the page must present.
    pub key: String,
    /// 0 picks a free port.
    pub port: u16,
    /// Page origins allowed to connect (empty: any page that has the key).
    pub origins: Vec<String>,
    pub states_dir: PathBuf,
    /// File-name stem for save states.
    pub game_name: String,
    pub idle_exit: Duration,
}

enum Command {
    Input(usize, PortInput),
    Pause(bool),
    Reset,
    Save(u32),
    Load(u32),
    FastForward(bool),
    AudioFill(f64, Option<f64>),
    /// The page's display refresh rate: no point sending pictures faster.
    Display(f64),
    SetOption(String, String),
    Connected,
    Disconnected(u64),
    Quit,
}

#[derive(Default)]
struct Outbox {
    /// Header + pixels of the newest picture not sent yet.
    video: Vec<u8>,
    video_fresh: bool,
    audio: VecDeque<Vec<i16>>,
    text: VecDeque<String>,
    pongs: Vec<Vec<u8>>,
    /// The writing half of the current page's connection.
    stream: Option<TcpStream>,
    generation: u64,
    /// The `ready` message, sent first to every page that connects.
    hello: Option<String>,
}

struct Shared {
    out: Mutex<Outbox>,
    wake: Condvar,
    quit: AtomicBool,
    dropped: AtomicU64,
    /// Shortest gap between pictures sent, in microseconds (from the page's refresh rate).
    min_video_gap_us: AtomicU64,
}

impl Shared {
    fn out(&self) -> MutexGuard<'_, Outbox> {
        self.out.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn text(&self, v: Value) {
        self.out().text.push_back(v.to_string());
        self.wake.notify_one();
    }
}

fn say(line: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn run(cfg: ServeConfig) -> i32 {
    let listener = match TcpListener::bind(("127.0.0.1", cfg.port)) {
        Ok(l) => l,
        Err(e) => {
            say(json!({ "error": format!("can't listen on 127.0.0.1:{}: {e}", cfg.port) }));
            return 1;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    say(json!({ "listening": port }));

    let shared = Arc::new(Shared { out: Mutex::new(Outbox::default()), wake: Condvar::new(), quit: AtomicBool::new(false), dropped: AtomicU64::new(0), min_video_gap_us: AtomicU64::new(0) });
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<Value, String>>();

    let emu = {
        let shared = shared.clone();
        let (session_cfg, states_dir, game_name, idle_exit) = (cfg.session.clone(), cfg.states_dir.clone(), cfg.game_name.clone(), cfg.idle_exit);
        std::thread::Builder::new()
            .name("emulation".into())
            .stack_size(16 << 20)
            .spawn(move || emulation(session_cfg, states_dir, game_name, idle_exit, shared, cmd_rx, ready_tx))
            .expect("emulation thread")
    };
    match ready_rx.recv() {
        Ok(Ok(info)) => say(json!({ "ready": info })),
        Ok(Err(e)) => {
            say(json!({ "error": e }));
            crate::info!("engine done: {e}");
            unsafe { TerminateProcess(GetCurrentProcess(), 1) };
            let _ = emu;
            return 1;
        }
        Err(_) => {
            say(json!({ "error": "the engine stopped while loading the game" }));
            return 1;
        }
    }

    let writer = {
        let shared = shared.clone();
        let cmd_tx = cmd_tx.clone();
        std::thread::Builder::new().name("writer".into()).spawn(move || write_loop(shared, cmd_tx)).expect("writer thread")
    };

    let _ = listener.set_nonblocking(true);
    while !shared.quit.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                connect(stream, &cfg, &shared, &cmd_tx);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
    // The game is closed and saved (the emulation thread set `quit` after
    // that). Give the writer a moment to tell the page, then end the process
    // outright: some cores leave threads behind that block a normal exit
    // (thread and DLL detach run under the loader lock).
    shared.wake.notify_all();
    let until = Instant::now() + Duration::from_secs(2);
    while !writer.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(10));
    }
    crate::info!("engine done");
    let _ = std::io::stdout().flush();
    unsafe { TerminateProcess(GetCurrentProcess(), 0) };
    let _ = emu;
    0
}

fn same_key(a: &str, b: &str) -> bool {
    // Constant time for equal lengths.
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn connect(mut stream: TcpStream, cfg: &ServeConfig, shared: &Arc<Shared>, cmd_tx: &Sender<Command>) {
    let (req, key) = match ws::read_request(&mut stream) {
        Ok(r) => r,
        Err(_) => {
            ws::reject(&mut stream, "400 Bad Request");
            return;
        }
    };
    let given = req.path.split_once('?').map(|(_, q)| q).unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("key=")).unwrap_or("");
    if !req.path.starts_with("/session") || !same_key(given, &cfg.key) {
        ws::reject(&mut stream, "403 Forbidden");
        return;
    }
    if !cfg.origins.is_empty() && !req.origin.as_deref().is_some_and(|o| cfg.origins.iter().any(|a| a == o)) {
        ws::reject(&mut stream, "403 Forbidden");
        return;
    }
    if ws::accept(&mut stream, &key).is_err() {
        return;
    }
    let Ok(reader) = stream.try_clone() else { return };
    let generation = {
        let mut o = shared.out();
        if let Some(old) = o.stream.take() {
            let _ = old.shutdown(Shutdown::Both);
        }
        o.generation += 1;
        o.stream = Some(stream);
        o.audio.clear();
        o.text.clear();
        if let Some(h) = o.hello.clone() {
            o.text.push_back(h);
        }
        // The current picture at once, even while paused.
        o.video_fresh = !o.video.is_empty();
        o.generation
    };
    shared.wake.notify_one();
    let _ = cmd_tx.send(Command::Connected);
    let (shared, cmd_tx) = (shared.clone(), cmd_tx.clone());
    let _ = std::thread::Builder::new().name("reader".into()).spawn(move || read_loop(reader, generation, shared, cmd_tx));
}

fn read_loop(mut stream: TcpStream, generation: u64, shared: Arc<Shared>, cmd_tx: Sender<Command>) {
    loop {
        let msg = ws::read_message(&mut stream, |p| {
            shared.out().pongs.push(p.to_vec());
            shared.wake.notify_one();
        });
        match msg {
            Ok(ws::Message::Text(t)) => {
                if let Some(c) = parse_command(&t) {
                    if cmd_tx.send(c).is_err() {
                        return;
                    }
                }
            }
            Ok(ws::Message::Binary(_)) => {}
            Ok(ws::Message::Close) | Err(_) => {
                let _ = cmd_tx.send(Command::Disconnected(generation));
                let mut o = shared.out();
                if o.generation == generation {
                    if let Some(s) = o.stream.take() {
                        let _ = s.shutdown(Shutdown::Both);
                    }
                }
                return;
            }
        }
    }
}

fn parse_command(text: &str) -> Option<Command> {
    let v: Value = serde_json::from_str(text).ok()?;
    let n = |k: &str| v.get(k).and_then(Value::as_f64);
    Some(match v.get("t")?.as_str()? {
        "in" => {
            let port = n("p").unwrap_or(0.0) as usize;
            let a = |i: usize| v.get("a").and_then(|a| a.get(i)).and_then(Value::as_f64).unwrap_or(0.0).clamp(-32768.0, 32767.0) as i16;
            let g = |i: usize| v.get("g").and_then(|a| a.get(i)).and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 32767.0) as i16;
            Command::Input(port, PortInput { buttons: n("b").unwrap_or(0.0) as u16, sticks: [[a(0), a(1)], [a(2), a(3)]], triggers: [g(0), g(1)] })
        }
        "pause" => Command::Pause(true),
        "resume" => Command::Pause(false),
        "reset" => Command::Reset,
        "save" => Command::Save(n("slot").unwrap_or(0.0) as u32),
        "load" => Command::Load(n("slot").unwrap_or(0.0) as u32),
        "ff" => Command::FastForward(v.get("on").and_then(Value::as_bool).unwrap_or(false)),
        "audio" => Command::AudioFill(n("fill")?, n("target")),
        "display" => Command::Display(n("hz")?),
        "option" => Command::SetOption(v.get("key")?.as_str()?.to_string(), v.get("value")?.as_str()?.to_string()),
        "quit" => Command::Quit,
        _ => return None,
    })
}

fn write_loop(shared: Arc<Shared>, cmd_tx: Sender<Command>) {
    let mut stream: Option<(u64, TcpStream)> = None;
    let mut video: Vec<u8> = Vec::new();
    let mut audio_bytes: Vec<u8> = Vec::new();
    let mut last_video = Instant::now() - Duration::from_secs(1);
    loop {
        let (texts, pongs, audio, has_video, generation) = {
            let mut o = shared.out();
            loop {
                let gap = Duration::from_micros(shared.min_video_gap_us.load(Ordering::Relaxed));
                let video_due = o.video_fresh && last_video.elapsed() >= gap;
                let other = !o.audio.is_empty() || !o.text.is_empty() || !o.pongs.is_empty();
                if shared.quit.load(Ordering::SeqCst) || (o.stream.is_some() && (video_due || other)) {
                    break;
                }
                // A picture held back for the display rate: wake when it's due.
                let wait = if o.video_fresh { gap.saturating_sub(last_video.elapsed()).max(Duration::from_micros(200)) } else { Duration::from_millis(250) };
                o = shared.wake.wait_timeout(o, wait).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
            }
            let idle = !(o.video_fresh || !o.audio.is_empty() || !o.text.is_empty() || !o.pongs.is_empty());
            if o.stream.is_none() || (shared.quit.load(Ordering::SeqCst) && idle) {
                // Quitting, with no page left to tell or nothing left to say.
                return;
            }
            if stream.as_ref().map(|s| s.0) != Some(o.generation) {
                stream = o.stream.as_ref().and_then(|s| s.try_clone().ok()).map(|s| (o.generation, s));
            }
            let texts: Vec<String> = o.text.drain(..).collect();
            let pongs = std::mem::take(&mut o.pongs);
            let audio: Vec<Vec<i16>> = o.audio.drain(..).collect();
            let has_video = o.video_fresh && last_video.elapsed() >= Duration::from_micros(shared.min_video_gap_us.load(Ordering::Relaxed));
            if has_video {
                std::mem::swap(&mut o.video, &mut video);
                o.video_fresh = false;
            }
            (texts, pongs, audio, has_video, o.generation)
        };
        let Some((_, s)) = stream.as_mut() else { continue };
        let mut result = Ok(());
        for p in &pongs {
            result = result.and_then(|_| ws::write_frame(s, ws::Opcode::Pong, &[p]));
        }
        for t in &texts {
            result = result.and_then(|_| ws::write_frame(s, ws::Opcode::Text, &[t.as_bytes()]));
        }
        if !audio.is_empty() {
            let frames: usize = audio.iter().map(|a| a.len() / 2).sum();
            audio_bytes.clear();
            audio_bytes.extend_from_slice(&[b'A', 0, 0, 0]);
            audio_bytes.extend_from_slice(&(frames as u32).to_le_bytes());
            for chunk in &audio {
                for v in chunk {
                    audio_bytes.extend_from_slice(&v.to_le_bytes());
                }
            }
            result = result.and_then(|_| ws::write_frame(s, ws::Opcode::Binary, &[&audio_bytes]));
        }
        if has_video {
            last_video = Instant::now();
            result = result.and_then(|_| ws::write_frame(s, ws::Opcode::Binary, &[&video]));
        }
        if result.is_err() {
            stream = None;
            let _ = cmd_tx.send(Command::Disconnected(generation));
            let mut o = shared.out();
            if o.generation == generation {
                o.stream = None;
            }
        }
        if shared.quit.load(Ordering::SeqCst) && texts.iter().any(|t| t.contains("\"exit\"")) {
            if let Some((_, s)) = stream.take() {
                let _ = ws::write_frame(&mut s.try_clone().unwrap_or(s), ws::Opcode::Close, &[]);
            }
            return;
        }
    }
}

fn period(fps: f64) -> Duration {
    Duration::from_secs_f64(1.0 / if fps > 1.0 && fps < 1000.0 { fps } else { 60.0 })
}

fn ready_info(session: &Session, game_name: &str) -> Value {
    let av = session.av_info();
    let rotation = host::lock().rotation;
    json!({
        "game": game_name,
        "core": session.info.library_name,
        "version": session.info.library_version,
        "gpu": crate::hw::description(),
        "fps": av.timing.fps,
        "sampleRate": OUTPUT_RATE,
        "coreSampleRate": av.timing.sample_rate,
        "width": av.geometry.base_width,
        "height": av.geometry.base_height,
        "aspect": aspect_of(&av),
        "rotation": rotation,
    })
}

fn aspect_of(av: &libretro_sys::retro_system_av_info) -> f64 {
    let a = av.geometry.aspect_ratio as f64;
    if a > 0.0 { a } else if av.geometry.base_height > 0 { av.geometry.base_width as f64 / av.geometry.base_height as f64 } else { 4.0 / 3.0 }
}

fn emulation(cfg: SessionConfig, states_dir: PathBuf, game_name: String, idle_exit: Duration, shared: Arc<Shared>, cmd_rx: Receiver<Command>, ready_tx: Sender<Result<Value, String>>) {
    let mut session = match Session::start(cfg) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            shared.quit.store(true, Ordering::SeqCst);
            return;
        }
    };
    session.keep_core_loaded();
    let info = ready_info(&session, &game_name);
    shared.out().hello = Some(json!({ "type": "ready", "info": info }).to_string());
    let _ = ready_tx.send(Ok(info));

    let pacer = Pacer::new();
    let mut av = session.av_info();
    let mut frame_period = period(av.timing.fps);
    let mut resampler = Resampler::new(av.timing.sample_rate);
    let mut rate = RateControl::new(64.0);
    let (mut connected, mut paused, mut ff, mut quit) = (false, false, false, false);
    let mut idle_since = Instant::now();
    let mut deadline = Instant::now();
    let mut last_serial = 0u64;
    let (mut audio_in, mut audio_out) = (Vec::with_capacity(8192), Vec::with_capacity(8192));
    let mut last_video_push = Instant::now() - Duration::from_secs(1);
    // Per-second statistics.
    let (mut stat_at, mut stat_frames, mut stat_run, mut stat_late) = (Instant::now(), 0u32, Duration::ZERO, 0u32);
    let mut sram_at = Instant::now();
    let mut sram_hash = session.memory(libretro_sys::RETRO_MEMORY_SAVE_RAM).map(fnv);
    // Asked only once the game has run: some cores (Dolphin) crash when asked
    // for their save-state size before their first frame.
    let mut can_save: Option<bool> = None;
    // The frame rate the sound implies (core samples per frame vs its sample
    // rate), measured over ~2 s windows: some cores declare a rate they don't
    // run at (Dolphin reports 119.88 for 60 fps games).
    let (mut win_runs, mut win_samples, mut win_at) = (0u64, 0u64, Instant::now());
    let (mut total_runs, mut last_sound_fps) = (0u64, None::<f64>);

    let handle = |c: Command, s: &mut Session, connected: &mut bool, paused: &mut bool, ff: &mut bool, quit: &mut bool, rate: &mut RateControl| match c {
        Command::Input(port, input) => s.set_input(port, input),
        Command::Pause(p) => *paused = p,
        Command::Reset => s.reset(),
        Command::Save(slot) => {
            let path = states_dir.join(format!("{game_name}.state{slot}"));
            let r = s.serialize().and_then(|state| {
                std::fs::create_dir_all(&states_dir).map_err(|e| e.to_string())?;
                let tmp = path.with_extension("tmp");
                std::fs::write(&tmp, &state).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
                let (w, h, rgba) = {
                    let hs = host::lock();
                    (hs.frame.width, hs.frame.height, hs.frame.to_rgba())
                };
                if w > 0 && h > 0 {
                    let _ = write_png(&states_dir.join(format!("{game_name}.state{slot}.png")), w, h, &rgba);
                }
                Ok(state.len())
            });
            shared.text(match r {
                Ok(bytes) => json!({ "type": "saved", "slot": slot, "bytes": bytes }),
                Err(e) => json!({ "type": "error", "message": format!("Couldn't save: {e}") }),
            });
        }
        Command::Load(slot) => {
            let path = states_dir.join(format!("{game_name}.state{slot}"));
            let r = std::fs::read(&path).map_err(|_| "there's no save in that slot".to_string()).and_then(|b| s.unserialize(&b));
            shared.text(match r {
                Ok(()) => json!({ "type": "loaded", "slot": slot }),
                Err(e) => json!({ "type": "error", "message": format!("Couldn't load: {e}") }),
            });
        }
        Command::FastForward(on) => {
            *ff = on;
            host::lock().fastforward = on;
        }
        Command::AudioFill(fill, target) => {
            rate.fill_ms = fill;
            if let Some(t) = target.filter(|t| (10.0..=500.0).contains(t)) {
                rate.target_ms = t;
            }
        }
        Command::Display(hz) => {
            // A little under the refresh period so a picture is never held a whole extra refresh.
            let gap = if (20.0..=500.0).contains(&hz) { 1e6 / hz * 0.8 } else { 0.0 };
            shared.min_video_gap_us.store(gap as u64, Ordering::Relaxed);
        }
        Command::SetOption(k, v) => {
            host::lock().options.set(&k, &v);
        }
        Command::Connected => *connected = true,
        Command::Disconnected(generation) => {
            if shared.out().generation == generation {
                *connected = false;
            }
        }
        Command::Quit => *quit = true,
    };

    loop {
        while let Ok(c) = cmd_rx.try_recv() {
            handle(c, &mut session, &mut connected, &mut paused, &mut ff, &mut quit, &mut rate);
        }
        if quit || session.shutdown_requested() {
            break;
        }
        if !connected || paused {
            if !connected && idle_since.elapsed() > idle_exit {
                break;
            }
            if connected {
                idle_since = Instant::now();
            }
            match cmd_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(c) => handle(c, &mut session, &mut connected, &mut paused, &mut ff, &mut quit, &mut rate),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            deadline = Instant::now();
            continue;
        }
        idle_since = Instant::now();

        let t0 = Instant::now();
        session.run_frame(true);
        stat_run += t0.elapsed();
        stat_frames += 1;

        session.take_audio_into(&mut audio_in);
        win_runs += 1;
        win_samples += (audio_in.len() / 2) as u64;
        total_runs += 1;
        // One-second windows after a 3-second settling time (cores make sound
        // in bursts while they boot); a new rate is used only when two windows
        // in a row agree within 3 %.
        if win_at.elapsed() >= Duration::from_secs(1) {
            let settled = total_runs as f64 > av.timing.fps.max(30.0) * 3.0;
            if settled && win_samples > 0 && av.timing.sample_rate > 1000.0 {
                let sound_fps = av.timing.sample_rate * win_runs as f64 / win_samples as f64;
                let agrees = last_sound_fps.is_some_and(|p: f64| (p - sound_fps).abs() / sound_fps < 0.03);
                last_sound_fps = Some(sound_fps);
                if agrees {
                    let declared = av.timing.fps;
                    let target = if (sound_fps - declared).abs() / declared > 0.05 && (10.0..=240.0).contains(&sound_fps) { sound_fps } else { declared };
                    let p = period(target);
                    let shift = (p.as_secs_f64() - frame_period.as_secs_f64()).abs() / frame_period.as_secs_f64();
                    if shift > 0.0005 {
                        if shift > 0.01 {
                            crate::info!("pacing at {target:.2} fps (declared {declared:.2}, sound implies {sound_fps:.2})");
                        }
                        frame_period = p;
                    }
                }
            }
            (win_runs, win_samples, win_at) = (0, 0, Instant::now());
        }
        // Far too much sound queued in the page (a core that booted on a wrong
        // rate): drop it rather than play it seconds late; rate control alone
        // would take half a minute to drain it.
        let flood = rate.fill_ms > rate.target_ms * 3.0;
        if !ff && !flood && !audio_in.is_empty() {
            audio_out.clear();
            resampler.process(&audio_in, rate.adjust(), &mut audio_out);
            if !audio_out.is_empty() {
                let mut o = shared.out();
                // A page that stopped reading must not grow this forever (~1 s).
                let queued: usize = o.audio.iter().map(Vec::len).sum();
                if queued < OUTPUT_RATE as usize * 2 {
                    o.audio.push_back(audio_out.clone());
                }
                drop(o);
                shared.wake.notify_one();
            }
        }

        let changed = {
            let mut h = host::lock();
            std::mem::replace(&mut h.av_changed, false).then_some(h.av)
        };
        if let Some(new_av) = changed {
            if (new_av.timing.sample_rate - av.timing.sample_rate).abs() > 0.5 {
                resampler = Resampler::new(new_av.timing.sample_rate);
            }
            frame_period = period(new_av.timing.fps);
            av = new_av;
            shared.text(json!({ "type": "geometry", "width": av.geometry.base_width, "height": av.geometry.base_height, "aspect": aspect_of(&av), "fps": av.timing.fps, "rotation": host::lock().rotation }));
        }

        let now = Instant::now();
        deadline += frame_period;
        if deadline + frame_period * 3 < now {
            // Far behind (a stall, a slow scene): start again from now instead of rushing.
            deadline = now;
            stat_late += 1;
        }
        if ff {
            deadline = now;
        } else if rate.fill_ms > rate.target_ms * 1.5 {
            // Audio sync: the page holds far more sound than it wants, so this
            // core makes sound faster than real time (or declared the wrong
            // rate). Wait longer, in proportion, up to one extra frame; the
            // emulation then follows the sound card's clock.
            let surplus = Duration::from_secs_f64(((rate.fill_ms - rate.target_ms * 1.5) / 1000.0) * 0.25);
            deadline += surplus.min(frame_period);
        }

        // A GPU frame: collect it while there's time to spare before the next frame.
        if session.uses_gpu() {
            loop {
                let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)).min(Duration::from_millis(4));
                if session.finish_frame(left.as_micros() as u64) || Instant::now() > deadline + frame_period {
                    break;
                }
            }
        }

        let video_due = !ff || last_video_push.elapsed() >= Duration::from_millis(15);
        if video_due {
            let h = host::lock();
            let f = &h.frame;
            if f.serial != last_serial && f.width > 0 && !f.data.is_empty() {
                last_serial = f.serial;
                let fmt = match f.data_format {
                    PixelFormat::Rgb565 | PixelFormat::Rgb1555 => 0u8,
                    PixelFormat::Xrgb8888 => 1,
                    PixelFormat::Rgba8 => 2,
                };
                let bytes = f.width as usize * f.height as usize * f.data_format.bytes_per_pixel();
                let mut o = shared.out();
                if o.video_fresh {
                    shared.dropped.fetch_add(1, Ordering::Relaxed);
                }
                o.video.clear();
                o.video.extend_from_slice(&[b'V', fmt, f.bottom_up as u8, 0]);
                o.video.extend_from_slice(&f.width.to_le_bytes());
                o.video.extend_from_slice(&f.height.to_le_bytes());
                o.video.extend_from_slice(&f.count.to_le_bytes());
                o.video.extend_from_slice(&[0, 0, 0, 0]);
                o.video.extend_from_slice(&f.data[..bytes.min(f.data.len())]);
                o.video_fresh = true;
                drop(o);
                drop(h);
                shared.wake.notify_one();
                last_video_push = Instant::now();
            }
        }

        if stat_at.elapsed() >= Duration::from_secs(1) {
            let secs = stat_at.elapsed().as_secs_f64();
            let can = *can_save.get_or_insert_with(|| session.serialize_size() > 0);
            shared.text(json!({
                "canSave": can,
                "type": "status",
                "fps": (stat_frames as f64 / secs * 10.0).round() / 10.0,
                "frameMs": if stat_frames > 0 { (stat_run.as_secs_f64() * 1000.0 / stat_frames as f64 * 100.0).round() / 100.0 } else { 0.0 },
                "audioFillMs": rate.fill_ms.round(),
                "dropped": shared.dropped.swap(0, Ordering::Relaxed),
                "late": stat_late,
            }));
            (stat_at, stat_frames, stat_run, stat_late) = (Instant::now(), 0, Duration::ZERO, 0);
        }

        // The battery save, every 30 s when it changed (a crash or a forced stop loses at most that).
        if sram_at.elapsed() >= Duration::from_secs(30) {
            sram_at = Instant::now();
            let now_hash = session.memory(libretro_sys::RETRO_MEMORY_SAVE_RAM).map(fnv);
            if now_hash != sram_hash {
                sram_hash = now_hash;
                if let Err(e) = session.save_sram() {
                    crate::warn!("couldn't write the battery save: {e}");
                }
            }
        }

        if !ff {
            pacer.sleep_until(deadline);
        }
    }

    crate::info!("closing the game");
    drop(session);
    crate::info!("game closed");
    shared.text(json!({ "type": "exit" }));
    shared.quit.store(true, Ordering::SeqCst);
    shared.wake.notify_all();
}

fn fnv(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf29ce484222325u64, |h, &x| (h ^ x as u64).wrapping_mul(0x100000001b3))
}
