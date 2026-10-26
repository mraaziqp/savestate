//! Hardware rendering on Android (Phase 7): a GPU core (PPSSPP, Dolphin,
//! ARMSX2, Citra, Flycast...) draws with OpenGL ES into a framebuffer object
//! in the player's own GLES 3 context (android::gles::Screen, current on the
//! emulation thread before the core loads). Same interface as hw.rs on
//! Windows, but nothing is read back: the player blits the framebuffer
//! straight to the screen (`presented`).
use crate::android::gles::*;
use libretro_sys::*;
use std::ffi::{c_char, c_void, CStr};
use std::sync::Mutex;

struct Context {
    callback: retro_hw_render_callback,
    fbo: GLuint,
    color: GLuint,
    depth: GLuint,
    fb_size: (u32, u32),
    /// The last picture the core presented: (width, height), until the player takes it.
    presented: Option<(u32, u32)>,
    description: String,
}

static CTX: Mutex<Option<Context>> = Mutex::new(None);
/// Set by the player once its context is current (create() needs it).
static READY: Mutex<Option<String>> = Mutex::new(None);

fn ctx() -> std::sync::MutexGuard<'static, Option<Context>> {
    CTX.lock().unwrap_or_else(|e| e.into_inner())
}

/// The player's context is current on the emulation thread (`description`:
/// "OpenGL ES 3.2 on Adreno..."); cores may ask for hardware rendering.
pub fn context_ready(description: Option<String>) {
    *READY.lock().unwrap_or_else(|e| e.into_inner()) = description;
}

unsafe extern "C" fn get_current_framebuffer() -> usize {
    ctx().as_ref().map(|c| c.fbo as usize).unwrap_or(0)
}

unsafe extern "C" fn get_proc(sym: *const c_char) -> Option<retro_proc_address_t> {
    if sym.is_null() {
        return None;
    }
    let mut p = eglGetProcAddress(sym);
    if p.is_null() {
        // Core GLES functions: some drivers' eglGetProcAddress returns only extensions.
        static LIB: std::sync::OnceLock<Option<libloading::Library>> = std::sync::OnceLock::new();
        if let Some(lib) = LIB.get_or_init(|| libloading::Library::new("libGLESv3.so").ok()) {
            let name = CStr::from_ptr(sym).to_bytes_with_nul();
            if let Ok(f) = lib.get::<*mut c_void>(name) {
                p = *f;
            }
        }
    }
    if p.is_null() { None } else { Some(std::mem::transmute::<*mut c_void, unsafe extern "C" fn()>(p)) }
}

/// # Safety
/// `cb` is the core's `retro_hw_render_callback`; call on the emulation thread.
pub unsafe fn create(cb: &mut retro_hw_render_callback) -> Result<String, String> {
    if !matches!(cb.context_type, RETRO_HW_CONTEXT_OPENGLES2 | RETRO_HW_CONTEXT_OPENGLES3 | RETRO_HW_CONTEXT_OPENGLES_VERSION) {
        return Err(format!("context type {} isn't available on Android (OpenGL ES only)", cb.context_type));
    }
    let Some(description) = READY.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
        return Err("no OpenGL ES context on this thread".into());
    };
    destroy_context();
    cb.get_current_framebuffer = Some(get_current_framebuffer);
    cb.get_proc_address = Some(get_proc);
    *ctx() = Some(Context { callback: *cb, fbo: 0, color: 0, depth: 0, fb_size: (0, 0), presented: None, description: description.clone() });
    Ok(description)
}

pub fn active() -> bool {
    ctx().is_some()
}

pub fn description() -> Option<String> {
    ctx().as_ref().map(|c| c.description.clone())
}

/// After the game has loaded: the framebuffer (largest picture) and the core's `context_reset`.
pub fn start(max_width: u32, max_height: u32) -> Result<(), String> {
    let reset = {
        let mut g = ctx();
        let Some(c) = g.as_mut() else { return Ok(()) };
        unsafe { make_framebuffer(c, max_width.max(1), max_height.max(1))? };
        c.callback.context_reset
    };
    if let Some(reset) = reset {
        unsafe { reset() };
    }
    Ok(())
}

