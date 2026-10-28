//! The Android player (Phase 7): one game at a time on its own thread. The
//! thread owns the GLES context (android::gles::Screen), the game (Session)
//! and the sound (android::audio::Sound), runs frames at the core's own rate
//! and draws each new picture straight to the game's window. The app (Java,
//! NxEngine) talks to it through `start` and `send`.
//!
//! Speed: frames are paced at the core's declared rate, unless the sound it
//! makes says otherwise (as the PC player does, serve.rs): PPSSPP and Dolphin
//! make game time on their own threads and can hand over several frames of
//! game time per run, so the rate the sound implies is the real one. The
//! sound's writes also wait while its buffer is full (audio sync).
use super::audio::Sound;
use super::gles::{ANativeWindow, Screen};
use crate::host::{self, PortInput};
use crate::session::{Content, Session, SessionConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A window pointer handed to the emulation thread (owned: released by Screen).
pub struct Window(pub *mut ANativeWindow);
// SAFETY: an ANativeWindow reference may be used from any thread.
unsafe impl Send for Window {}

pub enum Cmd {
    /// The game's window was (re)created, or None when it went away.
    Window(Option<Window>),
    Input(usize, PortInput),
    Pause(bool),
    SaveState(PathBuf),
    LoadState(PathBuf),
    Stop,
}

#[derive(Default, Clone, serde::Serialize)]
pub struct Status {
    pub running: bool,
    pub paused: bool,
    pub fps: f32,
    pub error: Option<String>,
    pub core: String,
    pub gpu: Option<String>,
    pub width: u32,
    pub height: u32,
    pub sound: bool,
    pub message: Option<String>,
    /// The rate frames are paced at, and what the core declared.
    pub pace_fps: f32,
    pub declared_fps: f32,
    /// Average time the core takes per frame, and sound queued (ms).
    pub frame_ms: f32,
    pub sound_ms: f32,
}

pub struct Start {
    pub core: PathBuf,
    pub game: PathBuf,
    pub system_dir: PathBuf,
    pub save_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub window: Option<Window>,
}

struct Player {
    tx: Sender<Cmd>,
    status: Arc<Mutex<Status>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

static PLAYER: Mutex<Option<Player>> = Mutex::new(None);

fn lock_player() -> std::sync::MutexGuard<'static, Option<Player>> {
    PLAYER.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts a game (stopping one already running).
pub fn start(s: Start) {
    stop();
    let (tx, rx) = channel();
    let status = Arc::new(Mutex::new(Status { running: true, ..Default::default() }));
    let st = status.clone();
    let thread = std::thread::Builder::new()
        .name("savestate-emu".into())
        // Big cores (Dolphin, PPSSPP) need deep stacks on their emulation thread.
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let result = run(s, rx, &st);
            let mut g = st.lock().unwrap_or_else(|e| e.into_inner());
            g.running = false;
            if let Err(e) = result {
                crate::error!("android: {e}");
                g.error = Some(e);
            }
        })
        .ok();
    *lock_player() = Some(Player { tx, status, thread });
}

pub fn send(cmd: Cmd) {
    if let Some(p) = lock_player().as_ref() {
        let _ = p.tx.send(cmd);
    }
}

pub fn status() -> Status {
    lock_player().as_ref().map(|p| p.status.lock().unwrap_or_else(|e| e.into_inner()).clone()).unwrap_or_default()
}

/// Stops the game (its battery save written) and waits for the thread.
pub fn stop() {
    let player = lock_player().take();
    if let Some(mut p) = player {
        let _ = p.tx.send(Cmd::Stop);
        if let Some(t) = p.thread.take() {
            let _ = t.join();
        }
    }
}

fn set_status(st: &Mutex<Status>, f: impl FnOnce(&mut Status)) {
    f(&mut st.lock().unwrap_or_else(|e| e.into_inner()));
}

