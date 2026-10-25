//! The libretro ABI, API version 1, as Rust types.
//!
//! Transcribed from `include/libretro.h` (libretro-common, MIT licence, vendored
//! next to this file). Only what SaveState Engine uses is here, but every type
//! that is here matches the C layout field for field: `#[repr(C)]` structs,
//! `extern "C"` function pointers (RETRO_CALLCONV is the platform C convention
//! on x86-64), `bool` as C `bool` (one byte), `unsigned` as `c_uint`.
#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_int, c_uint, c_void};

pub const RETRO_API_VERSION: c_uint = 1;

// ── Devices and joypad ids ──────────────────────────────────────────────
pub const RETRO_DEVICE_TYPE_SHIFT: c_uint = 8;
pub const RETRO_DEVICE_MASK: c_uint = (1 << RETRO_DEVICE_TYPE_SHIFT) - 1;
pub const RETRO_DEVICE_NONE: c_uint = 0;
pub const RETRO_DEVICE_JOYPAD: c_uint = 1;
pub const RETRO_DEVICE_MOUSE: c_uint = 2;
pub const RETRO_DEVICE_KEYBOARD: c_uint = 3;
pub const RETRO_DEVICE_LIGHTGUN: c_uint = 4;
pub const RETRO_DEVICE_ANALOG: c_uint = 5;
pub const RETRO_DEVICE_POINTER: c_uint = 6;

pub const RETRO_DEVICE_ID_JOYPAD_B: c_uint = 0;
pub const RETRO_DEVICE_ID_JOYPAD_Y: c_uint = 1;
pub const RETRO_DEVICE_ID_JOYPAD_SELECT: c_uint = 2;
pub const RETRO_DEVICE_ID_JOYPAD_START: c_uint = 3;
pub const RETRO_DEVICE_ID_JOYPAD_UP: c_uint = 4;
pub const RETRO_DEVICE_ID_JOYPAD_DOWN: c_uint = 5;
pub const RETRO_DEVICE_ID_JOYPAD_LEFT: c_uint = 6;
pub const RETRO_DEVICE_ID_JOYPAD_RIGHT: c_uint = 7;
pub const RETRO_DEVICE_ID_JOYPAD_A: c_uint = 8;
pub const RETRO_DEVICE_ID_JOYPAD_X: c_uint = 9;
pub const RETRO_DEVICE_ID_JOYPAD_L: c_uint = 10;
pub const RETRO_DEVICE_ID_JOYPAD_R: c_uint = 11;
pub const RETRO_DEVICE_ID_JOYPAD_L2: c_uint = 12;
pub const RETRO_DEVICE_ID_JOYPAD_R2: c_uint = 13;
pub const RETRO_DEVICE_ID_JOYPAD_L3: c_uint = 14;
pub const RETRO_DEVICE_ID_JOYPAD_R3: c_uint = 15;
pub const RETRO_DEVICE_ID_JOYPAD_MASK: c_uint = 256;

pub const RETRO_DEVICE_INDEX_ANALOG_LEFT: c_uint = 0;
pub const RETRO_DEVICE_INDEX_ANALOG_RIGHT: c_uint = 1;
pub const RETRO_DEVICE_INDEX_ANALOG_BUTTON: c_uint = 2;
pub const RETRO_DEVICE_ID_ANALOG_X: c_uint = 0;
pub const RETRO_DEVICE_ID_ANALOG_Y: c_uint = 1;

// ── Memory ──────────────────────────────────────────────────────────────
pub const RETRO_MEMORY_MASK: c_uint = 0xff;
pub const RETRO_MEMORY_SAVE_RAM: c_uint = 0;
pub const RETRO_MEMORY_RTC: c_uint = 1;
pub const RETRO_MEMORY_SYSTEM_RAM: c_uint = 2;
pub const RETRO_MEMORY_VIDEO_RAM: c_uint = 3;

// ── Regions ─────────────────────────────────────────────────────────────
pub const RETRO_REGION_NTSC: c_uint = 0;
pub const RETRO_REGION_PAL: c_uint = 1;

