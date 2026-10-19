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
//! pause, resume, reset, save {slot}, load {slot}, slot {n}, slots, ff {on},
//! ffspeed {x}, rewind {on} (held), rewinding {enabled}, runahead {frames},
//! layout {labels}, audio {fill, target}, display {hz}, option {key, value}, quit.
//!
//! Phase 4: controllers the engine reads itself (input.rs) take the first
//! ports, the page's own controllers the ports after; Guide hotkeys act
//! here and tell the page. Rewind (rewind.rs) and run-ahead
//! (Session::run_frame_ahead) switch on per core when its save states are
//! small and quick enough.
use crate::audio::{RateControl, Resampler, OUTPUT_RATE};
use crate::host::{self, PortInput};
use crate::input::{Hotkey, Layout, Native};
use crate::rewind::Rewind;
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

pub(crate) enum Command {
    Input(usize, PortInput),
    Pause(bool),
    Reset,
    Save(u32),
    /// Removes a slot here and on the host.
    Delete(u32),
    /// A slot; a version to load an earlier one from the host.
    Load(u32, Option<u32>),
    /// The host's earlier versions of a slot.
    Versions(u32),
    Slot(u32),
    Slots,
    FastForward(bool),
    FfSpeed(f64),
    /// Held: play backwards.
    Rewind(bool),
    /// Keep the rewind history at all.
    RewindEnabled(bool),
    RunAhead(u32),
    Layout(Layout),
    AudioFill(f64, Option<f64>),
    /// The page's display refresh rate: no point sending pictures faster.
    Display(f64),
    SetOption(String, String),
    Connected,
    Disconnected(u64),
    Quit,
}

#[derive(Default)]
pub(crate) struct Outbox {
    /// Header + pixels of the newest picture not sent yet.
    video: Vec<u8>,
    video_fresh: bool,
    audio: VecDeque<Vec<i16>>,
    text: VecDeque<String>,
    pongs: Vec<Vec<u8>>,
    /// The writing half of the current page's connection.
    stream: Option<TcpStream>,
    pub(crate) generation: u64,
    /// The `ready` message, sent first to every page that connects.
    hello: Option<String>,
}

pub(crate) struct Shared {
    out: Mutex<Outbox>,
    pub(crate) wake: Condvar,
    pub(crate) quit: AtomicBool,
    pub(crate) dropped: AtomicU64,
    /// Shortest gap between pictures sent, in microseconds (from the page's refresh rate).
    pub(crate) min_video_gap_us: AtomicU64,
    /// When the work thread last came round its loop (ms since `started`);
    /// the watchdog in `host` reads it.
    beat_ms: AtomicU64,
    started: Instant,
    /// The page asked to close (seen by the reader, even if the work thread is stuck).
    quit_asked: AtomicBool,
}