pub fn ensure_size(max_width: u32, max_height: u32) {
    let mut g = ctx();
    if let Some(c) = g.as_mut() {
        if c.fbo != 0 && (max_width > c.fb_size.0 || max_height > c.fb_size.1) {
            let (w, h) = (max_width.max(c.fb_size.0), max_height.max(c.fb_size.1));
            if let Err(e) = unsafe { make_framebuffer(c, w, h) } {
                crate::log::emit(crate::log::Level::Warn, "hw", &e);
            }
        }
    }
}

unsafe fn make_framebuffer(c: &mut Context, w: u32, h: u32) -> Result<(), String> {
    let mut prev_fb = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &mut prev_fb);
    if c.fbo != 0 {
        glDeleteFramebuffers(1, &c.fbo);
        glDeleteTextures(1, &c.color);
        if c.depth != 0 {
            glDeleteRenderbuffers(1, &c.depth);
        }
        c.depth = 0;
    }
    glGenTextures(1, &mut c.color);
    glBindTexture(GL_TEXTURE_2D, c.color);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8 as GLint, w as GLsizei, h as GLsizei, 0, GL_RGBA, GL_UNSIGNED_BYTE, std::ptr::null());
    glBindTexture(GL_TEXTURE_2D, 0);
    glGenFramebuffers(1, &mut c.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, c.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, c.color, 0);
    if c.callback.depth {
        glGenRenderbuffers(1, &mut c.depth);
        glBindRenderbuffer(GL_RENDERBUFFER, c.depth);
        let (format, attach) = if c.callback.stencil { (GL_DEPTH24_STENCIL8, GL_DEPTH_STENCIL_ATTACHMENT) } else { (GL_DEPTH_COMPONENT24, GL_DEPTH_ATTACHMENT) };
        glRenderbufferStorage(GL_RENDERBUFFER, format, w as GLsizei, h as GLsizei);
        glFramebufferRenderbuffer(GL_FRAMEBUFFER, attach, GL_RENDERBUFFER, c.depth);
        glBindRenderbuffer(GL_RENDERBUFFER, 0);
    }
    let status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, prev_fb as GLuint);
    if status != GL_FRAMEBUFFER_COMPLETE {
        return Err(format!("the {w}x{h} framebuffer is incomplete (0x{status:x})"));
    }
    c.fb_size = (w, h);
    Ok(())
}

/// The core presented a frame of `width` x `height` from the framebuffer.
pub fn frame_presented(width: u32, height: u32) {
    if let Some(c) = ctx().as_mut() {
        if width > 0 && height > 0 {
            c.presented = Some((width.min(c.fb_size.0), height.min(c.fb_size.1)));
        }
    }
}

/// The player takes the last presented frame: (framebuffer, width, height,
/// rows run bottom to top).
pub fn presented() -> Option<(GLuint, u32, u32, bool)> {
    let mut g = ctx();
    let c = g.as_mut()?;
    let (w, h) = c.presented.take()?;
    Some((c.fbo, w, h, c.callback.bottom_left_origin))
}

/// Nothing is read back on Android (see `presented`).
pub fn collect(_out: &mut Vec<u8>, _timeout_us: u64) -> Option<(u32, u32, bool)> {
    None
}

pub fn pending() -> bool {
    false
}

pub fn notify_destroy() {
    let destroy = ctx().as_ref().and_then(|c| c.callback.context_destroy);
    if let Some(d) = destroy {
        unsafe { d() };
    }
}

/// Deletes the framebuffer (the context itself belongs to the player).
pub fn destroy_context() {
    if let Some(c) = ctx().take() {
        unsafe {
            if c.fbo != 0 {
                glDeleteFramebuffers(1, &c.fbo);
                glDeleteTextures(1, &c.color);
                if c.depth != 0 {
                    glDeleteRenderbuffers(1, &c.depth);
                }
            }
        }
    }
}