// ── Environment commands ────────────────────────────────────────────────
pub const RETRO_ENVIRONMENT_EXPERIMENTAL: c_uint = 0x10000;
pub const RETRO_ENVIRONMENT_PRIVATE: c_uint = 0x20000;
pub const RETRO_ENVIRONMENT_SET_ROTATION: c_uint = 1;
pub const RETRO_ENVIRONMENT_GET_OVERSCAN: c_uint = 2;
pub const RETRO_ENVIRONMENT_GET_CAN_DUPE: c_uint = 3;
pub const RETRO_ENVIRONMENT_SET_MESSAGE: c_uint = 6;
pub const RETRO_ENVIRONMENT_SHUTDOWN: c_uint = 7;
pub const RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL: c_uint = 8;
pub const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: c_uint = 9;
pub const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: c_uint = 10;
pub const RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS: c_uint = 11;
pub const RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK: c_uint = 12;
pub const RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE: c_uint = 13;
pub const RETRO_ENVIRONMENT_SET_HW_RENDER: c_uint = 14;
pub const RETRO_ENVIRONMENT_GET_VARIABLE: c_uint = 15;
pub const RETRO_ENVIRONMENT_SET_VARIABLES: c_uint = 16;
pub const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: c_uint = 17;
pub const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME: c_uint = 18;
pub const RETRO_ENVIRONMENT_GET_LIBRETRO_PATH: c_uint = 19;
pub const RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK: c_uint = 21;
pub const RETRO_ENVIRONMENT_SET_AUDIO_CALLBACK: c_uint = 22;
pub const RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE: c_uint = 23;
pub const RETRO_ENVIRONMENT_GET_INPUT_DEVICE_CAPABILITIES: c_uint = 24;
pub const RETRO_ENVIRONMENT_GET_SENSOR_INTERFACE: c_uint = 25 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_CAMERA_INTERFACE: c_uint = 26 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_LOG_INTERFACE: c_uint = 27;
pub const RETRO_ENVIRONMENT_GET_PERF_INTERFACE: c_uint = 28;
pub const RETRO_ENVIRONMENT_GET_LOCATION_INTERFACE: c_uint = 29;
pub const RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY: c_uint = 30;
pub const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: c_uint = 31;
pub const RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: c_uint = 32;
pub const RETRO_ENVIRONMENT_SET_PROC_ADDRESS_CALLBACK: c_uint = 33;
pub const RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO: c_uint = 34;
pub const RETRO_ENVIRONMENT_SET_CONTROLLER_INFO: c_uint = 35;
pub const RETRO_ENVIRONMENT_SET_MEMORY_MAPS: c_uint = 36 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_SET_GEOMETRY: c_uint = 37;
pub const RETRO_ENVIRONMENT_GET_USERNAME: c_uint = 38;
pub const RETRO_ENVIRONMENT_GET_LANGUAGE: c_uint = 39;
pub const RETRO_ENVIRONMENT_GET_CURRENT_SOFTWARE_FRAMEBUFFER: c_uint = 40 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_HW_RENDER_INTERFACE: c_uint = 41 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS: c_uint = 42 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_SET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE: c_uint = 43 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS: c_uint = 44;
/// Legacy alias of SET_SERIALIZATION_QUIRKS.
pub const RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS_2: c_uint = 87;
pub const RETRO_ENVIRONMENT_SET_HW_SHARED_CONTEXT: c_uint = 44 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_VFS_INTERFACE: c_uint = 45 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_LED_INTERFACE: c_uint = 46 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE: c_uint = 47 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_MIDI_INTERFACE: c_uint = 48 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_FASTFORWARDING: c_uint = 49 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE: c_uint = 50 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_INPUT_BITMASKS: c_uint = 51 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION: c_uint = 52;
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS: c_uint = 53;
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL: c_uint = 54;
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY: c_uint = 55;
pub const RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER: c_uint = 56;
pub const RETRO_ENVIRONMENT_GET_DISK_CONTROL_INTERFACE_VERSION: c_uint = 57;
pub const RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE: c_uint = 58;
pub const RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION: c_uint = 59;
pub const RETRO_ENVIRONMENT_SET_MESSAGE_EXT: c_uint = 60;
pub const RETRO_ENVIRONMENT_GET_INPUT_MAX_USERS: c_uint = 61;
pub const RETRO_ENVIRONMENT_SET_AUDIO_BUFFER_STATUS_CALLBACK: c_uint = 62;
pub const RETRO_ENVIRONMENT_SET_MINIMUM_AUDIO_LATENCY: c_uint = 63;
pub const RETRO_ENVIRONMENT_SET_FASTFORWARDING_OVERRIDE: c_uint = 64;
pub const RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE: c_uint = 65;
pub const RETRO_ENVIRONMENT_GET_GAME_INFO_EXT: c_uint = 66;
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: c_uint = 67;
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: c_uint = 68;
pub const RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK: c_uint = 69;
pub const RETRO_ENVIRONMENT_SET_VARIABLE: c_uint = 70;
pub const RETRO_ENVIRONMENT_GET_THROTTLE_STATE: c_uint = 71 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_SAVESTATE_CONTEXT: c_uint = 72 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE_SUPPORT: c_uint = 73 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_JIT_CAPABLE: c_uint = 74;
pub const RETRO_ENVIRONMENT_GET_MICROPHONE_INTERFACE: c_uint = 75 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_GET_DEVICE_POWER: c_uint = 77 | RETRO_ENVIRONMENT_EXPERIMENTAL;
pub const RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE: c_uint = 78;
pub const RETRO_ENVIRONMENT_GET_PLAYLIST_DIRECTORY: c_uint = 79;
pub const RETRO_ENVIRONMENT_GET_FILE_BROWSER_START_DIRECTORY: c_uint = 80;

