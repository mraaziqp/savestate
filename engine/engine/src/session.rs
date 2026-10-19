//! One game: load the core and the content, run frames, save and restore.
//!
//! Content can be a local file or a game on the SaveState host (a URL). A
//! core that asked for the VFS and opens the file itself streams it in
//! blocks (vfs.rs); any other core gets it downloaded through the same block
//! cache first. Zip files are opened for cores that can't read them. Battery
//! saves (SRAM) are loaded before the first frame and written atomically.
use crate::bios;
use crate::host::{self, Dirs, GameInfoExt, PortInput};
use crate::loader::{Core, SystemInfo};
use crate::options::{curated, Options};
use crate::vfs;
use libretro_sys::*;
use std::collections::HashMap;
use std::ffi::{c_void, CString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

static ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug)]
pub enum Content {
    /// The core runs without a game (support_no_game).
    None,
    Path(PathBuf),
    /// A game on the host; `file_name` keeps the real extension.
    Url { url: String, file_name: String },
}

#[derive(Clone)]
pub struct SessionConfig {
    pub core: PathBuf,
    pub content: Content,
    pub system_dir: PathBuf,
    pub save_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// The SaveState host for BIOS files and streamed games.
    pub host: Option<bios::Host>,
    /// Core option values on top of the curated ones.
    pub options: HashMap<String, String>,
    pub username: String,
    /// Stream big games through the VFS when the core supports it.
    pub stream_content: bool,
    /// The host's copy of this game's saves (battery saves follow the person).
    pub sync: Option<std::sync::Arc<crate::sync::Sync>>,
}

pub struct Session {
    core: Core,
    pub info: SystemInfo,
    /// The content as loaded (local path, or the URL when streamed).
    pub content_path: Option<String>,
    pub streamed: bool,
    pub bios: bios::Report,
    /// Kept alive while the core may read it (cores without need_fullpath).
    _data: Option<Vec<u8>>,
    sram_path: Option<PathBuf>,
    pub frames: u64,
    last_frame_at: Option<Instant>,
    deinit_done: bool,
    /// The GPU picture's buffer, swapped with the frame's (no copy per frame).
    gpu_pixels: Vec<u8>,
    sync: Option<std::sync::Arc<crate::sync::Sync>>,
    /// The content as handed to retro_load_game (a second instance loads it too).
    content_cpath: Option<CString>,
    /// A second instance of the core for run-ahead (see `start_second_instance`).
    secondary: Option<Secondary>,
    keep_loaded: bool,
}

/// The second instance: its own copy of the DLL (its own globals) and its own host state.
struct Secondary {
    core: Core,
    host: Box<host::HostState>,
}

fn dir_cstring(p: &Path) -> CString {
    CString::new(p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Formats that name other files beside them (tracks, discs); streaming
/// serves one file, so these are downloaded instead.
const MULTI_FILE: &[&str] = &["cue", "gdi", "ccd", "m3u", "toc"];

// What the engine has learned about each core build, in cache/core-caps.json:
//   "vfs": the VFS version it asked for. Some cores ask only inside
//          retro_load_game, after the engine must choose between streaming
//          and downloading, so they download the first time, stream after.
//   "hw":  "refused" the moment the engine turns down a graphics context the
//          core asked for (Vulkan, Direct3D), so a core that then crashes is
//          known next time; "gl" once it has loaded with an OpenGL context,
//          "fallback" once it has loaded without one.
static CAPS: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);

fn caps_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("core-caps.json")
}

fn core_key(info: &SystemInfo) -> String {
    format!("{} {}", info.library_name, info.library_version)
}

fn caps_all(cache_dir: &Path) -> serde_json::Value {
    std::fs::read(caps_path(cache_dir)).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}))
}

fn caps_get(cache_dir: &Path, key: &str, field: &str) -> serde_json::Value {
    caps_all(cache_dir).get(key).and_then(|c| c.get(field)).cloned().unwrap_or(serde_json::Value::Null)
}

