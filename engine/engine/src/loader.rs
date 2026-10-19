//! Loading a core: the DLL, its 25 entry points, and its API version.
//!
//! Dropping a `Core` unloads the DLL (`FreeLibrary`), which is why one game
//! runs per engine process: a core's global state is only truly gone when its
//! process ends. `load_copy` loads a second, independent instance by copying
//! the DLL to a new name (Windows loads a DLL once per path); run-ahead uses it.
use libloading::Library;
use libretro_sys::*;
use std::ffi::{c_uint, CStr};
use std::path::{Path, PathBuf};

pub struct Core {
    pub path: PathBuf,
    /// A temporary copy made by `load_copy`, deleted on drop.
    copy: Option<PathBuf>,
    pub set_environment: retro_set_environment_fn,
    pub set_video_refresh: retro_set_video_refresh_fn,
    pub set_audio_sample: retro_set_audio_sample_fn,
    pub set_audio_sample_batch: retro_set_audio_sample_batch_fn,
    pub set_input_poll: retro_set_input_poll_fn,
    pub set_input_state: retro_set_input_state_fn,
    pub init: retro_init_fn,
    pub deinit: retro_deinit_fn,
    pub api_version: retro_api_version_fn,
    pub get_system_info: retro_get_system_info_fn,
    pub get_system_av_info: retro_get_system_av_info_fn,
    pub set_controller_port_device: retro_set_controller_port_device_fn,
    pub reset: retro_reset_fn,
    pub run: retro_run_fn,
    pub serialize_size: retro_serialize_size_fn,
    pub serialize: retro_serialize_fn,
    pub unserialize: retro_unserialize_fn,
    pub cheat_reset: retro_cheat_reset_fn,
    pub cheat_set: retro_cheat_set_fn,
    pub load_game: retro_load_game_fn,
    pub load_game_special: retro_load_game_special_fn,
    pub unload_game: retro_unload_game_fn,
    pub get_region: retro_get_region_fn,
    pub get_memory_data: retro_get_memory_data_fn,
    pub get_memory_size: retro_get_memory_size_fn,
    // Last: dropped after the function pointers above are no longer used.
    library: Option<Library>,
}

/// What `retro_get_system_info` reported, copied out of the core's memory.
#[derive(Clone, Debug)]
pub struct SystemInfo {
    pub library_name: String,
    pub library_version: String,
    /// Lower-case extensions without dots.
    pub valid_extensions: Vec<String>,
    pub need_fullpath: bool,
    pub block_extract: bool,
}

macro_rules! sym {
    ($lib:expr, $name:literal) => {{
        // SAFETY: the symbol has the type libretro.h gives it.
        let s = unsafe { $lib.get($name) }.map_err(|_| format!("the core has no {}", String::from_utf8_lossy(&$name[..$name.len() - 1])))?;
        *s
    }};
}

impl Core {
    pub fn load(path: &Path) -> Result<Self, String> {
        Self::open(path, None)
    }

    /// A second, independent instance of the same core (its own globals).
    pub fn load_copy(path: &Path, tag: &str) -> Result<Self, String> {
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "core".into());
        let ext = path.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "dll".into());
        let copy = std::env::temp_dir().join(format!("{stem}.{tag}.{}.{ext}", std::process::id()));
        std::fs::copy(path, &copy).map_err(|e| format!("couldn't copy the core: {e}"))?;
        Self::open(&copy, Some(copy.clone()))
    }

    fn open(path: &Path, copy: Option<PathBuf>) -> Result<Self, String> {
        // SAFETY: loading a core runs its DLL initialisers; that is the point.
        let lib = unsafe { Library::new(path) }.map_err(|e| format!("couldn't load {}: {e}", path.display()))?;
        let core = Core {
            path: path.to_path_buf(),
            copy,
            set_environment: sym!(lib, b"retro_set_environment\0"),
            set_video_refresh: sym!(lib, b"retro_set_video_refresh\0"),
            set_audio_sample: sym!(lib, b"retro_set_audio_sample\0"),
            set_audio_sample_batch: sym!(lib, b"retro_set_audio_sample_batch\0"),
            set_input_poll: sym!(lib, b"retro_set_input_poll\0"),
            set_input_state: sym!(lib, b"retro_set_input_state\0"),
            init: sym!(lib, b"retro_init\0"),
            deinit: sym!(lib, b"retro_deinit\0"),
            api_version: sym!(lib, b"retro_api_version\0"),
            get_system_info: sym!(lib, b"retro_get_system_info\0"),
            get_system_av_info: sym!(lib, b"retro_get_system_av_info\0"),
            set_controller_port_device: sym!(lib, b"retro_set_controller_port_device\0"),
            reset: sym!(lib, b"retro_reset\0"),
            run: sym!(lib, b"retro_run\0"),
            serialize_size: sym!(lib, b"retro_serialize_size\0"),
            serialize: sym!(lib, b"retro_serialize\0"),
            unserialize: sym!(lib, b"retro_unserialize\0"),
            cheat_reset: sym!(lib, b"retro_cheat_reset\0"),
            cheat_set: sym!(lib, b"retro_cheat_set\0"),
            load_game: sym!(lib, b"retro_load_game\0"),
            load_game_special: sym!(lib, b"retro_load_game_special\0"),
            unload_game: sym!(lib, b"retro_unload_game\0"),
            get_region: sym!(lib, b"retro_get_region\0"),
            get_memory_data: sym!(lib, b"retro_get_memory_data\0"),
            get_memory_size: sym!(lib, b"retro_get_memory_size\0"),
            library: Some(lib),
        };
        let v: c_uint = unsafe { (core.api_version)() };
        if v != RETRO_API_VERSION {
            return Err(format!("the core uses libretro API {v}; SaveState Engine speaks {RETRO_API_VERSION}"));
        }
        Ok(core)
    }

    /// `retro_get_system_info`, copied out (may be called before `retro_init`).
    pub fn system_info(&self) -> SystemInfo {
        let mut raw = retro_system_info {
            library_name: std::ptr::null(),
            library_version: std::ptr::null(),
            valid_extensions: std::ptr::null(),
            need_fullpath: false,
            block_extract: false,
        };
        unsafe { (self.get_system_info)(&mut raw) };
        let s = |p: *const std::ffi::c_char| if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() };
        SystemInfo {
            library_name: s(raw.library_name),
            library_version: s(raw.library_version),
            valid_extensions: s(raw.valid_extensions).split('|').filter(|e| !e.is_empty()).map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect(),
            need_fullpath: raw.need_fullpath,
            block_extract: raw.block_extract,
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        drop(self.library.take());
        if let Some(copy) = self.copy.take() {
            let _ = std::fs::remove_file(copy);
        }
    }
}