// ── Pixel formats, logs, HW contexts ────────────────────────────────────
pub const RETRO_PIXEL_FORMAT_0RGB1555: c_int = 0;
pub const RETRO_PIXEL_FORMAT_XRGB8888: c_int = 1;
pub const RETRO_PIXEL_FORMAT_RGB565: c_int = 2;

pub const RETRO_LOG_DEBUG: c_int = 0;
pub const RETRO_LOG_INFO: c_int = 1;
pub const RETRO_LOG_WARN: c_int = 2;
pub const RETRO_LOG_ERROR: c_int = 3;

pub const RETRO_HW_CONTEXT_NONE: c_int = 0;
pub const RETRO_HW_CONTEXT_OPENGL: c_int = 1;
pub const RETRO_HW_CONTEXT_OPENGLES2: c_int = 2;
pub const RETRO_HW_CONTEXT_OPENGL_CORE: c_int = 3;
pub const RETRO_HW_CONTEXT_OPENGLES3: c_int = 4;
pub const RETRO_HW_CONTEXT_OPENGLES_VERSION: c_int = 5;
pub const RETRO_HW_CONTEXT_VULKAN: c_int = 6;
pub const RETRO_HW_CONTEXT_D3D11: c_int = 7;

/// `video_refresh(RETRO_HW_FRAME_BUFFER_VALID, ...)`: the frame is in the HW framebuffer.
pub const RETRO_HW_FRAME_BUFFER_VALID: *const c_void = usize::MAX as *const c_void;

pub const RETRO_LANGUAGE_ENGLISH: c_uint = 0;

pub const RETRO_THROTTLE_NONE: c_uint = 0;
pub const RETRO_THROTTLE_FRAME_STEPPING: c_uint = 1;
pub const RETRO_THROTTLE_FAST_FORWARD: c_uint = 2;
pub const RETRO_THROTTLE_SLOW_MOTION: c_uint = 3;
pub const RETRO_THROTTLE_REWINDING: c_uint = 4;
pub const RETRO_THROTTLE_VSYNC: c_uint = 5;
pub const RETRO_THROTTLE_UNBLOCKED: c_uint = 6;

pub const RETRO_SAVESTATE_CONTEXT_NORMAL: c_int = 0;
pub const RETRO_SAVESTATE_CONTEXT_RUNAHEAD_SAME_INSTANCE: c_int = 1;
pub const RETRO_SAVESTATE_CONTEXT_RUNAHEAD_SAME_BINARY: c_int = 2;

pub const RETRO_NUM_CORE_OPTION_VALUES_MAX: usize = 128;

// ── VFS ─────────────────────────────────────────────────────────────────
pub const RETRO_VFS_FILE_ACCESS_READ: c_uint = 1 << 0;
pub const RETRO_VFS_FILE_ACCESS_WRITE: c_uint = 1 << 1;
pub const RETRO_VFS_FILE_ACCESS_READ_WRITE: c_uint = RETRO_VFS_FILE_ACCESS_READ | RETRO_VFS_FILE_ACCESS_WRITE;
pub const RETRO_VFS_FILE_ACCESS_UPDATE_EXISTING: c_uint = 1 << 2;
pub const RETRO_VFS_SEEK_POSITION_START: c_int = 0;
pub const RETRO_VFS_SEEK_POSITION_CURRENT: c_int = 1;
pub const RETRO_VFS_SEEK_POSITION_END: c_int = 2;
pub const RETRO_VFS_STAT_IS_VALID: c_int = 1 << 0;
pub const RETRO_VFS_STAT_IS_DIRECTORY: c_int = 1 << 1;
pub const RETRO_VFS_STAT_IS_CHARACTER_SPECIAL: c_int = 1 << 2;
/// The highest VFS version SaveState Engine provides.
pub const SAVESTATE_VFS_VERSION: u32 = 3;