fn caps_set(cache_dir: &Path, key: &str, field: &str, value: serde_json::Value) {
    let path = caps_path(cache_dir);
    let mut all = caps_all(cache_dir);
    if !all[key].is_object() {
        all[key] = serde_json::json!({});
    }
    all[key][field] = value;
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, all.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Called from SET_HW_RENDER when the engine can't provide what was asked.
pub(crate) fn note_hw_refused() {
    let ctx = CAPS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some((dir, key)) = ctx {
        let known = caps_get(&dir, &key, "hw");
        if known != "gl" && known != "fallback" {
            caps_set(&dir, &key, "hw", "refused".into());
        }
    }
}

fn needs_gpu_message(name: &str) -> String {
    format!("{name} needs a Vulkan or Direct3D graphics context, which SaveState Engine doesn't provide (it provides OpenGL)")
}

fn extension_of(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// The game file inside a zip for a core that can't open zips: the entry whose
/// extension the core lists (largest first), extracted to `into`.
fn extract_zip(zip_path: &Path, wanted: &[String], into: &Path) -> Result<PathBuf, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a readable zip: {e}"))?;
    let mut best: Option<(usize, u64, String)> = None;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if wanted.contains(&extension_of(&name)) && best.as_ref().map(|b| entry.size() > b.1).unwrap_or(true) {
            best = Some((i, entry.size(), name));
        }
    }
    let (index, size, name) = best.ok_or("the zip has no file this core can play")?;
    let out = into.join(Path::new(&name).file_name().ok_or("bad name in zip")?);
    if std::fs::metadata(&out).map(|m| m.len() == size).unwrap_or(false) {
        return Ok(out);
    }
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
    let tmp = out.with_extension("part");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out)
}

