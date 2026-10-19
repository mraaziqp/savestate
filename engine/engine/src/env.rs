//! `retro_environment_t`: every question and request a core sends the host.
//!
//! Each command is answered from the host state (host.rs). A command the
//! engine doesn't support answers false, which every core must handle, and is
//! logged once. Where libretro.h says a call returns true "even if data is
//! NULL", a NULL `data` is a support probe and answers true (`probe`); cores
//! such as FinalBurn Neo change how they save states on that answer. Pointers handed back (directories, option values, the game
//! info) point into the host state, where they stay valid for the session.
use crate::host::{self, ContentOverride, FrameTimeCallback};
use crate::log::{emit, Level};
use crate::video::PixelFormat;
use libretro_sys::*;
use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() { String::new() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
}

/// SAVESTATE_TRACE_ENV=1 logs every call before it's answered (finding which
/// call a misbehaving core dies in).
fn trace_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("SAVESTATE_TRACE_ENV").is_some_and(|v| v != "0"))
}

pub unsafe extern "C" fn environment(cmd: c_uint, data: *mut c_void) -> bool {
    if trace_enabled() {
        emit(Level::Info, "env", &format!("call {} (0x{cmd:x}) data={data:p}", cmd & !RETRO_ENVIRONMENT_EXPERIMENTAL));
    }
    match cmd {
        // ── Directories and identity ───────────────────────────────────
        RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY | RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY | RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY
        | RETRO_ENVIRONMENT_GET_LIBRETRO_PATH | RETRO_ENVIRONMENT_GET_USERNAME => {
            if data.is_null() {
                return false;
            }
            let h = host::lock();
            let s = match cmd {
                RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY => &h.dirs.system,
                RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY => &h.dirs.save,
                RETRO_ENVIRONMENT_GET_CORE_ASSETS_DIRECTORY => &h.dirs.assets,
                RETRO_ENVIRONMENT_GET_LIBRETRO_PATH => &h.dirs.core_path,
                _ => &h.dirs.username,
            };
            *(data as *mut *const c_char) = s.as_ptr();
            true
        }
        RETRO_ENVIRONMENT_GET_LANGUAGE => write(data, RETRO_LANGUAGE_ENGLISH),
        RETRO_ENVIRONMENT_GET_CAN_DUPE => write(data, true),
        RETRO_ENVIRONMENT_GET_OVERSCAN => write(data, false),
        RETRO_ENVIRONMENT_GET_INPUT_MAX_USERS => write(data, host::MAX_PORTS as c_uint),
        RETRO_ENVIRONMENT_GET_INPUT_DEVICE_CAPABILITIES => write(data, (1u64 << RETRO_DEVICE_JOYPAD) | (1u64 << RETRO_DEVICE_ANALOG)),
        RETRO_ENVIRONMENT_GET_INPUT_BITMASKS => true,
        RETRO_ENVIRONMENT_GET_JIT_CAPABLE => write(data, true),
        RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION => write(data, 2 as c_uint),
        RETRO_ENVIRONMENT_GET_DISK_CONTROL_INTERFACE_VERSION => write(data, 1 as c_uint),
        RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION => write(data, 1 as c_uint),
        RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE => write(data, 60.0f32),
        RETRO_ENVIRONMENT_GET_FASTFORWARDING => {
            let ff = host::lock().fastforward;
            write(data, ff)
        }
        RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE => {
            let e = host::lock().av_enable;
            probe(data, e)
        }
        RETRO_ENVIRONMENT_GET_SAVESTATE_CONTEXT => {
            let c = host::lock().savestate_context;
            probe(data, c)
        }
        RETRO_ENVIRONMENT_GET_THROTTLE_STATE => {
            if data.is_null() {
                return false;
            }
            let h = host::lock();
            let t = &mut *(data as *mut retro_throttle_state);
            if h.fastforward {
                t.mode = RETRO_THROTTLE_FAST_FORWARD;
                t.rate = 0.0;
            } else {
                t.mode = RETRO_THROTTLE_VSYNC;
                t.rate = h.av.timing.fps as f32;
            }
            true
        }

        // ── Video ──────────────────────────────────────────────────────
        RETRO_ENVIRONMENT_SET_PIXEL_FORMAT => {
            if data.is_null() {
                return false;
            }
            match PixelFormat::from_retro(*(data as *const c_int)) {
                Some(f) => {
                    host::lock().frame.format = f;
                    true
                }
                None => false,
            }
        }
        RETRO_ENVIRONMENT_SET_ROTATION => {
            if data.is_null() {
                return false;
            }
            host::lock().rotation = *(data as *const c_uint) % 4;
            true
        }
        RETRO_ENVIRONMENT_SET_GEOMETRY => {
            if data.is_null() {
                return false;
            }
            let g = *(data as *const retro_game_geometry);
            let mut h = host::lock();
            h.av.geometry.base_width = g.base_width;
            h.av.geometry.base_height = g.base_height;
            h.av.geometry.aspect_ratio = g.aspect_ratio;
            h.av_changed = true;
            true
        }
        RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO => {
            if data.is_null() {
                return false;
            }
            let mut h = host::lock();
            h.av = *(data as *const retro_system_av_info);
            h.av_changed = true;
            true
        }
        RETRO_ENVIRONMENT_GET_CURRENT_SOFTWARE_FRAMEBUFFER => {
            if data.is_null() {
                return false;
            }
            let mut h = host::lock();
            if h.hw_granted {
                return false;
            }
            let fb = &mut *(data as *mut retro_framebuffer);
            if fb.width == 0 || fb.height == 0 || fb.width > 8192 || fb.height > 8192 {
                return false;
            }
            let format = h.frame.format;
            let (ptr, pitch) = h.frame.software_target(fb.width, fb.height);
            fb.data = ptr;
            fb.pitch = pitch;
            fb.format = format.to_retro();
            fb.access_flags = RETRO_MEMORY_ACCESS_WRITE | RETRO_MEMORY_ACCESS_READ;
            fb.memory_flags = RETRO_MEMORY_TYPE_CACHED;
            true
        }
        RETRO_ENVIRONMENT_SET_HW_RENDER => {
            if data.is_null() {
                return false;
            }
            let cb = &*(data as *const retro_hw_render_callback);
            host::lock().hw_requested = Some(cb.context_type);
            crate::session::note_hw_request();
            // The GPU context arrives with the video pipeline (spec Phase 3);
            // until then cores that can fall back to software do so.
            emit(Level::Info, "env", &format!("core asked for a hardware context (type {}); software only in this build", cb.context_type));
            false
        }
        RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER => false,
        RETRO_ENVIRONMENT_SET_HW_SHARED_CONTEXT => false,
        RETRO_ENVIRONMENT_GET_HW_RENDER_INTERFACE => false,
        RETRO_ENVIRONMENT_SET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE => false,
        RETRO_ENVIRONMENT_GET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE_SUPPORT => false,

        // ── Options ────────────────────────────────────────────────────
        // True even for a NULL probe or an unknown key (value NULL), as libretro.h asks.
        RETRO_ENVIRONMENT_GET_VARIABLE => {
            if data.is_null() {
                return true;
            }
            let var = &mut *(data as *mut retro_variable);
            var.value = if var.key.is_null() { std::ptr::null() } else { host::lock().options.get(&cstr(var.key)).unwrap_or(std::ptr::null()) };
            true
        }
        RETRO_ENVIRONMENT_SET_VARIABLES => {
            if !data.is_null() {
                host::lock().options.set_variables(data as *const retro_variable);
            }
            true
        }
        RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE => {
            let changed = host::lock().options.take_updated();
            write(data, changed)
        }
        RETRO_ENVIRONMENT_SET_CORE_OPTIONS => {
            if !data.is_null() {
                host::lock().options.set_v1(data as *const retro_core_option_definition);
            }
            true
        }
        RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL => {
            if !data.is_null() {
                let intl = &*(data as *const retro_core_options_intl);
                host::lock().options.set_v1(intl.us);
            }
            true
        }
        RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2 => {
            if !data.is_null() {
                host::lock().options.set_v2(data as *const retro_core_options_v2);
            }
            true
        }
        RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL => {
            if !data.is_null() {
                let intl = &*(data as *const retro_core_options_v2_intl);
                host::lock().options.set_v2(intl.us);
            }
            true
        }
        RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY => {
            if !data.is_null() {
                let d = &*(data as *const retro_core_option_display);
                if !d.key.is_null() {
                    let key = cstr(d.key);
                    host::lock().options.set_visible(&key, d.visible);
                }
            }
            true
        }
        RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK => {
            let cb = if data.is_null() { None } else { (*(data as *const retro_core_options_update_display_callback)).callback };
            host::lock().options_display_callback = cb;
            true
        }
        RETRO_ENVIRONMENT_SET_VARIABLE => {
            if data.is_null() {
                return true;
            }
            let var = &*(data as *const retro_variable);
            if var.key.is_null() || var.value.is_null() {
                return false;
            }
            let (k, v) = (cstr(var.key), cstr(var.value));
            host::lock().options.set(&k, &v)
        }

        // ── Messages and logging ───────────────────────────────────────
        RETRO_ENVIRONMENT_GET_LOG_INTERFACE => {
            if data.is_null() {
                return false;
            }
            (*(data as *mut retro_log_callback)).log = Some(crate::log::core_log_fn());
            true
        }
        RETRO_ENVIRONMENT_SET_MESSAGE => {
            if data.is_null() {
                return false;
            }
            let m = cstr((*(data as *const retro_message)).msg);
            emit(Level::Info, "core", &format!("message: {m}"));
            host::lock().messages.push(m);
            true
        }
        RETRO_ENVIRONMENT_SET_MESSAGE_EXT => {
            if data.is_null() {
                return false;
            }
            let m = &*(data as *const retro_message_ext);
            let text = cstr(m.msg);
            // target 0 = all, 1 = OSD only, 2 = log only.
            emit(Level::Info, "core", &format!("message: {text}"));
            if m.target != 2 {
                host::lock().messages.push(text);
            }
            true
        }
        RETRO_ENVIRONMENT_GET_PERF_INTERFACE => {
            if data.is_null() {
                return false;
            }
            std::ptr::copy_nonoverlapping(&host::PERF, data as *mut retro_perf_callback, 1);
            true
        }

        // ── Input ──────────────────────────────────────────────────────
        RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS => {
            if data.is_null() {
                return true;
            }
            let mut d = data as *const retro_input_descriptor;
            let mut list = Vec::new();
            while !(*d).description.is_null() {
                list.push(((*d).port, (*d).device, (*d).index, (*d).id, cstr((*d).description)));
                d = d.add(1);
            }
            host::lock().input_descriptors = list;
            true
        }
        RETRO_ENVIRONMENT_SET_CONTROLLER_INFO => {
            if !data.is_null() {
                let mut c = data as *const retro_controller_info;
                let mut n = 0;
                while !(*c).types.is_null() {
                    n += 1;
                    c = c.add(1);
                }
                host::lock().controller_types = n;
            }
            true
        }
        RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK => {
            if data.is_null() {
                return false;
            }
            host::lock().keyboard = (*(data as *const retro_keyboard_callback)).callback;
            true
        }
        RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE => {
            if data.is_null() {
                return false;
            }
            (*(data as *mut retro_rumble_interface)).set_rumble_state = Some(host::set_rumble_state);
            true
        }

        // ── Timing and audio ───────────────────────────────────────────
        RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK => {
            if data.is_null() {
                return false;
            }
            let f = &*(data as *const retro_frame_time_callback);
            host::lock().frame_time = f.callback.map(|callback| FrameTimeCallback { callback, reference: f.reference });
            true
        }
        RETRO_ENVIRONMENT_SET_AUDIO_CALLBACK => {
            host::lock().audio_callback = if data.is_null() {
                None
            } else {
                let a = &*(data as *const retro_audio_callback);
                a.callback.map(|cb| (cb, a.set_state))
            };
            true
        }
        RETRO_ENVIRONMENT_SET_AUDIO_BUFFER_STATUS_CALLBACK => {
            let cb = if data.is_null() { None } else { (*(data as *const retro_audio_buffer_status_callback)).callback };
            host::lock().audio_buffer_status = cb;
            true
        }
        RETRO_ENVIRONMENT_SET_MINIMUM_AUDIO_LATENCY => true,
        RETRO_ENVIRONMENT_SET_FASTFORWARDING_OVERRIDE => true,
        RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL => true,

        // ── Content ────────────────────────────────────────────────────
        RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME => {
            if data.is_null() {
                return false;
            }
            host::lock().support_no_game = *(data as *const bool);
            true
        }
        RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE => {
            if data.is_null() {
                return true;
            }
            let mut o = data as *const retro_system_content_info_override;
            let mut list = Vec::new();
            while !(*o).extensions.is_null() {
                list.push(ContentOverride {
                    extensions: cstr((*o).extensions).split('|').map(|e| e.to_ascii_lowercase()).collect(),
                    need_fullpath: (*o).need_fullpath,
                    persistent_data: (*o).persistent_data,
                });
                o = o.add(1);
            }
            host::lock().content_overrides = list;
            true
        }
        RETRO_ENVIRONMENT_GET_GAME_INFO_EXT => {
            if data.is_null() {
                return false;
            }
            let h = host::lock();
            match &h.game_info_ext {
                Some(g) => {
                    *(data as *mut *const retro_game_info_ext) = &g.info;
                    true
                }
                None => false,
            }
        }
        RETRO_ENVIRONMENT_SET_DISK_CONTROL_INTERFACE => {
            if data.is_null() {
                return true;
            }
            let d = *(data as *const retro_disk_control_callback);
            host::lock().disk = Some(retro_disk_control_ext_callback {
                set_eject_state: d.set_eject_state,
                get_eject_state: d.get_eject_state,
                get_image_index: d.get_image_index,
                set_image_index: d.set_image_index,
                get_num_images: d.get_num_images,
                replace_image_index: d.replace_image_index,
                add_image_index: d.add_image_index,
                set_initial_image: None,
                get_image_path: None,
                get_image_label: None,
            });
            true
        }
        RETRO_ENVIRONMENT_SET_DISK_CONTROL_EXT_INTERFACE => {
            if data.is_null() {
                return true;
            }
            host::lock().disk = Some(*(data as *const retro_disk_control_ext_callback));
            true
        }
        RETRO_ENVIRONMENT_GET_VFS_INTERFACE => {
            if data.is_null() {
                return false;
            }
            let info = &mut *(data as *mut retro_vfs_interface_info);
            if info.required_interface_version > SAVESTATE_VFS_VERSION {
                return false;
            }
            info.required_interface_version = SAVESTATE_VFS_VERSION;
            info.iface = &crate::vfs::INTERFACE;
            host::lock().vfs_version = SAVESTATE_VFS_VERSION;
            true
        }

        // ── Lifecycle and capabilities ─────────────────────────────────
        RETRO_ENVIRONMENT_SHUTDOWN => {
            host::lock().shutdown_requested = true;
            true
        }
        RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS | RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS_2 => {
            if !data.is_null() {
                host::lock().serialization_quirks = *(data as *const u64);
            }
            true
        }
        RETRO_ENVIRONMENT_SET_PROC_ADDRESS_CALLBACK => true,
        RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO => true,
        RETRO_ENVIRONMENT_SET_MEMORY_MAPS => true,
        RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS => true,

        // ── Not provided: sensors, camera, location, MIDI, LEDs, mic, power, netpacket ──
        RETRO_ENVIRONMENT_GET_SENSOR_INTERFACE | RETRO_ENVIRONMENT_GET_CAMERA_INTERFACE | RETRO_ENVIRONMENT_GET_LOCATION_INTERFACE
        | RETRO_ENVIRONMENT_GET_MIDI_INTERFACE | RETRO_ENVIRONMENT_GET_LED_INTERFACE | RETRO_ENVIRONMENT_GET_MICROPHONE_INTERFACE
        | RETRO_ENVIRONMENT_GET_DEVICE_POWER | RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE | RETRO_ENVIRONMENT_GET_PLAYLIST_DIRECTORY
        | RETRO_ENVIRONMENT_GET_FILE_BROWSER_START_DIRECTORY => false,

        other => {
            let mut h = host::lock();
            if !h.unknown_reported.contains(&other) {
                h.unknown_reported.push(other);
                drop(h);
                emit(Level::Debug, "env", &format!("unsupported environment command {other} (0x{other:x})"));
            }
            false
        }
    }
}

/// Like `write`, but a NULL `data` is a support probe and answers true.
unsafe fn probe<T>(data: *mut c_void, value: T) -> bool {
    data.is_null() || write(data, value)
}

/// Writes `value` through `data` (an out-parameter of the command's type).
unsafe fn write<T>(data: *mut c_void, value: T) -> bool {
    if data.is_null() {
        return false;
    }
    std::ptr::write(data as *mut T, value);
    true
}
