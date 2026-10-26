//! The Android player (Phase 7): one game at a time on its own thread. The
//! thread owns the GLES context (android::gles::Screen), the game (Session)
//! and the sound (android::audio::Sound), runs frames at the core's own rate
//! and draws each new picture straight to the game's window. The app (Java,
//! NxEngine) talks to it through `start` and `send`.
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
        session.run_frame(true);
        let av = session.av_info();
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
        if let Some(s) = sound.as_mut() {
            s.push(&audio, av.timing.sample_rate);
        }
        audio.clear();

        // Battery saves every 30 s (and on the way out).
        if last_save.elapsed() > Duration::from_secs(30) {
            let _ = session.save_sram();
            last_save = Instant::now();
        }

        frames += 1;
        if fps_since.elapsed() >= Duration::from_secs(1) {
            let fps = frames as f32 / fps_since.elapsed().as_secs_f32();
            set_status(st, |g| g.fps = fps);
            frames = 0;
            fps_since = Instant::now();
        }

        // Pace at the core's own rate (not the screen's).
        let fps = if av.timing.fps > 1.0 { av.timing.fps } else { 60.0 };
        next += Duration::from_secs_f64(1.0 / fps);
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