impl Session {
    pub fn start(cfg: SessionConfig) -> Result<Self, String> {
        if ACTIVE.swap(true, Ordering::SeqCst) {
            return Err("a game is already running in this engine process".into());
        }
        match Self::start_inner(cfg) {
            Ok(s) => Ok(s),
            Err(e) => {
                ACTIVE.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    fn start_inner(cfg: SessionConfig) -> Result<Self, String> {
        for d in [&cfg.system_dir, &cfg.save_dir, &cfg.assets_dir, &cfg.cache_dir] {
            std::fs::create_dir_all(d).map_err(|e| format!("can't create {}: {e}", d.display()))?;
        }
        vfs::configure(vfs::VfsConfig { token: cfg.host.as_ref().and_then(|h| h.token.clone()), cache_dir: Some(cfg.cache_dir.join("stream")), remote_allowed: Vec::new() });

        let core = Core::load(&cfg.core)?;
        let info = core.system_info();
        let key = core_key(&info);
        if caps_get(&cfg.cache_dir, &key, "hw") == "refused" {
            return Err(needs_gpu_message(&info.library_name));
        }
        *CAPS.lock().unwrap_or_else(|e| e.into_inner()) = Some((cfg.cache_dir.clone(), key));
        let mut wanted = curated(&info.library_name);
        wanted.extend(cfg.options.clone());
        host::reset(
            Options::new(wanted),
            Dirs {
                system: dir_cstring(&cfg.system_dir),
                save: dir_cstring(&cfg.save_dir),
                assets: dir_cstring(&cfg.assets_dir),
                core_path: dir_cstring(&cfg.core),
                username: CString::new(cfg.username.clone()).unwrap_or_default(),
            },
        );

        unsafe {
            (core.set_environment)(crate::env::environment);
            (core.set_video_refresh)(host::video_refresh);
            (core.set_audio_sample)(host::audio_sample);
            (core.set_audio_sample_batch)(host::audio_sample_batch);
            (core.set_input_poll)(host::input_poll);
            (core.set_input_state)(host::input_state);
            (core.init)();
        }
        let mut session = Session { core, info, content_path: None, streamed: false, bios: bios::Report::default(), _data: None, sram_path: None, frames: 0, last_frame_at: None, deinit_done: false, gpu_pixels: Vec::new(), sync: cfg.sync.clone(), content_cpath: None, secondary: None, keep_loaded: false };
        if let Err(e) = session.load_content(&cfg) {
            // Dropping `session` runs retro_deinit and unloads the core.
            return Err(e);
        }
        Ok(session)
    }

    fn load_content(&mut self, cfg: &SessionConfig) -> Result<(), String> {
        let info = self.info.clone();
        // Where the game file is, as a local path or (streamed) a URL.
        let (mut path, file_name): (Option<String>, Option<String>) = match &cfg.content {
            Content::None => (None, None),
            Content::Path(p) => (Some(p.to_string_lossy().into_owned()), p.file_name().map(|n| n.to_string_lossy().into_owned())),
            Content::Url { url, file_name } => (Some(url.clone()), Some(file_name.clone())),
        };
        let ext = file_name.as_deref().map(extension_of).unwrap_or_default();
        let override_ = {
            let h = host::lock();
            h.content_overrides.iter().find(|o| o.extensions.contains(&ext)).map(|o| (o.need_fullpath, o.persistent_data))
        };
        let need_fullpath = override_.map(|o| o.0).unwrap_or(info.need_fullpath);
        let core_reads_zip = info.valid_extensions.iter().any(|e| e == "zip" || e == "7z") || info.block_extract;

        if let (Some(p), Some(name)) = (path.clone(), file_name.clone()) {
            if vfs::is_remote(&p) {
                let vfs_ok = host::lock().vfs_version >= 1 || caps_get(&cfg.cache_dir, &core_key(&info), "vfs").as_u64().is_some_and(|v| v >= 1);
                if cfg.stream_content && vfs_ok && need_fullpath && (ext != "zip" || core_reads_zip) && !MULTI_FILE.contains(&ext.as_str()) {
                    self.streamed = true;
                    vfs::allow_remote(&p);
                    path = Some(vfs::core_path(&p));
                } else {
                    let local = cfg.cache_dir.join("content").join(&name);
                    std::fs::create_dir_all(local.parent().unwrap_or(&cfg.cache_dir)).map_err(|e| e.to_string())?;
                    let fresh = vfs::remote(&p).map(|f| f.lock().unwrap_or_else(|e| e.into_inner()).size).ok();
                    if std::fs::metadata(&local).map(|m| Some(m.len()) != fresh).unwrap_or(true) {
                        let mut last = Instant::now();
                        vfs::download(&p, &local, |done, total| {
                            if last.elapsed().as_millis() > 1000 {
                                last = Instant::now();
                                crate::info!("downloading the game: {:.0}%", done as f64 * 100.0 / total.max(1) as f64);
                            }
                        })?;
                    }
                    path = Some(local.to_string_lossy().into_owned());
                }
            }
            if !self.streamed && ext == "zip" && !core_reads_zip {
                let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let extracted = extract_zip(Path::new(path.as_deref().unwrap_or_default()), &info.valid_extensions, &cfg.cache_dir.join("extract").join(stem))?;
                path = Some(extracted.to_string_lossy().into_owned());
            }
        }

        // System files, before the core looks for them.
        let content_dir = path.as_deref().filter(|p| !vfs::is_remote(p)).and_then(|p| Path::new(p).parent().map(Path::to_path_buf));
        self.bios = bios::ensure(&info.library_name, &cfg.system_dir, content_dir.as_deref(), cfg.host.as_ref());
        if let Some(msg) = self.bios.blocking() {
            return Err(msg);
        }

        let c_path = path.as_deref().map(|p| CString::new(p).unwrap_or_default());
        if path.is_some() && !need_fullpath {
            let p = path.as_deref().unwrap_or_default();
            let mut data = Vec::new();
            std::fs::File::open(p).and_then(|mut f| f.read_to_end(&mut data)).map_err(|e| format!("can't read the game file: {e}"))?;
            self._data = Some(data);
        }
        let (data_ptr, data_len) = match &self._data {
            Some(d) => (d.as_ptr() as *const c_void, d.len()),
            None => (std::ptr::null(), 0),
        };

        // GET_GAME_INFO_EXT: the same content, described in full.
        if let Some(p) = &path {
            let pp = Path::new(p);
            let full = CString::new(p.as_str()).unwrap_or_default();
            let dir = CString::new(pp.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()).unwrap_or_default();
            let name = CString::new(pp.file_stem().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()).unwrap_or_default();
            let ext_c = CString::new(extension_of(p)).unwrap_or_default();
            let info_ext = retro_game_info_ext {
                // Always the file's path (libretro.h: valid whenever the file isn't in an archive).
                full_path: full.as_ptr(),
                archive_path: std::ptr::null(),
                archive_file: std::ptr::null(),
                dir: dir.as_ptr(),
                name: name.as_ptr(),
                ext: ext_c.as_ptr(),
                meta: std::ptr::null(),
                data: data_ptr,
                size: data_len,
                file_in_archive: false,
                persistent_data: self._data.is_some(),
            };
            host::lock().game_info_ext = Some(GameInfoExt { strings: vec![full, dir, name, ext_c], info: info_ext });
        }

        let ok = unsafe {
            match &c_path {
                Some(cp) => {
                    let game = retro_game_info { path: cp.as_ptr(), data: data_ptr, size: data_len, meta: std::ptr::null() };
                    (self.core.load_game)(&game)
                }
                None => {
                    if !host::lock().support_no_game {
                        return Err("this core needs a game".into());
                    }
                    (self.core.load_game)(std::ptr::null())
                }
            }
        };
        let (vfs_version, hw_requested, hw_granted) = {
            let h = host::lock();
            (h.vfs_version, h.hw_requested, h.hw_granted)
        };
        self.content_cpath = c_path.clone();
        if !ok {
            if hw_requested.is_some() && !hw_granted {
                return Err(needs_gpu_message(&info.library_name));
            }
            return Err(format!("{} couldn't load this game{}", info.library_name, if self.streamed { " (streamed)" } else { "" }));
        }
        let key = core_key(&info);
        if vfs_version >= 1 && caps_get(&cfg.cache_dir, &key, "vfs").as_u64() != Some(vfs_version as u64) {
            caps_set(&cfg.cache_dir, &key, "vfs", vfs_version.into());
        }
        if hw_granted {
            caps_set(&cfg.cache_dir, &key, "hw", "gl".into());
        } else if hw_requested.is_some() {
            // It asked for a context it didn't get and loaded anyway: it has a software renderer.
            caps_set(&cfg.cache_dir, &key, "hw", "fallback".into());
        }
        self.content_path = path.clone();

        let mut av = retro_system_av_info::default();
        unsafe { (self.core.get_system_av_info)(&mut av) };
        {
            let mut h = host::lock();
            h.av = av;
            h.av_changed = true;
        }
        // A GPU core: its framebuffer, then context_reset (after load, as RetroArch does).
        crate::hw::start(av.geometry.max_width.max(av.geometry.base_width), av.geometry.max_height.max(av.geometry.base_height))?;
        unsafe {
            for port in 0..2 {
                (self.core.set_controller_port_device)(port, RETRO_DEVICE_JOYPAD);
            }
        }
        let set_state = host::lock().audio_callback.and_then(|a| a.1);
        if let Some(set_state) = set_state {
            unsafe { set_state(true) };
        }

        // Battery save for this game, next to the others.
        if let Some(name) = file_name {
            let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(name);
            let sram = cfg.save_dir.join(format!("{stem}.srm"));
            if let Some(sync) = &cfg.sync {
                let _ = std::fs::create_dir_all(&cfg.save_dir);
                crate::info!("battery save: {}", sync.pull_sram(&sram));
            }
            if let Ok(bytes) = std::fs::read(&sram) {
                self.write_memory(RETRO_MEMORY_SAVE_RAM, &bytes);
            }
            self.sram_path = Some(sram);
        }
        Ok(())
    }

    pub fn av_info(&self) -> retro_system_av_info {
        host::lock().av
    }

    /// Runs one frame. `real_time`: pass real elapsed time to cores that ask
    /// (frame-time callback); otherwise the ideal frame time (headless runs).
    pub fn run_frame(&mut self, real_time: bool) {
        let (frame_time, audio_cb) = {
            let h = host::lock();
            (h.frame_time, h.audio_callback.map(|a| a.0))
        };
        if let Some(ft) = frame_time {
            let now = Instant::now();
            let usec = match (real_time, self.last_frame_at) {
                (true, Some(prev)) => now.duration_since(prev).as_micros() as retro_usec_t,
                _ => ft.reference,
            };
            self.last_frame_at = Some(now);
            unsafe { (ft.callback)(usec) };
        }
        if let Some(cb) = audio_cb {
            unsafe { cb() };
        }
        unsafe { (self.core.run)() };
        self.frames += 1;
    }

    /// Run-ahead: runs one real frame, then `ahead` more and takes the
    /// picture from the last of those, then goes back to just after the real
    /// frame. The game shows the result of the newest input `ahead` frames
    /// sooner, which removes that many frames of the game's own input lag.
    /// The real frame's sound is kept; the hidden frames' sound and pictures
    /// are not (GET_AUDIO_VIDEO_ENABLE tells the core so it can skip work).
    /// `state` receives the state after the real frame (rewind reuses it).
    pub fn run_frame_ahead(&mut self, ahead: u32, real_time: bool, state: &mut Vec<u8>) -> Result<(), String> {
        if ahead == 0 {
            self.run_frame(real_time);
            return Ok(());
        }
        if let Some(mut sec) = self.secondary.take() {
            let r = self.run_ahead_second(&mut sec, ahead, real_time, state);
            self.secondary = Some(sec);
            return r;
        }
        // Bits: 1 picture, 2 sound, 4 fast save states (a run-ahead save), 8 sound hard off.
        let set = |av: i32, ctx: i32| {
            let mut h = host::lock();
            h.av_enable = av;
            h.savestate_context = ctx;
        };
        set(2 | 4, RETRO_SAVESTATE_CONTEXT_RUNAHEAD_SAME_INSTANCE);
        self.run_frame(real_time);
        let saved = self.serialize_into(state);
        if saved.is_ok() {
            for i in 0..ahead {
                set(if i + 1 == ahead { 1 | 4 | 8 } else { 4 | 8 }, RETRO_SAVESTATE_CONTEXT_RUNAHEAD_SAME_INSTANCE);
                self.run_frame(false);
            }
            // Bring the last hidden frame's picture over before the GPU state is replaced.
            self.finish_frame(50_000);
            set(4 | 8, RETRO_SAVESTATE_CONTEXT_RUNAHEAD_SAME_INSTANCE);
        }
        let restored = if saved.is_ok() { self.unserialize(state) } else { Ok(()) };
        set(3, RETRO_SAVESTATE_CONTEXT_NORMAL);
        saved.and(restored)
    }

    /// Run-ahead on two instances: this one plays the real frame (sound, no
    /// picture) and is never rewound; its state goes to the second instance,
    /// which runs the hidden frames and supplies the picture.
    fn run_ahead_second(&mut self, sec: &mut Secondary, ahead: u32, real_time: bool, state: &mut Vec<u8>) -> Result<(), String> {
        host::lock().av_enable = 2;
        self.run_frame(real_time);
        host::lock().av_enable = 3;
        // Not marked as a "fast save state" (bit 4): measured, mGBA's Game Boy
        // sound stops matching when it is.
        host::lock().savestate_context = RETRO_SAVESTATE_CONTEXT_RUNAHEAD_SAME_BINARY;
        let saved = self.serialize_into(state);
        host::lock().savestate_context = RETRO_SAVESTATE_CONTEXT_NORMAL;
        saved?;
        let input = host::lock().input;
        sec.host.input = input;
        sec.host.savestate_context = RETRO_SAVESTATE_CONTEXT_RUNAHEAD_SAME_BINARY;
        host::swap(&mut sec.host);
        let loaded = unsafe { (sec.core.unserialize)(state.as_ptr() as *const c_void, state.len()) };
        if loaded {
            let frame_time = host::lock().frame_time;
            for i in 0..ahead {
                host::lock().av_enable = if i + 1 == ahead { 1 | 4 | 8 } else { 4 | 8 };
                if let Some(ft) = frame_time {
                    unsafe { (ft.callback)(ft.reference) };
                }
                unsafe { (sec.core.run)() };
            }
            host::lock().audio.clear();
        }
        host::swap(&mut sec.host);
        if !loaded {
            return Err("the second instance refused the state".into());
        }
        // The second instance's picture is the one to show.
        let mut h = host::lock();
        if sec.host.frame.serial != 0 {
            let next = h.frame.serial.max(sec.host.frame.serial) + 1;
            std::mem::swap(&mut h.frame, &mut sec.host.frame);
            h.frame.serial = next;
            sec.host.frame.serial = 0;
        }
        Ok(())
    }

    /// A save state into `buf` (reused: no allocation once it's big enough).
    pub fn serialize_into(&self, buf: &mut Vec<u8>) -> Result<(), String> {
        let size = unsafe { (self.core.serialize_size)() };
        if size == 0 {
            return Err(format!("{} can't save states", self.info.library_name));
        }
        buf.resize(size, 0);
        if unsafe { (self.core.serialize)(buf.as_mut_ptr() as *mut c_void, size) } {
            Ok(())
        } else {
            Err("the core refused to save its state".into())
        }
    }

    /// Sets every port's input at once (one lock).
    pub fn set_inputs(&self, inputs: &[PortInput]) {
        let mut h = host::lock();
        for (port, input) in inputs.iter().enumerate().take(host::MAX_PORTS) {
            h.input[port] = *input;
        }
    }

    /// Each port's rumble motors (strong, weak), as the game last set them.
    pub fn rumble(&self) -> [[u16; 2]; host::MAX_PORTS] {
        host::lock().rumble
    }

    /// For a GPU core, brings the frame just presented from the graphics card
    /// into `host::lock().frame`, waiting up to `wait_us`. True when the frame
    /// is in place (always true for software cores).
    pub fn finish_frame(&mut self, wait_us: u64) -> bool {
        if !crate::hw::pending() {
            return true;
        }
        match crate::hw::collect(&mut self.gpu_pixels, wait_us) {
            Some((w, h, bottom_up)) => {
                host::lock().frame.take_gpu_pixels(&mut self.gpu_pixels, w, h, bottom_up);
                true
            }
            None => false,
        }
    }

    /// Keep the core's DLL loaded after the session ends (see `Core::keep_loaded`).
    pub fn keep_core_loaded(&mut self) {
        self.core.keep_loaded();
        self.keep_loaded = true;
    }

    /// Starts a second instance of the core for run-ahead: a copy of the DLL
    /// (so its own globals) with its own host state, the same game and the
    /// same options. With it, run-ahead plays the real frame on this instance
    /// and never rewinds it, and runs the hidden frames on the second one, so
    /// cores that keep sound outside their save states (mGBA, FinalBurn Neo)
    /// sound exactly as without run-ahead. Not for GPU cores (one GL context).
    pub fn start_second_instance(&mut self) -> Result<(), String> {
        if self.secondary.is_some() {
            return Ok(());
        }
        if crate::hw::active() {
            return Err("games drawn with the graphics card use single-copy run-ahead".into());
        }
        let core = Core::load_copy(&self.core.path, "runahead")?;
        let mut st = {
            let h = host::lock();
            let mut st = host::HostState::new();
            st.options = Options::new(h.options.current().clone());
            st.dirs = h.dirs.clone();
            st.frame.format = h.frame.format;
            st.content_overrides = h.content_overrides.iter().map(|o| host::ContentOverride { extensions: o.extensions.clone(), need_fullpath: o.need_fullpath, persistent_data: o.persistent_data }).collect();
            st.game_info_ext = h.game_info_ext.as_ref().map(host::GameInfoExt::duplicate);
            st
        };
        let (data_ptr, data_len) = match &self._data {
            Some(d) => (d.as_ptr() as *const c_void, d.len()),
            None => (std::ptr::null(), 0),
        };
        let path = self.content_cpath.as_ref().map(|p| p.as_ptr()).unwrap_or(std::ptr::null());
        host::swap(&mut st);
        let loaded = unsafe {
            (core.set_environment)(crate::env::environment);
            (core.set_video_refresh)(host::video_refresh);
            (core.set_audio_sample)(host::audio_sample);
            (core.set_audio_sample_batch)(host::audio_sample_batch);
            (core.set_input_poll)(host::input_poll);
            (core.set_input_state)(host::input_state);
            (core.init)();
            let game = retro_game_info { path, data: data_ptr, size: data_len, meta: std::ptr::null() };
            let ok = (core.load_game)(if path.is_null() && data_ptr.is_null() { std::ptr::null() } else { &game });
            if ok {
                for port in 0..2 {
                    (core.set_controller_port_device)(port, RETRO_DEVICE_JOYPAD);
                }
            } else {
                (core.deinit)();
            }
            ok
        };
        host::swap(&mut st);
        if !loaded {
            return Err("the second copy of the core wouldn't load the game".into());
        }
        crate::info!("run-ahead: second instance of {} started", self.info.library_name);
        self.secondary = Some(Secondary { core, host: Box::new(st) });
        Ok(())
    }

    /// Run-ahead uses a second instance (exact sound) rather than one.
    pub fn second_instance(&self) -> bool {
        self.secondary.is_some()
    }

    /// Sets a core option on every instance.
    pub fn set_option(&mut self, key: &str, value: &str) {
        host::lock().options.set(key, value);
        if let Some(sec) = self.secondary.as_mut() {
            sec.host.options.set(key, value);
        }
    }

    /// The core draws with the graphics card.
    pub fn uses_gpu(&self) -> bool {
        crate::hw::active()
    }

    pub fn reset(&mut self) {
        unsafe { (self.core.reset)() };
    }

    pub fn set_input(&self, port: usize, input: PortInput) {
        if port < host::MAX_PORTS {
            host::lock().input[port] = input;
        }
    }

    /// Interleaved stereo samples since the last call.
    pub fn take_audio(&self) -> Vec<i16> {
        std::mem::take(&mut host::lock().audio)
    }

    /// Moves the samples since the last call into `out` (cleared first),
    /// reusing both buffers: no allocation per frame.
    pub fn take_audio_into(&self, out: &mut Vec<i16>) {
        out.clear();
        std::mem::swap(&mut host::lock().audio, out);
    }

    pub fn shutdown_requested(&self) -> bool {
        host::lock().shutdown_requested
    }

    /// Bytes a save state needs (0: the core can't save states).
    pub fn serialize_size(&self) -> usize {
        unsafe { (self.core.serialize_size)() }
    }

    /// A save state of the game right now.
    pub fn serialize(&self) -> Result<Vec<u8>, String> {
        let size = unsafe { (self.core.serialize_size)() };
        if size == 0 {
            return Err(format!("{} can't save states", self.info.library_name));
        }
        let mut buf = vec![0u8; size];
        if unsafe { (self.core.serialize)(buf.as_mut_ptr() as *mut c_void, size) } {
            Ok(buf)
        } else {
            Err("the core refused to save its state".into())
        }
    }

    pub fn unserialize(&self, state: &[u8]) -> Result<(), String> {
        if unsafe { (self.core.unserialize)(state.as_ptr() as *const c_void, state.len()) } {
            Ok(())
        } else {
            Err("the core refused that state".into())
        }
    }

    pub fn memory(&self, id: u32) -> Option<&[u8]> {
        unsafe {
            let p = (self.core.get_memory_data)(id);
            let n = (self.core.get_memory_size)(id);
            if p.is_null() || n == 0 { None } else { Some(std::slice::from_raw_parts(p as *const u8, n)) }
        }
    }

    fn write_memory(&self, id: u32, bytes: &[u8]) {
        unsafe {
            let p = (self.core.get_memory_data)(id);
            let n = (self.core.get_memory_size)(id);
            if !p.is_null() && n > 0 {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, n.min(bytes.len()));
            }
        }
    }

    /// Writes the battery save (to a temporary file, then renamed into place)
    /// and sends it to the host in the background when it changed.
    pub fn save_sram(&self) -> Result<Option<PathBuf>, String> {
        let (Some(path), Some(mem)) = (&self.sram_path, self.memory(RETRO_MEMORY_SAVE_RAM)) else { return Ok(None) };
        let tmp = path.with_extension("srm.tmp");
        std::fs::write(&tmp, mem).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        if let Some(sync) = &self.sync {
            sync.push_sram(mem);
        }
        Ok(Some(path.clone()))
    }

    /// The host link, for save states.
    pub fn sync(&self) -> Option<std::sync::Arc<crate::sync::Sync>> {
        self.sync.clone()
    }

    /// Disk control: how many images, and which is inserted.
    pub fn disks(&self) -> Option<(u32, u32)> {
        let d = host::lock().disk?;
        unsafe { Some((d.get_num_images.map(|f| f()).unwrap_or(0), d.get_image_index.map(|f| f()).unwrap_or(0))) }
    }

    pub fn core_path(&self) -> &Path {
        &self.core.path
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if !self.deinit_done {
            if self.content_path.is_some() {
                if let Err(e) = self.save_sram() {
                    crate::warn!("couldn't write the battery save: {e}");
                }
                // Closing: send it up now rather than on a thread the process may not wait for.
                if let (Some(sync), Some(mem)) = (&self.sync, self.memory(RETRO_MEMORY_SAVE_RAM)) {
                    sync.push_sram_now(mem);
                }
                crate::hw::notify_destroy();
                unsafe { (self.core.unload_game)() };
            }
            unsafe { (self.core.deinit)() };
            self.deinit_done = true;
        }
        if let Some(mut sec) = self.secondary.take() {
            host::swap(&mut sec.host);
            unsafe {
                (sec.core.unload_game)();
                (sec.core.deinit)();
            }
            host::swap(&mut sec.host);
            if self.keep_loaded {
                sec.core.keep_loaded();
            }
        }
        crate::hw::destroy_context();
        ACTIVE.store(false, Ordering::SeqCst);
    }
}