impl Shared {
    pub(crate) fn out(&self) -> MutexGuard<'_, Outbox> {
        self.out.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Hands a picture to the writer (replacing one not sent yet).
    pub(crate) fn picture(&self, fmt: u8, bottom_up: bool, width: u32, height: u32, frame: u64, rows: impl FnOnce(&mut Vec<u8>)) {
        let mut o = self.out();
        if o.video_fresh {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        o.video.clear();
        o.video.extend_from_slice(&[b'V', fmt, bottom_up as u8, 0]);
        o.video.extend_from_slice(&width.to_le_bytes());
        o.video.extend_from_slice(&height.to_le_bytes());
        o.video.extend_from_slice(&frame.to_le_bytes());
        o.video.extend_from_slice(&[0, 0, 0, 0]);
        rows(&mut o.video);
        o.video_fresh = true;
        drop(o);
        self.wake.notify_one();
    }
    /// Hands sound to the writer (interleaved stereo i16 at 48 kHz).
    pub(crate) fn sound(&self, samples: &[i16]) {
        let mut o = self.out();
        // A page that stopped reading must not grow this forever (~1 s).
        let queued: usize = o.audio.iter().map(Vec::len).sum();
        if queued < OUTPUT_RATE as usize * 2 {
            o.audio.push_back(samples.to_vec());
        }
        drop(o);
        self.wake.notify_one();
    }
    /// The `ready` message every page gets first.
    pub(crate) fn set_hello(&self, info: &Value) {
        self.out().hello = Some(json!({ "type": "ready", "info": info }).to_string());
    }
    pub(crate) fn text(&self, v: Value) {
        self.out().text.push_back(v.to_string());
        self.wake.notify_one();
    }
    /// The work thread is alive: called once per pass of its loop.
    pub(crate) fn beat(&self) {
        self.beat_ms.store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    fn since_beat(&self) -> Duration {
        Duration::from_millis((self.started.elapsed().as_millis() as u64).saturating_sub(self.beat_ms.load(Ordering::Relaxed)))
    }
}

/// The page is told the game stopped responding after this long without a
/// pass of the work thread's loop (a core stuck inside `retro_run`, an
/// emulator stuck); it comes back on its own if the core recovers.
const STUCK_AFTER: Duration = Duration::from_secs(20);
/// Asked to close while stuck: the process ends after this long.
const STUCK_QUIT_AFTER: Duration = Duration::from_secs(8);
/// Stuck this long: the process ends even with nobody asking (nothing can save it).
const STUCK_GIVE_UP: Duration = Duration::from_secs(300);

fn say(line: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn run(cfg: ServeConfig) -> i32 {
    let (session_cfg, states_dir, game_name, idle_exit) = (cfg.session.clone(), cfg.states_dir.clone(), cfg.game_name.clone(), cfg.idle_exit);
    host(cfg.port, cfg.key.clone(), cfg.origins.clone(), move |shared, cmd_rx, ready_tx| emulation(session_cfg, states_dir, game_name, idle_exit, shared, cmd_rx, ready_tx))
}

/// Serves one page over a local WebSocket while `work` (on its own thread)
/// produces pictures and sound: binds, prints `{"listening":port}`, waits
/// for `work` to report `ready` (printed) or an error, accepts pages that
/// present `key` (and an allowed origin), and ends the process once `work`
/// has set `quit`. Used by `serve` (a libretro game) and `capture` (another
/// emulator's window).
pub(crate) fn host<F>(port: u16, key: String, origins: Vec<String>, work: F) -> i32
where
    F: FnOnce(Arc<Shared>, Receiver<Command>, Sender<Result<Value, String>>) + Send + 'static,
{
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            say(json!({ "error": format!("can't listen on 127.0.0.1:{port}: {e}") }));
            return 1;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    say(json!({ "listening": port }));

    let shared = Arc::new(Shared {
        out: Mutex::new(Outbox::default()),
        wake: Condvar::new(),
        quit: AtomicBool::new(false),
        dropped: AtomicU64::new(0),
        min_video_gap_us: AtomicU64::new(0),
        beat_ms: AtomicU64::new(0),
        started: Instant::now(),
        quit_asked: AtomicBool::new(false),
    });
    let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<Value, String>>();

    let emu = {
        let shared = shared.clone();
        std::thread::Builder::new().name("emulation".into()).stack_size(16 << 20).spawn(move || work(shared, cmd_rx, ready_tx)).expect("emulation thread")
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
    shared.beat();
    let mut stuck = false;
    let mut quit_asked_at: Option<Instant> = None;
    while !shared.quit.load(Ordering::SeqCst) {
        // Watchdog: a core that never returns from a frame can't save or
        // close itself, so this thread tells the page and ends the process.
        let since = shared.since_beat();
        if since > STUCK_AFTER && !stuck {
            stuck = true;
            crate::warn!("the game stopped responding ({} s without a frame)", since.as_secs());
            shared.text(json!({ "type": "stuck", "stuck": true }));
        } else if since < STUCK_AFTER && stuck {
            stuck = false;
            crate::info!("the game is responding again");
            shared.text(json!({ "type": "stuck", "stuck": false }));
        }
        if shared.quit_asked.load(Ordering::Relaxed) && quit_asked_at.is_none() {
            quit_asked_at = Some(Instant::now());
        }
        let asked_long_ago = quit_asked_at.is_some_and(|t| t.elapsed() > STUCK_QUIT_AFTER);
        if (asked_long_ago && since > STUCK_QUIT_AFTER) || since > STUCK_GIVE_UP {
            crate::error!("ending the engine: the game stopped responding {} s ago and can't be saved", since.as_secs());
            shared.text(json!({ "type": "error", "message": "The game stopped responding and was closed. Your saves from before are safe." }));
            shared.wake.notify_all();
            std::thread::sleep(Duration::from_millis(300));
            let _ = std::io::stdout().flush();
            unsafe { TerminateProcess(GetCurrentProcess(), 3) };
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                connect(stream, &key, &origins, &shared, &cmd_tx);
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

fn connect(mut stream: TcpStream, key_wanted: &str, origins: &[String], shared: &Arc<Shared>, cmd_tx: &Sender<Command>) {
    let (req, key) = match ws::read_request(&mut stream) {
        Ok(r) => r,
        Err(_) => {
            ws::reject(&mut stream, "400 Bad Request");
            return;
        }
    };
    let given = req.path.split_once('?').map(|(_, q)| q).unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("key=")).unwrap_or("");
    if !req.path.starts_with("/session") || !same_key(given, key_wanted) {
        ws::reject(&mut stream, "403 Forbidden");
        return;
    }
    if !origins.is_empty() && !req.origin.as_deref().is_some_and(|o| origins.iter().any(|a| a == o)) {
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
                    if matches!(c, Command::Quit) {
                        shared.quit_asked.store(true, Ordering::Relaxed);
                    }
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
        "delete" => Command::Delete(n("slot").unwrap_or(0.0) as u32),
        "load" => Command::Load(n("slot").unwrap_or(0.0) as u32, n("version").map(|v| v as u32)),
        "versions" => Command::Versions(n("slot").unwrap_or(1.0) as u32),
        "ff" => Command::FastForward(v.get("on").and_then(Value::as_bool).unwrap_or(false)),
        "ffspeed" => Command::FfSpeed(n("x").unwrap_or(0.0)),
        "rewind" => Command::Rewind(v.get("on").and_then(Value::as_bool).unwrap_or(false)),
        "rewinding" => Command::RewindEnabled(v.get("enabled").and_then(Value::as_bool).unwrap_or(true)),
        "runahead" => Command::RunAhead(n("frames").unwrap_or(0.0).clamp(0.0, 4.0) as u32),
        "slot" => Command::Slot(n("n").unwrap_or(1.0).clamp(1.0, 9.0) as u32),
        "slots" => Command::Slots,
        "layout" => Command::Layout(if v.get("labels").and_then(Value::as_bool).unwrap_or(false) { Layout::Labels } else { Layout::Position }),
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

/// Save-state slots on disk: `<game>.state<n>` and a small picture beside it.
fn slot_path(states_dir: &std::path::Path, game: &str, slot: u32) -> PathBuf {
    states_dir.join(format!("{game}.state{slot}"))
}

type HostCache = Arc<Mutex<Vec<crate::sync::HostSlot>>>;

fn save_slot(s: &Session, states_dir: &std::path::Path, game: &str, slot: u32, shared: &Arc<Shared>, cache: &HostCache) -> Value {
    let path = slot_path(states_dir, game, slot);
    let r = s.serialize().and_then(|state| {
        std::fs::create_dir_all(states_dir).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &state).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        let (w, h, rgba) = {
            let hs = host::lock();
            (hs.frame.width, hs.frame.height, hs.frame.to_rgba())
        };
        let thumb_path = path.with_extension(format!("state{slot}.png"));
        if w > 0 && h > 0 {
            let (tw, th, small) = shrink(w, h, &rgba, 200);
            let _ = write_png(&thumb_path, tw, th, &small);
        }
        // Up to the host in the background (sync.rs applies the size limit after compressing).
        if let Some(sync) = s.sync() {
            if state.len() <= 512 << 20 {
                let thumb = std::fs::read(&thumb_path).unwrap_or_default();
                let (shared, cache, sync2) = (shared.clone(), cache.clone(), sync.clone());
                sync.push_state(slot, state.clone(), thumb, move |r| match r {
                    Ok(v) => {
                        shared.text(json!({ "type": "synced", "slot": slot, "version": v["version"] }));
                        if let Ok(list) = sync2.list_states() {
                            *cache.lock().unwrap_or_else(|e| e.into_inner()) = list;
                        }
                    }
                    Err(e) => shared.text(json!({ "type": "syncError", "slot": slot, "message": format!("Saved on this PC; not on the host yet ({e})") })),
                });
            }
        }
        Ok(state.len())
    });
    match r {
        Ok(bytes) => json!({ "type": "saved", "slot": slot, "bytes": bytes }),
        Err(e) => json!({ "type": "error", "message": format!("Couldn't save: {e}") }),
    }
}

fn modified_ms(p: &std::path::Path) -> Option<u64> {
    std::fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// Loads a slot: an earlier version from the host when asked; otherwise the
/// newer of this PC's copy and the host's (the host's is kept here after).
fn load_slot(s: &Session, states_dir: &std::path::Path, game: &str, slot: u32, version: Option<u32>, cache: &HostCache) -> Value {
    let path = slot_path(states_dir, game, slot);
    let host_at = cache.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|h| h.slot == slot).map(|h| h.saved_at);
    let local_at = modified_ms(&path);
    let from_host = version.is_some() || matches!((local_at, host_at), (None, Some(_))) || matches!((local_at, host_at), (Some(l), Some(h)) if h > l + 2000);
    let r = if from_host {
        match s.sync() {
            Some(sync) => sync.fetch_state(slot, version).and_then(|(state, _)| {
                if version.is_none() {
                    let _ = std::fs::create_dir_all(states_dir);
                    let _ = std::fs::write(&path, &state);
                }
                s.unserialize(&state).map(|_| "host")
            }),
            None => Err("this game isn't linked to the host".into()),
        }
    } else {
        std::fs::read(&path).map_err(|_| "there's no save in that slot".to_string()).and_then(|b| s.unserialize(&b)).map(|_| "pc")
    };
    match r {
        Ok(from) => json!({ "type": "loaded", "slot": slot, "version": version, "from": from }),
        Err(e) => json!({ "type": "error", "message": format!("Couldn't load: {e}") }),
    }
}

/// Slots 1-4: when each was saved, its picture (PNG, base64), and whether
/// the host has it (with how many versions), merging this PC and the host.
fn list_slots(states_dir: &std::path::Path, game: &str, host: &[crate::sync::HostSlot]) -> Value {
    let slots: Vec<Value> = (1..=4u32)
        .map(|slot| {
            let path = slot_path(states_dir, game, slot);
            let local_at = modified_ms(&path);
            let local_thumb = local_at.and_then(|_| std::fs::read(path.with_extension(format!("state{slot}.png"))).ok()).map(|b| ws::base64(&b));
            let h = host.iter().find(|h| h.slot == slot);
            let host_newer = matches!((local_at, h), (None, Some(_))) || matches!((local_at, h), (Some(l), Some(h)) if h.saved_at > l + 2000);
            let saved = if host_newer { h.map(|h| h.saved_at) } else { local_at };
            let thumb = if host_newer { h.and_then(|h| h.thumb.clone()).or(local_thumb) } else { local_thumb.or_else(|| h.and_then(|h| h.thumb.clone())) };
            json!({
                "slot": slot,
                "saved": saved.map(|ms| ms / 1000),
                "thumb": thumb,
                "onHost": h.is_some(),
                "versions": h.map(|h| h.versions).unwrap_or(0),
                "device": h.and_then(|h| h.device.clone()),
            })
        })
        .collect();
    json!({ "type": "slots", "slots": slots })
}

/// Nearest-neighbour shrink of an RGBA picture to at most `max_w` wide.
fn shrink(w: u32, h: u32, rgba: &[u8], max_w: u32) -> (u32, u32, Vec<u8>) {
    if w <= max_w {
        return (w, h, rgba.to_vec());
    }
    let (tw, th) = (max_w, (h as u64 * max_w as u64 / w as u64).max(1) as u32);
    let mut out = Vec::with_capacity((tw * th * 4) as usize);
    for y in 0..th {
        let sy = (y as u64 * h as u64 / th as u64) as usize;
        for x in 0..tw {
            let sx = (x as u64 * w as u64 / tw as u64) as usize;
            let i = (sy * w as usize + sx) * 4;
            out.extend_from_slice(&rgba[i..i + 4]);
        }
    }
    (tw, th, out)
}

/// What one game session is doing, as the page and the controllers ask.
struct Play {
    connected: bool,
    paused: bool,
    ff: bool,
    /// Fast-forward speed (x real time); 0 = as fast as it goes.
    ff_speed: f64,
    quit: bool,
    rate: RateControl,
    /// The page's controls per port (keyboard and its own controllers).
    page: [PortInput; host::MAX_PORTS],
    slot: u32,
    rewind_enabled: bool,
    rewinding: bool,
    runahead: u32,
    layout: Layout,
}

/// What the engine measured about this core's save states (after it has run a moment).
#[derive(Clone, Copy)]
struct StateCost {
    bytes: usize,
    ms: f64,
}

impl StateCost {
    /// Rewind keeps every frame when states are small, every few frames when larger.
    fn rewind_every(&self) -> Option<u32> {
        match self.bytes {
            0 => None,
            b if b > 32 << 20 || self.ms > 4.0 => None,
            b if b <= 1 << 20 => Some(1),
            b if b <= 4 << 20 => Some(2),
            _ => Some(4),
        }
    }
    /// How many frames ahead fit in a frame's time (save + load + the extra frames).
    fn runahead_max(&self, frame_ms: f64, period_ms: f64) -> u32 {
        if self.bytes == 0 || self.bytes > 16 << 20 {
            return 0;
        }
        (1..=2u32).rev().find(|k| frame_ms * (*k as f64 + 1.0) + self.ms * 2.0 < period_ms * 0.7).unwrap_or(0)
    }
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
    let mut native = Native::open();
    let mut info = ready_info(&session, &game_name);
    // Tell the person when their battery save came from another device.
    if let Some(p) = session.sram_pull.as_ref().filter(|p| p.from_host) {
        info["saveFrom"] = json!({ "device": p.device, "backup": p.backup });
    }
    info["nativeControllers"] = json!(native.available());
    info["guide"] = json!(native.guide);
    shared.out().hello = Some(json!({ "type": "ready", "info": info }).to_string());
    let _ = ready_tx.send(Ok(info));

    let pacer = Pacer::new();
    let mut av = session.av_info();
    let mut frame_period = period(av.timing.fps);
    let mut resampler = Resampler::new(av.timing.sample_rate);
    let mut play = Play {
        connected: false, paused: false, ff: false, ff_speed: 4.0, quit: false, rate: RateControl::new(64.0),
        page: [PortInput::default(); host::MAX_PORTS], slot: 1, rewind_enabled: true, rewinding: false, runahead: 0, layout: Layout::Position,
    };
    let mut idle_since = Instant::now();
    let mut deadline = Instant::now();
    let mut last_serial = 0u64;
    let (mut audio_in, mut audio_out) = (Vec::with_capacity(8192), Vec::with_capacity(8192));
    let mut last_video_push = Instant::now() - Duration::from_secs(1);
    // Per-second statistics.
    let (mut stat_at, mut stat_frames, mut stat_run, mut stat_late) = (Instant::now(), 0u32, Duration::ZERO, 0u32);
    let mut frame_ms = 0.0f64;
    let mut sram_at = Instant::now();
    let mut sram_hash = session.memory(libretro_sys::RETRO_MEMORY_SAVE_RAM).map(fnv);
    // Asked only once the game has run: some cores (Dolphin) crash when asked
    // about save states before their first frame.
    let mut cost: Option<StateCost> = None;
    let mut rewind: Option<Rewind> = None;
    let mut since_capture = 0u32;
    let mut state_buf: Vec<u8> = Vec::new();
    // The frame rate the sound implies (core samples per frame vs its sample
    // rate): some cores declare a rate they don't run at (Dolphin reports
    // 119.88 for 60 fps games).
    let (mut win_runs, mut win_samples, mut win_at) = (0u64, 0u64, Instant::now());
    let (mut total_runs, mut last_sound_fps) = (0u64, None::<f64>);
    let mut hotkeys: Vec<Hotkey> = Vec::new();
    let mut last_rumble = [[0u16; 2]; host::MAX_PORTS];
    let mut native_count = 0usize;
    let mut was_rewinding = false;
    let mut rewind_held = 0u32;
    // The host's slots for this game, fetched in the background (load uses them to pick the newer copy).
    let host_cache: HostCache = Arc::new(Mutex::new(Vec::new()));
    if let Some(sync) = session.sync() {
        let cache = host_cache.clone();
        let _ = std::thread::Builder::new().name("sync-list".into()).spawn(move || {
            if let Ok(list) = sync.list_states() {
                *cache.lock().unwrap_or_else(|e| e.into_inner()) = list;
            }
        });
    }

    let handle = |c: Command, s: &mut Session, play: &mut Play, rewind: &mut Option<Rewind>, native: &mut Native| match c {
        Command::Input(port, input) => {
            if port < host::MAX_PORTS {
                play.page[port] = input;
            }
        }
        Command::Pause(p) => {
            play.paused = p;
            if p {
                native.quiet();
            }
        }
        Command::Reset => {
            s.reset();
            if let Some(r) = rewind.as_mut() {
                r.clear();
            }
        }
        Command::Save(slot) => shared.text(save_slot(s, &states_dir, &game_name, slot, &shared, &host_cache)),
        Command::Load(slot, version) => {
            shared.text(load_slot(s, &states_dir, &game_name, slot, version, &host_cache));
            if let Some(r) = rewind.as_mut() {
                r.clear();
            }
        }
        Command::Slot(n) => play.slot = n,
        Command::Delete(slot) => {
            let path = slot_path(&states_dir, &game_name, slot);
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension(format!("state{slot}.png")));
            host_cache.lock().unwrap_or_else(|e| e.into_inner()).retain(|h| h.slot != slot);
            let shared2 = shared.clone();
            let (dir, game) = (states_dir.clone(), game_name.clone());
            match s.sync() {
                Some(sync) => {
                    let cache = host_cache.clone();
                    let _ = std::thread::Builder::new().name("sync-delete".into()).spawn(move || {
                        let r = sync.delete_state(slot);
                        let list = sync.list_states().unwrap_or_default();
                        shared2.text(list_slots(&dir, &game, &list));
                        *cache.lock().unwrap_or_else(|e| e.into_inner()) = list;
                        shared2.text(match r {
                            Ok(()) => json!({ "type": "deleted", "slot": slot }),
                            Err(e) => json!({ "type": "error", "message": format!("Deleted on this PC; not on your account yet ({e})") }),
                        });
                    });
                }
                None => {
                    shared2.text(list_slots(&dir, &game, &[]));
                    shared2.text(json!({ "type": "deleted", "slot": slot }));
                }
            }
        }
        Command::Slots => {
            // This PC's slots at once; again with the host's once it answers.
            let cached = host_cache.lock().unwrap_or_else(|e| e.into_inner()).clone();
            shared.text(list_slots(&states_dir, &game_name, &cached));
            if let Some(sync) = s.sync() {
                let (shared, cache, dir, game) = (shared.clone(), host_cache.clone(), states_dir.clone(), game_name.clone());
                let _ = std::thread::Builder::new().name("sync-list".into()).spawn(move || {
                    if let Ok(list) = sync.list_states() {
                        shared.text(list_slots(&dir, &game, &list));
                        *cache.lock().unwrap_or_else(|e| e.into_inner()) = list;
                    }
                });
            }
        }
        Command::Versions(slot) => {
            if let Some(sync) = s.sync() {
                let shared = shared.clone();
                let _ = std::thread::Builder::new().name("sync-versions".into()).spawn(move || {
                    shared.text(match sync.versions(slot) {
                        Ok(v) => json!({ "type": "versions", "slot": slot, "versions": v }),
                        Err(e) => json!({ "type": "versions", "slot": slot, "versions": [], "error": e }),
                    });
                });
            } else {
                shared.text(json!({ "type": "versions", "slot": slot, "versions": [] }));
            }
        }
        Command::FastForward(on) => {
            play.ff = on;
            host::lock().fastforward = on;
        }
        Command::FfSpeed(x) => play.ff_speed = if x >= 1.0 { x.min(16.0) } else { 0.0 },
        Command::Rewind(on) => play.rewinding = on && play.rewind_enabled,
        Command::RewindEnabled(on) => {
            play.rewind_enabled = on;
            if !on {
                play.rewinding = false;
                *rewind = None;
            }
        }
        Command::RunAhead(k) => {
            play.runahead = k;
            // Run-ahead on a second instance keeps the sound exact (see
            // Session::start_second_instance); one instance if that can't start.
            if k > 0 && !s.uses_gpu() && !s.second_instance() {
                if let Err(e) = s.start_second_instance() {
                    crate::info!("run-ahead on one instance: {e}");
                }
            }
        }
        Command::Layout(l) => {
            play.layout = l;
            native.layout = l;
        }
        Command::AudioFill(fill, target) => {
            play.rate.fill_ms = fill;
            if let Some(t) = target.filter(|t| (10.0..=500.0).contains(t)) {
                play.rate.target_ms = t;
            }
        }
        Command::Display(hz) => {
            // A little under the refresh period so a picture is never held a whole extra refresh.
            let gap = if (20.0..=500.0).contains(&hz) { 1e6 / hz * 0.8 } else { 0.0 };
            shared.min_video_gap_us.store(gap as u64, Ordering::Relaxed);
        }
        Command::SetOption(k, v) => s.set_option(&k, &v),
        Command::Connected => play.connected = true,
        Command::Disconnected(generation) => {
            if shared.out().generation == generation {
                play.connected = false;
                native.quiet();
            }
        }
        Command::Quit => play.quit = true,
    };

    loop {
        shared.beat();
        while let Ok(c) = cmd_rx.try_recv() {
            handle(c, &mut session, &mut play, &mut rewind, &mut native);
        }
        if play.quit || session.shutdown_requested() {
            break;
        }
        if !play.connected || play.paused {
            if !play.connected && idle_since.elapsed() > idle_exit {
                break;
            }
            if play.connected {
                idle_since = Instant::now();
                // While paused (the menu is open) the engine's controllers
                // drive the menu: their new presses go to the page.
                hotkeys.clear();
                native.poll(&mut hotkeys);
                if hotkeys.contains(&Hotkey::Menu) {
                    shared.text(json!({ "type": "menu" }));
                } else if native.nav != 0 {
                    shared.text(json!({ "type": "nav", "buttons": native.nav }));
                }
            }
            match cmd_rx.recv_timeout(Duration::from_millis(30)) {
                Ok(c) => handle(c, &mut session, &mut play, &mut rewind, &mut native),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            deadline = Instant::now();
            continue;
        }
        idle_since = Instant::now();

        // Controls: the engine's own controllers first, then the page's.
        hotkeys.clear();
        let pads = native.poll(&mut hotkeys);
        if pads.len() != native_count {
            native_count = pads.len();
            shared.text(json!({ "type": "pads", "native": native_count }));
        }
        for h in hotkeys.drain(..) {
            match h {
                Hotkey::Save => shared.text(save_slot(&session, &states_dir, &game_name, play.slot, &shared, &host_cache)),
                Hotkey::SlotNext | Hotkey::SlotPrev => {
                    let up = h == Hotkey::SlotNext;
                    play.slot = if up { play.slot % 4 + 1 } else { (play.slot + 2) % 4 + 1 };
                    shared.text(json!({ "type": "slot", "n": play.slot }));
                }
                Hotkey::Load => {
                    shared.text(load_slot(&session, &states_dir, &game_name, play.slot, None, &host_cache));
                    if let Some(r) = rewind.as_mut() {
                        r.clear();
                    }
                }
                Hotkey::Menu => shared.text(json!({ "type": "menu" })),
                Hotkey::FastForward(on) => {
                    play.ff = on;
                    host::lock().fastforward = on;
                    shared.text(json!({ "type": "ff", "on": on }));
                }
                Hotkey::Rewind(on) => play.rewinding = on && play.rewind_enabled && rewind.is_some(),
            }
        }
        let mut inputs = play.page;
        for (port, pad) in pads.iter().enumerate().take(host::MAX_PORTS) {
            if let Some(p) = pad {
                let i = &mut inputs[port];
                i.buttons |= p.buttons;
                for s in 0..2 {
                    for a in 0..2 {
                        if p.sticks[s][a] != 0 {
                            i.sticks[s][a] = p.sticks[s][a];
                        }
                    }
                }
                i.triggers = [i.triggers[0].max(p.triggers[0]), i.triggers[1].max(p.triggers[1])];
            }
        }
        session.set_inputs(&inputs);

        let t0 = Instant::now();
        let rewound = play.rewinding && rewind.as_ref().is_some_and(|r| !r.is_empty());
        if rewound {
            // Backwards: restore an earlier capture and show it (one frame,
            // silent). Held longer, it goes faster: 1x for a second, then 2x,
            // then 4x. The capture stays the current one until rewinding stops.
            rewind_held += 1;
            let steps = if rewind_held < 60 { 1 } else if rewind_held < 180 { 2 } else { 4 };
            let mut target: Option<Vec<u8>> = None;
            if let Some(r) = rewind.as_mut() {
                for _ in 0..steps {
                    match r.back() {
                        Some(st) => target = Some(st.to_vec()),
                        None => break,
                    }
                }
            }
            if let Some(st) = target {
                let _ = session.unserialize(&st);
            }
            host::lock().av_enable = 1;
            session.run_frame(false);
            host::lock().av_enable = 3;
            since_capture = 0;
        } else if play.rewinding {
            // At the oldest capture with rewind still held: stay on that picture.
        } else {
            if was_rewinding {
                // Rewind released: carry on exactly from the capture shown last.
                if let Some(cur) = rewind.as_ref().and_then(|r| r.current()).map(<[u8]>::to_vec) {
                    let _ = session.unserialize(&cur);
                }
                since_capture = 0;
            }
            let ahead = if play.ff { 0 } else { play.runahead.min(cost.map(|c| c.runahead_max(frame_ms, frame_period.as_secs_f64() * 1000.0)).unwrap_or(0)) };
            let captured = ahead > 0 && session.run_frame_ahead(ahead, true, &mut state_buf).is_ok();
            if ahead == 0 {
                session.run_frame(true);
            }
            if let Some(r) = rewind.as_mut() {
                since_capture += 1;
                if since_capture >= r.every {
                    since_capture = 0;
                    if captured || session.serialize_into(&mut state_buf).is_ok() {
                        r.push(&state_buf);
                    }
                }
            }
        }
        if !play.rewinding {
            rewind_held = 0;
        }
        let holding = play.rewinding && !rewound;
        was_rewinding = rewound || holding;
        let ran = t0.elapsed();
        stat_run += ran;
        stat_frames += 1;
        frame_ms = frame_ms * 0.9 + ran.as_secs_f64() * 100.0;

        session.take_audio_into(&mut audio_in);
        win_runs += 1;
        win_samples += (audio_in.len() / 2) as u64;
        total_runs += 1;
        // One-second windows after a 3-second settling time (cores make sound
        // in bursts while they boot); a new rate is used only when two windows
        // in a row agree within 3 %.
        if win_at.elapsed() >= Duration::from_secs(1) {
            let settled = total_runs as f64 > av.timing.fps.max(30.0) * 3.0;
            if settled && !play.ff && !rewound && win_samples > 0 && av.timing.sample_rate > 1000.0 {
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
        let flood = play.rate.fill_ms > play.rate.target_ms * 3.0;
        if !play.ff && !was_rewinding && !flood && !audio_in.is_empty() {
            audio_out.clear();
            resampler.process(&audio_in, play.rate.adjust(), &mut audio_out);
            if !audio_out.is_empty() {
                shared.sound(&audio_out);
            }
        }

        // Rumble: the engine's controllers directly, the page's through the page.
        let rumble = session.rumble();
        for (port, r) in rumble.iter().enumerate().take(4) {
            if port < native_count {
                native.rumble(port, r[0], r[1]);
            } else if *r != last_rumble[port] {
                shared.text(json!({ "type": "rumble", "port": port, "strong": r[0], "weak": r[1] }));
            }
        }
        last_rumble = rumble;

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
        let step = if play.ff && play.ff_speed >= 1.0 { frame_period.div_f64(play.ff_speed) } else { frame_period };
        deadline += step;
        if deadline + frame_period * 3 < now {
            // Far behind (a stall, a slow scene): start again from now instead of rushing.
            deadline = now;
            stat_late += 1;
        }
        if play.ff && play.ff_speed < 1.0 {
            deadline = now;
        } else if !play.ff && play.rate.fill_ms > play.rate.target_ms * 1.5 {
            // Audio sync: the page holds far more sound than it wants, so this
            // core makes sound faster than real time (or declared the wrong
            // rate). Wait longer, in proportion, up to one extra frame; the
            // emulation then follows the sound card's clock.
            let surplus = Duration::from_secs_f64(((play.rate.fill_ms - play.rate.target_ms * 1.5) / 1000.0) * 0.25);
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

        let video_due = !play.ff || last_video_push.elapsed() >= Duration::from_millis(15);
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
            // Measure save states once the game has run a second.
            if cost.is_none() {
                let c = if session.serialize_size() == 0 {
                    StateCost { bytes: 0, ms: 0.0 }
                } else {
                    // One save to learn the size; two more to time it only when the
                    // state is small enough to rewind (a 92 MB Dolphin state would hitch).
                    let t = Instant::now();
                    let mut n = u32::from(session.serialize_into(&mut state_buf).is_ok());
                    if state_buf.len() <= 32 << 20 {
                        for _ in 0..2 {
                            n += u32::from(session.serialize_into(&mut state_buf).is_ok());
                        }
                    }
                    StateCost { bytes: state_buf.len(), ms: if n > 0 { t.elapsed().as_secs_f64() * 1000.0 / n as f64 } else { 0.0 } }
                };
                crate::info!("save states: {} bytes, {:.2} ms each", c.bytes, c.ms);
                cost = Some(c);
            }
            let c = cost.unwrap_or(StateCost { bytes: 0, ms: 0.0 });
            if rewind.is_none() && play.rewind_enabled {
                if let Some(every) = c.rewind_every() {
                    rewind = Some(Rewind::new(256 << 20, every));
                    since_capture = 0;
                }
            }
            let fps = rewind.as_ref().map(|r| av.timing.fps / r.every as f64).unwrap_or(av.timing.fps).max(1.0);
            shared.text(json!({
                "type": "status",
                "canSave": c.bytes > 0,
                "fps": (stat_frames as f64 / secs * 10.0).round() / 10.0,
                "frameMs": if stat_frames > 0 { (stat_run.as_secs_f64() * 1000.0 / stat_frames as f64 * 100.0).round() / 100.0 } else { 0.0 },
                "audioFillMs": play.rate.fill_ms.round(),
                "audioTargetMs": play.rate.target_ms,
                "dropped": shared.dropped.swap(0, Ordering::Relaxed),
                "late": stat_late,
                "pads": native_count,
                "rewind": {
                    "available": c.rewind_every().is_some(),
                    "on": rewind.is_some(),
                    "seconds": rewind.as_ref().map(|r| (r.len() as f64 / fps * 10.0).round() / 10.0).unwrap_or(0.0),
                    "megabytes": rewind.as_ref().map(|r| r.bytes() >> 20).unwrap_or(0),
                },
                "runahead": {
                    "copies": if session.second_instance() { 2 } else { 1 },
                    "max": c.runahead_max(frame_ms, frame_period.as_secs_f64() * 1000.0),
                    "frames": play.runahead.min(c.runahead_max(frame_ms, frame_period.as_secs_f64() * 1000.0)),
                },
                "stateBytes": c.bytes,
                "stateMs": (c.ms * 100.0).round() / 100.0,
            }));
            (stat_at, stat_frames, stat_run, stat_late) = (Instant::now(), 0, Duration::ZERO, 0);
        }

        // The battery save, every 30 s when it changed (a crash or a forced stop loses at most that);
        // states that didn't reach the host are sent again.
        if sram_at.elapsed() >= Duration::from_secs(30) {
            sram_at = Instant::now();
            if let Some(sync) = session.sync() {
                let shared = shared.clone();
                sync.retry_pending(move |slot, r| {
                    if r.is_ok() {
                        shared.text(json!({ "type": "synced", "slot": slot, "version": r.ok().map(|v| v["version"].clone()) }));
                    }
                });
            }
            let now_hash = session.memory(libretro_sys::RETRO_MEMORY_SAVE_RAM).map(fnv);
            if now_hash != sram_hash {
                sram_hash = now_hash;
                if let Err(e) = session.save_sram() {
                    crate::warn!("couldn't write the battery save: {e}");
                }
            }
        }

        if !(play.ff && play.ff_speed < 1.0) {
            pacer.sleep_until(deadline);
        }
    }

    native.quiet();
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