// ── Plain structs ───────────────────────────────────────────────────────
#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_variable {
    pub key: *const c_char,
    pub value: *const c_char,
}

#[repr(C)]
pub struct retro_game_info {
    pub path: *const c_char,
    pub data: *const c_void,
    pub size: usize,
    pub meta: *const c_char,
}

#[repr(C)]
pub struct retro_system_info {
    pub library_name: *const c_char,
    pub library_version: *const c_char,
    pub valid_extensions: *const c_char,
    pub need_fullpath: bool,
    pub block_extract: bool,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct retro_game_geometry {
    pub base_width: c_uint,
    pub base_height: c_uint,
    pub max_width: c_uint,
    pub max_height: c_uint,
    pub aspect_ratio: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct retro_system_timing {
    pub fps: f64,
    pub sample_rate: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct retro_system_av_info {
    pub geometry: retro_game_geometry,
    pub timing: retro_system_timing,
}

/// `void (*)(enum retro_log_level, const char *fmt, ...)`. Declared variadic
/// here; the engine's implementation reads the arguments itself (see engine::log).
pub type retro_log_printf_t = unsafe extern "C" fn(level: c_int, fmt: *const c_char, ...);

#[repr(C)]
pub struct retro_log_callback {
    pub log: Option<retro_log_printf_t>,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_core_option_value {
    pub value: *const c_char,
    pub label: *const c_char,
}

#[repr(C)]
pub struct retro_core_option_definition {
    pub key: *const c_char,
    pub desc: *const c_char,
    pub info: *const c_char,
    pub values: [retro_core_option_value; RETRO_NUM_CORE_OPTION_VALUES_MAX],
    pub default_value: *const c_char,
}

#[repr(C)]
pub struct retro_core_options_intl {
    pub us: *const retro_core_option_definition,
    pub local: *const retro_core_option_definition,
}

#[repr(C)]
pub struct retro_core_option_v2_category {
    pub key: *const c_char,
    pub desc: *const c_char,
    pub info: *const c_char,
}

#[repr(C)]
pub struct retro_core_option_v2_definition {
    pub key: *const c_char,
    pub desc: *const c_char,
    pub desc_categorized: *const c_char,
    pub info: *const c_char,
    pub info_categorized: *const c_char,
    pub category_key: *const c_char,
    pub values: [retro_core_option_value; RETRO_NUM_CORE_OPTION_VALUES_MAX],
    pub default_value: *const c_char,
}

#[repr(C)]
pub struct retro_core_options_v2 {
    pub categories: *const retro_core_option_v2_category,
    pub definitions: *const retro_core_option_v2_definition,
}

#[repr(C)]
pub struct retro_core_options_v2_intl {
    pub us: *const retro_core_options_v2,
    pub local: *const retro_core_options_v2,
}

#[repr(C)]
pub struct retro_core_option_display {
    pub key: *const c_char,
    pub visible: bool,
}

pub type retro_core_options_update_display_callback_t = unsafe extern "C" fn() -> bool;
#[repr(C)]
pub struct retro_core_options_update_display_callback {
    pub callback: Option<retro_core_options_update_display_callback_t>,
}

pub type retro_hw_context_reset_t = unsafe extern "C" fn();
pub type retro_hw_get_current_framebuffer_t = unsafe extern "C" fn() -> usize;
pub type retro_proc_address_t = unsafe extern "C" fn();
pub type retro_hw_get_proc_address_t = unsafe extern "C" fn(sym: *const c_char) -> Option<retro_proc_address_t>;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_hw_render_callback {
    pub context_type: c_int,
    pub context_reset: Option<retro_hw_context_reset_t>,
    pub get_current_framebuffer: Option<retro_hw_get_current_framebuffer_t>,
    pub get_proc_address: Option<retro_hw_get_proc_address_t>,
    pub depth: bool,
    pub stencil: bool,
    pub bottom_left_origin: bool,
    pub version_major: c_uint,
    pub version_minor: c_uint,
    pub cache_context: bool,
    pub context_destroy: Option<retro_hw_context_reset_t>,
    pub debug_context: bool,
}

#[repr(C)]
pub struct retro_message {
    pub msg: *const c_char,
    pub frames: c_uint,
}

#[repr(C)]
pub struct retro_message_ext {
    pub msg: *const c_char,
    pub duration: c_uint,
    pub priority: c_uint,
    pub level: c_int,
    pub target: c_int,
    pub type_: c_int,
    pub progress: i8,
}

pub type retro_usec_t = i64;
pub type retro_frame_time_callback_t = unsafe extern "C" fn(usec: retro_usec_t);
#[repr(C)]
pub struct retro_frame_time_callback {
    pub callback: Option<retro_frame_time_callback_t>,
    pub reference: retro_usec_t,
}

pub type retro_audio_callback_t = unsafe extern "C" fn();
pub type retro_audio_set_state_callback_t = unsafe extern "C" fn(enabled: bool);
#[repr(C)]
pub struct retro_audio_callback {
    pub callback: Option<retro_audio_callback_t>,
    pub set_state: Option<retro_audio_set_state_callback_t>,
}

pub type retro_audio_buffer_status_callback_t = unsafe extern "C" fn(active: bool, occupancy: c_uint, underrun_likely: bool);
#[repr(C)]
pub struct retro_audio_buffer_status_callback {
    pub callback: Option<retro_audio_buffer_status_callback_t>,
}

#[repr(C)]
pub struct retro_controller_description {
    pub desc: *const c_char,
    pub id: c_uint,
}

#[repr(C)]
pub struct retro_controller_info {
    pub types: *const retro_controller_description,
    pub num_types: c_uint,
}

#[repr(C)]
pub struct retro_input_descriptor {
    pub port: c_uint,
    pub device: c_uint,
    pub index: c_uint,
    pub id: c_uint,
    pub description: *const c_char,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_game_info_ext {
    pub full_path: *const c_char,
    pub archive_path: *const c_char,
    pub archive_file: *const c_char,
    pub dir: *const c_char,
    pub name: *const c_char,
    pub ext: *const c_char,
    pub meta: *const c_char,
    pub data: *const c_void,
    pub size: usize,
    pub file_in_archive: bool,
    pub persistent_data: bool,
}

#[repr(C)]
pub struct retro_system_content_info_override {
    pub extensions: *const c_char,
    pub need_fullpath: bool,
    pub persistent_data: bool,
}

pub type retro_set_rumble_state_t = unsafe extern "C" fn(port: c_uint, effect: c_int, strength: u16) -> bool;
#[repr(C)]
pub struct retro_rumble_interface {
    pub set_rumble_state: Option<retro_set_rumble_state_t>,
}

#[repr(C)]
pub struct retro_fastforwarding_override {
    pub ratio: f32,
    pub fastforward: bool,
    pub notification: bool,
    pub inhibit_toggle: bool,
}

#[repr(C)]
pub struct retro_throttle_state {
    pub mode: c_uint,
    pub rate: f32,
}

pub type retro_keyboard_event_t = unsafe extern "C" fn(down: bool, keycode: c_uint, character: u32, key_modifiers: u16);
#[repr(C)]
pub struct retro_keyboard_callback {
    pub callback: Option<retro_keyboard_event_t>,
}

// ── Disk control ────────────────────────────────────────────────────────
pub type retro_set_eject_state_t = unsafe extern "C" fn(ejected: bool) -> bool;
pub type retro_get_eject_state_t = unsafe extern "C" fn() -> bool;
pub type retro_get_image_index_t = unsafe extern "C" fn() -> c_uint;
pub type retro_set_image_index_t = unsafe extern "C" fn(index: c_uint) -> bool;
pub type retro_get_num_images_t = unsafe extern "C" fn() -> c_uint;
pub type retro_replace_image_index_t = unsafe extern "C" fn(index: c_uint, info: *const retro_game_info) -> bool;
pub type retro_add_image_index_t = unsafe extern "C" fn() -> bool;
pub type retro_set_initial_image_t = unsafe extern "C" fn(index: c_uint, path: *const c_char) -> bool;
pub type retro_get_image_path_t = unsafe extern "C" fn(index: c_uint, path: *mut c_char, len: usize) -> bool;
pub type retro_get_image_label_t = unsafe extern "C" fn(index: c_uint, label: *mut c_char, len: usize) -> bool;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_disk_control_callback {
    pub set_eject_state: Option<retro_set_eject_state_t>,
    pub get_eject_state: Option<retro_get_eject_state_t>,
    pub get_image_index: Option<retro_get_image_index_t>,
    pub set_image_index: Option<retro_set_image_index_t>,
    pub get_num_images: Option<retro_get_num_images_t>,
    pub replace_image_index: Option<retro_replace_image_index_t>,
    pub add_image_index: Option<retro_add_image_index_t>,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct retro_disk_control_ext_callback {
    pub set_eject_state: Option<retro_set_eject_state_t>,
    pub get_eject_state: Option<retro_get_eject_state_t>,
    pub get_image_index: Option<retro_get_image_index_t>,
    pub set_image_index: Option<retro_set_image_index_t>,
    pub get_num_images: Option<retro_get_num_images_t>,
    pub replace_image_index: Option<retro_replace_image_index_t>,
    pub add_image_index: Option<retro_add_image_index_t>,
    pub set_initial_image: Option<retro_set_initial_image_t>,
    pub get_image_path: Option<retro_get_image_path_t>,
    pub get_image_label: Option<retro_get_image_label_t>,
}

// ── Perf ────────────────────────────────────────────────────────────────
pub type retro_perf_tick_t = u64;
pub type retro_time_t = i64;
#[repr(C)]
pub struct retro_perf_counter {
    pub ident: *const c_char,
    pub start: retro_perf_tick_t,
    pub total: retro_perf_tick_t,
    pub call_cnt: retro_perf_tick_t,
    pub registered: bool,
}
pub type retro_perf_get_time_usec_t = unsafe extern "C" fn() -> retro_time_t;
pub type retro_get_cpu_features_t = unsafe extern "C" fn() -> u64;
pub type retro_perf_get_counter_t = unsafe extern "C" fn() -> retro_perf_tick_t;
pub type retro_perf_register_t = unsafe extern "C" fn(counter: *mut retro_perf_counter);
pub type retro_perf_start_t = unsafe extern "C" fn(counter: *mut retro_perf_counter);
pub type retro_perf_stop_t = unsafe extern "C" fn(counter: *mut retro_perf_counter);
pub type retro_perf_log_t = unsafe extern "C" fn();
#[repr(C)]
pub struct retro_perf_callback {
    pub get_time_usec: Option<retro_perf_get_time_usec_t>,
    pub get_cpu_features: Option<retro_get_cpu_features_t>,
    pub get_perf_counter: Option<retro_perf_get_counter_t>,
    pub perf_register: Option<retro_perf_register_t>,
    pub perf_start: Option<retro_perf_start_t>,
    pub perf_stop: Option<retro_perf_stop_t>,
    pub perf_log: Option<retro_perf_log_t>,
}
pub const RETRO_SIMD_SSE: u64 = 1 << 0;
pub const RETRO_SIMD_SSE2: u64 = 1 << 1;
pub const RETRO_SIMD_VMX: u64 = 1 << 2;
pub const RETRO_SIMD_AVX: u64 = 1 << 4;
pub const RETRO_SIMD_NEON: u64 = 1 << 5;
pub const RETRO_SIMD_SSE3: u64 = 1 << 6;
pub const RETRO_SIMD_SSSE3: u64 = 1 << 7;
pub const RETRO_SIMD_MMX: u64 = 1 << 8;
pub const RETRO_SIMD_SSE4: u64 = 1 << 11;
pub const RETRO_SIMD_ASIMD: u64 = 1 << 22;
pub const RETRO_SIMD_SSE42: u64 = 1 << 12;
pub const RETRO_SIMD_AVX2: u64 = 1 << 13;
pub const RETRO_SIMD_POPCNT: u64 = 1 << 15;
pub const RETRO_SIMD_CMOV: u64 = 1 << 20;

// ── Software framebuffer (GET_CURRENT_SOFTWARE_FRAMEBUFFER) ─────────────
pub const RETRO_MEMORY_ACCESS_WRITE: c_uint = 1 << 0;
pub const RETRO_MEMORY_ACCESS_READ: c_uint = 1 << 1;
pub const RETRO_MEMORY_TYPE_CACHED: c_uint = 1 << 0;
#[repr(C)]
pub struct retro_framebuffer {
    pub data: *mut c_void,
    pub width: c_uint,
    pub height: c_uint,
    pub pitch: usize,
    pub format: c_int,
    pub access_flags: c_uint,
    pub memory_flags: c_uint,
}

// ── VFS (API v3) ────────────────────────────────────────────────────────
/// Opaque to the core; the engine's own handle types sit behind these pointers.
#[repr(C)]
pub struct retro_vfs_file_handle {
    _private: [u8; 0],
}
#[repr(C)]
pub struct retro_vfs_dir_handle {
    _private: [u8; 0],
}

pub type retro_vfs_get_path_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle) -> *const c_char;
pub type retro_vfs_open_t = unsafe extern "C" fn(path: *const c_char, mode: c_uint, hints: c_uint) -> *mut retro_vfs_file_handle;
pub type retro_vfs_close_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle) -> c_int;
pub type retro_vfs_size_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle) -> i64;
pub type retro_vfs_tell_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle) -> i64;
pub type retro_vfs_seek_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle, offset: i64, seek_position: c_int) -> i64;
pub type retro_vfs_read_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle, s: *mut c_void, len: u64) -> i64;
pub type retro_vfs_write_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle, s: *const c_void, len: u64) -> i64;
pub type retro_vfs_flush_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle) -> c_int;
pub type retro_vfs_remove_t = unsafe extern "C" fn(path: *const c_char) -> c_int;
pub type retro_vfs_rename_t = unsafe extern "C" fn(old_path: *const c_char, new_path: *const c_char) -> c_int;
pub type retro_vfs_truncate_t = unsafe extern "C" fn(stream: *mut retro_vfs_file_handle, length: i64) -> i64;
pub type retro_vfs_stat_t = unsafe extern "C" fn(path: *const c_char, size: *mut i32) -> c_int;
pub type retro_vfs_mkdir_t = unsafe extern "C" fn(dir: *const c_char) -> c_int;
pub type retro_vfs_opendir_t = unsafe extern "C" fn(dir: *const c_char, include_hidden: bool) -> *mut retro_vfs_dir_handle;
pub type retro_vfs_readdir_t = unsafe extern "C" fn(dirstream: *mut retro_vfs_dir_handle) -> bool;
pub type retro_vfs_dirent_get_name_t = unsafe extern "C" fn(dirstream: *mut retro_vfs_dir_handle) -> *const c_char;
pub type retro_vfs_dirent_is_dir_t = unsafe extern "C" fn(dirstream: *mut retro_vfs_dir_handle) -> bool;
pub type retro_vfs_closedir_t = unsafe extern "C" fn(dirstream: *mut retro_vfs_dir_handle) -> c_int;

