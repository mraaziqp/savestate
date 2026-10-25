//! Hardware rendering where the engine has no GPU context yet (Android until
//! Phase 7 step 7.2 adds EGL/GLES). Same interface as hw.rs: software cores
//! run; a core asking for a GPU context is told it can't have one.
use libretro_sys::retro_hw_render_callback;

/// # Safety
/// Matches hw::create's signature; nothing is read from `cb`.
pub unsafe fn create(_cb: &mut retro_hw_render_callback) -> Result<String, String> {
    Err("hardware rendering isn't available on this device yet".into())
}
pub fn active() -> bool {
    false
}
pub fn description() -> Option<String> {
    None
}
pub fn start(_max_width: u32, _max_height: u32) -> Result<(), String> {
    Ok(())
}
pub fn ensure_size(_max_width: u32, _max_height: u32) {}
pub fn frame_presented(_width: u32, _height: u32) {}
pub fn collect(_out: &mut Vec<u8>, _timeout_us: u64) -> Option<(u32, u32, bool)> {
    None
}
pub fn pending() -> bool {
    false
}
pub fn notify_destroy() {}
pub fn destroy_context() {}
