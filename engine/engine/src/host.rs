//! What the core's callbacks talk to.
//!
//! libretro callbacks carry no user pointer, so the host state is one global
//! (one game per engine process, by design: see SAVESTATE_ENGINE_SPEC.md 2.1).
//! The lock is held only inside a callback or a short engine-side access,
//! never while the core runs, so a core calling back from inside `retro_run`
//! (or from its own threads) can't deadlock.
use crate::options::Options;
use crate::video::{Frame, PixelFormat};
use libretro_sys::*;
use std::ffi::{c_int, c_uint, c_void, CString};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

pub const MAX_PORTS: usize = 8;

#[derive(Clone, Copy, Debug, Default)]
pub struct PortInput {
    /// Bit n = RETRO_DEVICE_ID_JOYPAD n.
    pub buttons: u16,
    /// [left stick, right stick] x [x, y], -32768..32767.
    pub sticks: [[i16; 2]; 2],
    /// Analog strength for buttons that have it (L2/R2), 0..32767.
    pub triggers: [i16; 2],
}

#[derive(Default)]
pub struct Dirs {
    pub system: CString,
    pub save: CString,
    pub assets: CString,
    pub core_path: CString,
    pub username: CString,
}

/// The content as the core sees it (GET_GAME_INFO_EXT); the strings live here.
pub struct GameInfoExt {
    pub strings: Vec<CString>,
    pub info: retro_game_info_ext,
}
// SAFETY: the raw pointers in `info` point into `strings` (owned here) or into
// the session's content buffer, which outlives this value.
unsafe impl Send for GameInfoExt {}

#[derive(Clone, Copy)]
pub struct FrameTimeCallback {
    pub callback: retro_frame_time_callback_t,
    pub reference: retro_usec_t,
}

pub struct ContentOverride {
    pub extensions: Vec<String>,
    pub need_fullpath: bool,
    pub persistent_data: bool,
}

pub struct HostState {
    pub frame: Frame,
    /// Interleaved stereo samples produced since the engine last took them.
    pub audio: Vec<i16>,
    pub input: [PortInput; MAX_PORTS],
    pub options: Options,
    pub dirs: Dirs,
    pub av: retro_system_av_info,
    pub av_changed: bool,
    pub rotation: c_uint,
    pub shutdown_requested: bool,
    pub messages: Vec<String>,
    pub frame_time: Option<FrameTimeCallback>,
    pub audio_callback: Option<(retro_audio_callback_t, Option<retro_audio_set_state_callback_t>)>,
    pub audio_buffer_status: Option<retro_audio_buffer_status_callback_t>,
    pub keyboard: Option<retro_keyboard_event_t>,
    pub disk: Option<retro_disk_control_ext_callback>,
    pub input_descriptors: Vec<(u32, u32, u32, u32, String)>,
    pub controller_types: usize,
    pub support_no_game: bool,
    pub rumble: [[u16; 2]; MAX_PORTS],
    pub game_info_ext: Option<GameInfoExt>,
    pub vfs_version: u32,
    pub content_overrides: Vec<ContentOverride>,
    pub serialization_quirks: u64,
    /// Requested HW context type, when the core asked for one.
    pub hw_requested: Option<c_int>,
    pub hw_granted: bool,
    pub fastforward: bool,
    /// 1 = video, 2 = audio (GET_AUDIO_VIDEO_ENABLE); run-ahead turns them off for hidden frames.
    pub av_enable: c_int,
    pub savestate_context: c_int,
    pub options_display_callback: Option<retro_core_options_update_display_callback_t>,
    pub unknown_reported: Vec<c_uint>,
    pub started: Instant,
}

// SAFETY: the function pointers and C strings held here are only called or
// read while the lock is held or on the emulation thread.
unsafe impl Send for HostState {}

impl HostState {
    fn new() -> Self {
        Self {
            frame: Frame::default(),
            audio: Vec::with_capacity(4096),
            input: [PortInput::default(); MAX_PORTS],
            options: Options::default(),
            dirs: Dirs::default(),
            av: retro_system_av_info::default(),
            av_changed: false,
            rotation: 0,
            shutdown_requested: false,
            messages: Vec::new(),
            frame_time: None,
            audio_callback: None,
            audio_buffer_status: None,
            keyboard: None,
            disk: None,
            input_descriptors: Vec::new(),
            controller_types: 0,
            support_no_game: false,
            rumble: [[0; 2]; MAX_PORTS],
            game_info_ext: None,
            vfs_version: 0,
            content_overrides: Vec::new(),
            serialization_quirks: 0,
            hw_requested: None,
            hw_granted: false,
            fastforward: false,
            av_enable: 3,
            savestate_context: RETRO_SAVESTATE_CONTEXT_NORMAL,
            options_display_callback: None,
            unknown_reported: Vec::new(),
            started: Instant::now(),
        }
    }
}

static HOST: OnceLock<Mutex<HostState>> = OnceLock::new();

/// The host state, locked. A poisoned lock (a panic elsewhere) is taken over:
/// the engine aborts on panic anyway (panic = "abort").
pub fn lock() -> MutexGuard<'static, HostState> {
    HOST.get_or_init(|| Mutex::new(HostState::new())).lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts a fresh state for a new session.
pub fn reset(options: Options, dirs: Dirs) {
    let mut h = lock();
    *h = HostState::new();
    h.options = options;
    h.dirs = dirs;
}

pub fn pixel_format() -> PixelFormat {
    lock().frame.format
}