/// The VFS v3 function table (the first 19 entries of `struct retro_vfs_interface`;
/// a core given version 3 reads no further).
#[repr(C)]
pub struct retro_vfs_interface {
    pub get_path: Option<retro_vfs_get_path_t>,
    pub open: Option<retro_vfs_open_t>,
    pub close: Option<retro_vfs_close_t>,
    pub size: Option<retro_vfs_size_t>,
    pub tell: Option<retro_vfs_tell_t>,
    pub seek: Option<retro_vfs_seek_t>,
    pub read: Option<retro_vfs_read_t>,
    pub write: Option<retro_vfs_write_t>,
    pub flush: Option<retro_vfs_flush_t>,
    pub remove: Option<retro_vfs_remove_t>,
    pub rename: Option<retro_vfs_rename_t>,
    pub truncate: Option<retro_vfs_truncate_t>,
    pub stat: Option<retro_vfs_stat_t>,
    pub mkdir: Option<retro_vfs_mkdir_t>,
    pub opendir: Option<retro_vfs_opendir_t>,
    pub readdir: Option<retro_vfs_readdir_t>,
    pub dirent_get_name: Option<retro_vfs_dirent_get_name_t>,
    pub dirent_is_dir: Option<retro_vfs_dirent_is_dir_t>,
    pub closedir: Option<retro_vfs_closedir_t>,
}

