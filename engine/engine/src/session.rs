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
}

fn dir_cstring(p: &Path) -> CString {
    CString::new(p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Formats that name other files beside them (tracks, discs); streaming
/// serves one file, so these are downloaded instead.
const MULTI_FILE: &[&str] = &["cue", "gdi", "ccd", "m3u", "toc"];

/// Cores that draw only with the graphics card (no software renderer).
const GPU_ONLY: &[&str] = &["dolphin-emu", "LRPS2", "PCSX2", "PPSSPP", "Citra", "Flycast"];

// What the engine has learned about each core build, in cache/core-caps.json:
//   "vfs": the VFS version it asked for. Some cores ask only inside
//          retro_load_game, after the engine must choose between streaming
//          and downloading, so they download the first time, stream after.
//   "hw":  "asked" the moment it asks for a graphics-card context (so a core
//          that then crashes is known next time), "fallback" once it has
//          loaded a game without one.
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

/// Called from SET_HW_RENDER: remembers that the running core wants the GPU.
pub(crate) fn note_hw_request() {
    let ctx = CAPS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some((dir, key)) = ctx {
        if caps_get(&dir, &key, "hw") != "fallback" {
            caps_set(&dir, &key, "hw", "asked".into());
        }
    }
}

fn needs_gpu_message(name: &str) -> String {
    format!("{name} draws with the graphics card, which this build of SaveState Engine doesn't provide yet")
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
        if GPU_ONLY.contains(&info.library_name.as_str()) || caps_get(&cfg.cache_dir, &key, "hw") == "asked" {
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
        let mut session = Session { core, info, content_path: None, streamed: false, bios: bios::Report::default(), _data: None, sram_path: None, frames: 0, last_frame_at: None, deinit_done: false };
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
        let (vfs_version, hw_requested) = {
            let h = host::lock();
            (h.vfs_version, h.hw_requested)
        };
        if !ok {
            if hw_requested.is_some() {
                return Err(needs_gpu_message(&info.library_name));
            }
            return Err(format!("{} couldn't load this game{}", info.library_name, if self.streamed { " (streamed)" } else { "" }));
        }
        let key = core_key(&info);
        if vfs_version >= 1 && caps_get(&cfg.cache_dir, &key, "vfs").as_u64() != Some(vfs_version as u64) {
            caps_set(&cfg.cache_dir, &key, "vfs", vfs_version.into());
        }
        if hw_requested.is_some() {
            // It asked for the GPU, was told no, and loaded anyway: it has a software renderer.
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

    pub fn shutdown_requested(&self) -> bool {
        host::lock().shutdown_requested
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

    /// Writes the battery save (to a temporary file, then renamed into place).
    pub fn save_sram(&self) -> Result<Option<PathBuf>, String> {
        let (Some(path), Some(mem)) = (&self.sram_path, self.memory(RETRO_MEMORY_SAVE_RAM)) else { return Ok(None) };
        let tmp = path.with_extension("srm.tmp");
        std::fs::write(&tmp, mem).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(Some(path.clone()))
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
                unsafe { (self.core.unload_game)() };
            }
            unsafe { (self.core.deinit)() };
            self.deinit_done = true;
        }
        ACTIVE.store(false, Ordering::SeqCst);
    }
}