// ── Callbacks handed to the core ────────────────────────────────────────
pub unsafe extern "C" fn video_refresh(data: *const c_void, width: c_uint, height: c_uint, pitch: usize) {
    let mut h = lock();
    if h.av_enable & 1 == 0 {
        // A hidden run-ahead frame: the picture isn't wanted.
        h.frame.count += 1;
        return;
    }
    h.frame.receive(data, width, height, pitch);
}

pub unsafe extern "C" fn audio_sample(left: i16, right: i16) {
    let mut h = lock();
    if h.av_enable & 2 != 0 {
        h.audio.push(left);
        h.audio.push(right);
    }
}

pub unsafe extern "C" fn audio_sample_batch(data: *const i16, frames: usize) -> usize {
    if data.is_null() || frames == 0 {
        return frames;
    }
    let mut h = lock();
    if h.av_enable & 2 != 0 {
        h.audio.extend_from_slice(std::slice::from_raw_parts(data, frames * 2));
    }
    frames
}

pub unsafe extern "C" fn input_poll() {
    // Input is set by the engine between frames (set_input); nothing to poll here.
}

pub unsafe extern "C" fn input_state(port: c_uint, device: c_uint, index: c_uint, id: c_uint) -> i16 {
    let port = port as usize;
    if port >= MAX_PORTS {
        return 0;
    }
    let h = lock();
    let p = h.input[port];
    match device & RETRO_DEVICE_MASK {
        RETRO_DEVICE_JOYPAD => {
            if id == RETRO_DEVICE_ID_JOYPAD_MASK {
                p.buttons as i16
            } else if id < 16 {
                ((p.buttons >> id) & 1) as i16
            } else {
                0
            }
        }
        RETRO_DEVICE_ANALOG => match index {
            RETRO_DEVICE_INDEX_ANALOG_LEFT | RETRO_DEVICE_INDEX_ANALOG_RIGHT if id <= 1 => p.sticks[index as usize][id as usize],
            RETRO_DEVICE_INDEX_ANALOG_BUTTON => match id {
                RETRO_DEVICE_ID_JOYPAD_L2 => if p.triggers[0] > 0 { p.triggers[0] } else if p.buttons >> id & 1 == 1 { 0x7fff } else { 0 },
                RETRO_DEVICE_ID_JOYPAD_R2 => if p.triggers[1] > 0 { p.triggers[1] } else if p.buttons >> id & 1 == 1 { 0x7fff } else { 0 },
                id if id < 16 => if p.buttons >> id & 1 == 1 { 0x7fff } else { 0 },
                _ => 0,
            },
            _ => 0,
        },
        _ => 0,
    }
}

// ── Perf interface ──────────────────────────────────────────────────────
pub unsafe extern "C" fn perf_get_time_usec() -> retro_time_t {
    lock().started.elapsed().as_micros() as retro_time_t
}

pub unsafe extern "C" fn perf_get_counter() -> retro_perf_tick_t {
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_nanos() as retro_perf_tick_t
}

pub unsafe extern "C" fn perf_get_cpu_features() -> u64 {
    let mut f = 0u64;
    #[cfg(target_arch = "x86_64")]
    {
        f |= RETRO_SIMD_SSE | RETRO_SIMD_SSE2 | RETRO_SIMD_MMX | RETRO_SIMD_CMOV;
        if std::arch::is_x86_feature_detected!("sse3") { f |= RETRO_SIMD_SSE3; }
        if std::arch::is_x86_feature_detected!("ssse3") { f |= RETRO_SIMD_SSSE3; }
        if std::arch::is_x86_feature_detected!("sse4.1") { f |= RETRO_SIMD_SSE4; }
        if std::arch::is_x86_feature_detected!("sse4.2") { f |= RETRO_SIMD_SSE42; }
        if std::arch::is_x86_feature_detected!("avx") { f |= RETRO_SIMD_AVX; }
        if std::arch::is_x86_feature_detected!("avx2") { f |= RETRO_SIMD_AVX2; }
        if std::arch::is_x86_feature_detected!("popcnt") { f |= RETRO_SIMD_POPCNT; }
    }
    f
}

pub unsafe extern "C" fn perf_register(counter: *mut retro_perf_counter) {
    if !counter.is_null() {
        (*counter).registered = true;
    }
}

pub unsafe extern "C" fn perf_start(counter: *mut retro_perf_counter) {
    if !counter.is_null() {
        (*counter).call_cnt += 1;
        (*counter).start = perf_get_counter();
    }
}

pub unsafe extern "C" fn perf_stop(counter: *mut retro_perf_counter) {
    if !counter.is_null() {
        (*counter).total += perf_get_counter().saturating_sub((*counter).start);
    }
}

pub unsafe extern "C" fn perf_log() {}

pub static PERF: retro_perf_callback = retro_perf_callback {
    get_time_usec: Some(perf_get_time_usec),
    get_cpu_features: Some(perf_get_cpu_features),
    get_perf_counter: Some(perf_get_counter),
    perf_register: Some(perf_register),
    perf_start: Some(perf_start),
    perf_stop: Some(perf_stop),
    perf_log: Some(perf_log),
};

// ── Rumble ──────────────────────────────────────────────────────────────
pub unsafe extern "C" fn set_rumble_state(port: c_uint, effect: c_int, strength: u16) -> bool {
    let port = port as usize;
    if port >= MAX_PORTS || !(0..=1).contains(&effect) {
        return false;
    }
    lock().rumble[port][effect as usize] = strength;
    true
}