#[repr(C)]
pub struct retro_vfs_interface_info {
    pub required_interface_version: u32,
    pub iface: *const retro_vfs_interface,
}

// ── Core callbacks and entry points ─────────────────────────────────────
pub type retro_environment_t = unsafe extern "C" fn(cmd: c_uint, data: *mut c_void) -> bool;
pub type retro_video_refresh_t = unsafe extern "C" fn(data: *const c_void, width: c_uint, height: c_uint, pitch: usize);
pub type retro_audio_sample_t = unsafe extern "C" fn(left: i16, right: i16);
pub type retro_audio_sample_batch_t = unsafe extern "C" fn(data: *const i16, frames: usize) -> usize;
pub type retro_input_poll_t = unsafe extern "C" fn();
pub type retro_input_state_t = unsafe extern "C" fn(port: c_uint, device: c_uint, index: c_uint, id: c_uint) -> i16;

pub type retro_set_environment_fn = unsafe extern "C" fn(retro_environment_t);
pub type retro_set_video_refresh_fn = unsafe extern "C" fn(retro_video_refresh_t);
pub type retro_set_audio_sample_fn = unsafe extern "C" fn(retro_audio_sample_t);
pub type retro_set_audio_sample_batch_fn = unsafe extern "C" fn(retro_audio_sample_batch_t);
pub type retro_set_input_poll_fn = unsafe extern "C" fn(retro_input_poll_t);
pub type retro_set_input_state_fn = unsafe extern "C" fn(retro_input_state_t);
pub type retro_init_fn = unsafe extern "C" fn();
pub type retro_deinit_fn = unsafe extern "C" fn();
pub type retro_api_version_fn = unsafe extern "C" fn() -> c_uint;
pub type retro_get_system_info_fn = unsafe extern "C" fn(info: *mut retro_system_info);
pub type retro_get_system_av_info_fn = unsafe extern "C" fn(info: *mut retro_system_av_info);
pub type retro_set_controller_port_device_fn = unsafe extern "C" fn(port: c_uint, device: c_uint);
pub type retro_reset_fn = unsafe extern "C" fn();
pub type retro_run_fn = unsafe extern "C" fn();
pub type retro_serialize_size_fn = unsafe extern "C" fn() -> usize;
pub type retro_serialize_fn = unsafe extern "C" fn(data: *mut c_void, size: usize) -> bool;
pub type retro_unserialize_fn = unsafe extern "C" fn(data: *const c_void, size: usize) -> bool;
pub type retro_cheat_reset_fn = unsafe extern "C" fn();
pub type retro_cheat_set_fn = unsafe extern "C" fn(index: c_uint, enabled: bool, code: *const c_char);
pub type retro_load_game_fn = unsafe extern "C" fn(game: *const retro_game_info) -> bool;
pub type retro_load_game_special_fn = unsafe extern "C" fn(game_type: c_uint, info: *const retro_game_info, num_info: usize) -> bool;
pub type retro_unload_game_fn = unsafe extern "C" fn();
pub type retro_get_region_fn = unsafe extern "C" fn() -> c_uint;
pub type retro_get_memory_data_fn = unsafe extern "C" fn(id: c_uint) -> *mut c_void;
pub type retro_get_memory_size_fn = unsafe extern "C" fn(id: c_uint) -> usize;