fn run(s: Start, rx: Receiver<Cmd>, st: &Mutex<Status>) -> Result<(), String> {
    // The context first: a GPU core asks for it while the game loads.
    let mut screen = Screen::new()?;
    let gpu = screen.description();
    crate::info!("android: {gpu}");
    crate::hw::context_ready(Some(gpu.clone()));
    screen.set_window(s.window.map(|w| w.0));

    let cfg = SessionConfig {
        core: s.core.clone(),
        content: Content::Path(s.game.clone()),
        system_dir: s.system_dir.clone(),
        save_dir: s.save_dir.clone(),
        assets_dir: s.system_dir.join("assets"),
        cache_dir: s.cache_dir.clone(),
        host: None,
        options: HashMap::new(),
        username: "Player".into(),
        stream_content: false,
        sync: None,
    };
    let session = Session::start(cfg);
    let mut session = match session {
        Ok(x) => x,
        Err(e) => {
            crate::hw::context_ready(None);
            return Err(e);
        }
    };
    let core_name = format!("{} {}", session.info.library_name, session.info.library_version);
    let mut sound = match Sound::open() {
        Ok(x) => Some(x),
        Err(e) => {
            crate::warn!("android: no sound: {e}");
            None
        }
    };
    set_status(st, |g| {
        g.core = core_name.clone();
        g.gpu = crate::hw::description().or(Some(gpu.clone()));
        g.sound = sound.is_some();
    });

    let pacer = crate::timing::Pacer::new();
    let mut inputs = [PortInput::default(); host::MAX_PORTS];
    let mut paused = false;
    let mut next = Instant::now();
    let mut audio = Vec::new();
    let mut last_serial = u64::MAX;
    let (mut frames, mut fps_since) = (0u32, Instant::now());
    let mut last_save = Instant::now();
    // The rate the sound implies (see the top of this file): one-second
    // windows after 3 s of settling; a new rate only when two in a row agree.
    let mut period: Option<Duration> = None;
    let (mut win_runs, mut win_samples, mut win_at, mut total_runs) = (0u64, 0u64, Instant::now(), 0u64);
    let mut last_sound_fps: Option<f64> = None;
    let mut run_time = Duration::ZERO;
    let result = 'game: loop {
        // Commands from the app.
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::Window(w) => {
                    screen.set_window(w.map(|w| w.0));
                    last_serial = u64::MAX; // redraw on the new window
                }
                Cmd::Input(port, i) => {
                    if port < inputs.len() {
                        inputs[port] = i;
                    }
                }
                Cmd::Pause(p) => {
                    paused = p;
                    if let Some(s) = sound.as_mut() {
                        s.set_paused(p);
                    }
                    set_status(st, |g| g.paused = p);
                    next = Instant::now();
                    (win_runs, win_samples, win_at) = (0, 0, Instant::now());
                }
                Cmd::SaveState(path) => {
                    let r = session.serialize().and_then(|b| std::fs::write(&path, b).map_err(|e| e.to_string()));
                    set_status(st, |g| g.message = Some(match r { Ok(()) => "Saved".into(), Err(e) => format!("Couldn't save: {e}") }));
                }
                Cmd::LoadState(path) => {
                    let r = std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| session.unserialize(&b));
                    set_status(st, |g| g.message = Some(match r { Ok(()) => "Loaded".into(), Err(e) => format!("Couldn't load: {e}") }));
                }
                Cmd::Stop => break 'game Ok(()),
            }
        }
        if session.shutdown_requested() {
            break Ok(());
        }
        // Nothing to draw on (app in the background), or paused: keep the
        // game where it is.
        if paused || !screen.has_window() {
            std::thread::sleep(Duration::from_millis(30));
            next = Instant::now();
            continue;
        }

        session.set_inputs(&inputs);
        let ran = Instant::now();
        session.run_frame(true);
        run_time += ran.elapsed();
        let av = session.av_info();
        let declared = if av.timing.fps > 1.0 { av.timing.fps } else { 60.0 };
        let aspect = if av.geometry.aspect_ratio > 0.0 { av.geometry.aspect_ratio } else { av.geometry.base_width as f32 / av.geometry.base_height.max(1) as f32 };

        // The picture: from the GPU framebuffer, or the software frame.
        if let Some((fbo, w, h, bottom_up)) = crate::hw::presented() {
            screen.present_framebuffer(fbo, w, h, !bottom_up, aspect, true);
            set_status(st, |g| { g.width = w; g.height = h; });
        } else {
            let h = host::lock();
            let f = &h.frame;
            if !f.hardware && f.serial != last_serial && f.width > 0 && !f.data.is_empty() {
                last_serial = f.serial;
                let format = match f.data_format {
                    crate::video::PixelFormat::Rgb565 | crate::video::PixelFormat::Rgb1555 => 0,
                    crate::video::PixelFormat::Xrgb8888 => 1,
                    crate::video::PixelFormat::Rgba8 => 2,
                };
                let (w, hh) = (f.width, f.height);
                // Copy out so the core isn't held while the GPU uploads.
                let data = f.data.clone();
                drop(h);
                screen.present_pixels(&data, w, hh, format, aspect);
                set_status(st, |g| { g.width = w; g.height = hh; });
            }
        }

        // Sound.
        session.take_audio_into(&mut audio);
        win_runs += 1;
        total_runs += 1;
        win_samples += (audio.len() / 2) as u64;
        if let Some(s) = sound.as_mut() {
            s.push(&audio, av.timing.sample_rate);
        }
        audio.clear();
        if win_at.elapsed() >= Duration::from_secs(1) {
            let settled = total_runs as f64 > declared.max(30.0) * 3.0;
            if settled && win_samples > 0 && av.timing.sample_rate > 1000.0 {
                let sound_fps = av.timing.sample_rate * win_runs as f64 / win_samples as f64;
                let agrees = last_sound_fps.is_some_and(|p| (p - sound_fps).abs() / sound_fps < 0.03);
                last_sound_fps = Some(sound_fps);
                if agrees {
                    let off = (sound_fps - declared).abs() / declared > 0.05 && (3.0..=240.0).contains(&sound_fps);
                    let want = if off { Some(Duration::from_secs_f64(1.0 / sound_fps)) } else { None };
                    if want.map(|d| d.as_micros() / 200) != period.map(|d| d.as_micros() / 200) {
                        crate::info!("android: pacing at {:.2} fps (declared {declared:.2}, sound implies {sound_fps:.2})", want.map(|d| 1.0 / d.as_secs_f64()).unwrap_or(declared));
                        period = want;
                    }
                }
            }
            (win_runs, win_samples, win_at) = (0, 0, Instant::now());
        }

        // Battery saves every 30 s (and on the way out).
        if last_save.elapsed() > Duration::from_secs(30) {
            let _ = session.save_sram();
            last_save = Instant::now();
        }

        frames += 1;
        if fps_since.elapsed() >= Duration::from_secs(1) {
            let fps = frames as f32 / fps_since.elapsed().as_secs_f32();
            let frame_ms = run_time.as_secs_f32() * 1000.0 / frames.max(1) as f32;
            let sound_ms = sound.as_ref().map(|s| s.queued_ms() as f32).unwrap_or(0.0);
            let pace = period.map(|d| 1.0 / d.as_secs_f64()).unwrap_or(declared) as f32;
            set_status(st, |g| { g.fps = fps; g.frame_ms = frame_ms; g.sound_ms = sound_ms; g.pace_fps = pace; g.declared_fps = declared as f32; });
            frames = 0;
            run_time = Duration::ZERO;
            fps_since = Instant::now();
        }

        // Pace at the core's own rate (not the screen's), or the sound's.
        next += period.unwrap_or_else(|| Duration::from_secs_f64(1.0 / declared));
        let now = Instant::now();
        if next + Duration::from_millis(100) < now {
            next = now; // fell far behind (a slow phone): don't race to catch up
        } else {
            pacer.sleep_until(next);
        }
    };
    if let Err(e) = session.save_sram() {
        crate::warn!("android: battery save not written: {e}");
    }
    drop(sound);
    drop(session);
    crate::hw::context_ready(None);
    drop(screen);
    result
}