#[cfg(test)]
mod layout {
    use super::*;
    use std::mem::{align_of, size_of};

    // Sizes of the C structs on x86-64 (LLP64 and LP64 agree for these).
    #[test]
    fn sizes_match_c() {
        assert_eq!(size_of::<retro_game_info>(), 32);
        assert_eq!(size_of::<retro_system_info>(), 32);
        assert_eq!(size_of::<retro_game_geometry>(), 20);
        assert_eq!(size_of::<retro_system_av_info>(), 40);
        assert_eq!(align_of::<retro_system_av_info>(), 8);
        assert_eq!(size_of::<retro_core_option_value>(), 16);
        assert_eq!(size_of::<retro_core_option_definition>(), 8 * 3 + 16 * 128 + 8);
        assert_eq!(size_of::<retro_core_option_v2_definition>(), 8 * 6 + 16 * 128 + 8);
        assert_eq!(size_of::<retro_hw_render_callback>(), 64);
        assert_eq!(size_of::<retro_message_ext>(), 8 + 4 * 5 + 1 + 3);
        assert_eq!(size_of::<retro_game_info_ext>(), 8 * 9 + 2 + 6);
        assert_eq!(size_of::<retro_vfs_interface>(), 19 * 8);
        assert_eq!(size_of::<retro_vfs_interface_info>(), 16);
        assert_eq!(size_of::<retro_disk_control_ext_callback>(), 10 * 8);
        assert_eq!(size_of::<retro_framebuffer>(), 8 + 4 + 4 + 8 + 4 + 4 + 4 + 4);
    }
}
