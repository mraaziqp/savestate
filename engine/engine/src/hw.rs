//! Hardware rendering: the OpenGL context a GPU core draws into.
//!
//! On `SET_HW_RENDER` the engine creates a hidden window and a WGL context of
//! the kind the core asks for (desktop GL core or compatibility profile, or
//! GLES 2/3 through WGL_EXT_create_context_es2_profile) on the emulation
//! thread, and hands the core `get_current_framebuffer` / `get_proc_address`.
//! After the game loads, a framebuffer object the size of the game's largest
//! picture is made and the core's `context_reset` runs.
//!
//! Each frame the core presents (`RETRO_HW_FRAME_BUFFER_VALID`) is read back
//! asynchronously: `glReadPixels` into a pixel-pack buffer plus a fence,
//! issued inside `video_refresh`; `collect` waits on the fence (while the
//! engine would be idle anyway, waiting for the next frame's time) and copies
//! the pixels out. The GPU never stalls the core. GLES 2 has no pack buffers,
//! so there the read is synchronous.
//!
//! Vulkan and Direct3D contexts are not provided; cores that offer OpenGL
//! (Dolphin, PCSX2, PPSSPP, Flycast, Citra, Mupen64Plus-Next...) use it.
#![allow(non_snake_case, clippy::upper_case_acronyms)]

use libretro_sys::*;
use std::ffi::{c_char, c_int, c_uint, c_void, CStr};
use std::sync::Mutex;

// ── Win32 / WGL ─────────────────────────────────────────────────────────
type HWND = *mut c_void;
type HDC = *mut c_void;
type HGLRC = *mut c_void;
type HINSTANCE = *mut c_void;
type WPARAM = usize;
type LPARAM = isize;
type LRESULT = isize;

#[repr(C)]
struct WNDCLASSEXW {
    cbSize: u32,
    style: u32,
    lpfnWndProc: Option<unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT>,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: HINSTANCE,
    hIcon: *mut c_void,
    hCursor: *mut c_void,
    hbrBackground: *mut c_void,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
    hIconSm: *mut c_void,
}

#[repr(C)]
#[derive(Default)]
struct PIXELFORMATDESCRIPTOR {
    nSize: u16,
    nVersion: u16,
    dwFlags: u32,
    iPixelType: u8,
    cColorBits: u8,
    cRedBits: u8,
    cRedShift: u8,
    cGreenBits: u8,
    cGreenShift: u8,
    cBlueBits: u8,
    cBlueShift: u8,
    cAlphaBits: u8,
    cAlphaShift: u8,
    cAccumBits: u8,
    cAccumRedBits: u8,
    cAccumGreenBits: u8,
    cAccumBlueBits: u8,
    cAccumAlphaBits: u8,
    cDepthBits: u8,
    cStencilBits: u8,
    cAuxBuffers: u8,
    iLayerType: u8,
    bReserved: u8,
    dwLayerMask: u32,
    dwVisibleMask: u32,
    dwDamageMask: u32,
}

const PFD_DRAW_TO_WINDOW: u32 = 0x4;
const PFD_SUPPORT_OPENGL: u32 = 0x20;
const PFD_DOUBLEBUFFER: u32 = 0x1;
const CS_OWNDC: u32 = 0x20;
const WS_OVERLAPPEDWINDOW: u32 = 0x00CF_0000;
const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
const WS_CLIPCHILDREN: u32 = 0x0200_0000;

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
    fn GetModuleHandleA(name: *const c_char) -> HINSTANCE;
    fn LoadLibraryA(name: *const c_char) -> HINSTANCE;
    fn GetProcAddress(module: HINSTANCE, name: *const c_char) -> *mut c_void;
}
#[link(name = "user32")]
extern "system" {
    fn RegisterClassExW(class: *const WNDCLASSEXW) -> u16;
    fn CreateWindowExW(ex: u32, class: *const u16, title: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: HWND, menu: *mut c_void, inst: HINSTANCE, param: *mut c_void) -> HWND;
    fn DefWindowProcW(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT;
    fn DestroyWindow(hwnd: HWND) -> i32;
    fn GetDC(hwnd: HWND) -> HDC;
    fn ReleaseDC(hwnd: HWND, dc: HDC) -> i32;
}
#[link(name = "gdi32")]
extern "system" {
    fn ChoosePixelFormat(dc: HDC, pfd: *const PIXELFORMATDESCRIPTOR) -> i32;
    fn SetPixelFormat(dc: HDC, format: i32, pfd: *const PIXELFORMATDESCRIPTOR) -> i32;
}
#[link(name = "opengl32")]
extern "system" {
    fn wglCreateContext(dc: HDC) -> HGLRC;
    fn wglMakeCurrent(dc: HDC, rc: HGLRC) -> i32;
    fn wglDeleteContext(rc: HGLRC) -> i32;
    fn wglGetProcAddress(name: *const c_char) -> *mut c_void;
}

const WGL_CONTEXT_MAJOR_VERSION_ARB: c_int = 0x2091;
const WGL_CONTEXT_MINOR_VERSION_ARB: c_int = 0x2092;
const WGL_CONTEXT_FLAGS_ARB: c_int = 0x2094;
const WGL_CONTEXT_PROFILE_MASK_ARB: c_int = 0x9126;
const WGL_CONTEXT_CORE_PROFILE_BIT_ARB: c_int = 0x1;
const WGL_CONTEXT_ES2_PROFILE_BIT_EXT: c_int = 0x4;
const WGL_CONTEXT_DEBUG_BIT_ARB: c_int = 0x1;
type WglCreateContextAttribsARB = unsafe extern "system" fn(HDC, HGLRC, *const c_int) -> HGLRC;

// ── OpenGL ──────────────────────────────────────────────────────────────
type GLenum = c_uint;
type GLuint = c_uint;
type GLint = c_int;
type GLsizei = c_int;
type GLsync = *mut c_void;

const GL_FRAMEBUFFER: GLenum = 0x8D40;
const GL_READ_FRAMEBUFFER: GLenum = 0x8CA8;
const GL_READ_FRAMEBUFFER_BINDING: GLenum = 0x8CAA;
const GL_RENDERBUFFER: GLenum = 0x8D41;
const GL_COLOR_ATTACHMENT0: GLenum = 0x8CE0;
const GL_DEPTH_ATTACHMENT: GLenum = 0x8D00;
const GL_DEPTH_STENCIL_ATTACHMENT: GLenum = 0x821A;
const GL_DEPTH24_STENCIL8: GLenum = 0x88F0;
const GL_DEPTH_COMPONENT24: GLenum = 0x81A6;
const GL_FRAMEBUFFER_COMPLETE: GLenum = 0x8CD5;
const GL_TEXTURE_2D: GLenum = 0x0DE1;
const GL_TEXTURE_BINDING_2D: GLenum = 0x8069;
const GL_RENDERBUFFER_BINDING: GLenum = 0x8CA7;
const GL_FRAMEBUFFER_BINDING: GLenum = 0x8CA6;
const GL_RGBA: GLenum = 0x1908;
const GL_RGBA8: GLenum = 0x8058;
const GL_UNSIGNED_BYTE: GLenum = 0x1401;
const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
const GL_LINEAR: GLint = 0x2601;
const GL_PACK_ALIGNMENT: GLenum = 0x0D05;
const GL_PIXEL_PACK_BUFFER: GLenum = 0x88EB;
const GL_PIXEL_PACK_BUFFER_BINDING: GLenum = 0x88ED;
const GL_STREAM_READ: GLenum = 0x88E1;
const GL_MAP_READ_BIT: GLenum = 0x0001;
const GL_SYNC_GPU_COMMANDS_COMPLETE: GLenum = 0x9117;
const GL_SYNC_FLUSH_COMMANDS_BIT: GLenum = 0x0001;
const GL_TIMEOUT_EXPIRED: GLenum = 0x911B;
const GL_WAIT_FAILED: GLenum = 0x911D;
const GL_VERSION: GLenum = 0x1F02;
const GL_RENDERER: GLenum = 0x1F01;

struct Gl {
    GetString: unsafe extern "system" fn(GLenum) -> *const u8,
    GetIntegerv: unsafe extern "system" fn(GLenum, *mut GLint),
    GenTextures: unsafe extern "system" fn(GLsizei, *mut GLuint),
    DeleteTextures: unsafe extern "system" fn(GLsizei, *const GLuint),
    BindTexture: unsafe extern "system" fn(GLenum, GLuint),
    TexImage2D: unsafe extern "system" fn(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, *const c_void),
    TexParameteri: unsafe extern "system" fn(GLenum, GLenum, GLint),
    ReadPixels: unsafe extern "system" fn(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, *mut c_void),
    PixelStorei: unsafe extern "system" fn(GLenum, GLint),
    GenFramebuffers: unsafe extern "system" fn(GLsizei, *mut GLuint),
    DeleteFramebuffers: unsafe extern "system" fn(GLsizei, *const GLuint),
    BindFramebuffer: unsafe extern "system" fn(GLenum, GLuint),
    FramebufferTexture2D: unsafe extern "system" fn(GLenum, GLenum, GLenum, GLuint, GLint),
    CheckFramebufferStatus: unsafe extern "system" fn(GLenum) -> GLenum,
    GenRenderbuffers: unsafe extern "system" fn(GLsizei, *mut GLuint),
    DeleteRenderbuffers: unsafe extern "system" fn(GLsizei, *const GLuint),
    BindRenderbuffer: unsafe extern "system" fn(GLenum, GLuint),
    RenderbufferStorage: unsafe extern "system" fn(GLenum, GLenum, GLsizei, GLsizei),
    FramebufferRenderbuffer: unsafe extern "system" fn(GLenum, GLenum, GLenum, GLuint),
    // Pack buffers and fences: GL 3.2+ / GLES 3.0+ (None on GLES 2).
    GenBuffers: Option<unsafe extern "system" fn(GLsizei, *mut GLuint)>,
    DeleteBuffers: Option<unsafe extern "system" fn(GLsizei, *const GLuint)>,
    BindBuffer: Option<unsafe extern "system" fn(GLenum, GLuint)>,
    BufferData: Option<unsafe extern "system" fn(GLenum, isize, *const c_void, GLenum)>,
    MapBufferRange: Option<unsafe extern "system" fn(GLenum, isize, isize, GLenum) -> *mut c_void>,
    UnmapBuffer: Option<unsafe extern "system" fn(GLenum) -> u8>,
    FenceSync: Option<unsafe extern "system" fn(GLenum, c_uint) -> GLsync>,
    ClientWaitSync: Option<unsafe extern "system" fn(GLsync, c_uint, u64) -> GLenum>,
    DeleteSync: Option<unsafe extern "system" fn(GLsync)>,
}

/// Any GL entry point: WGL for extensions and GL 1.2+, opengl32.dll for 1.1.
unsafe fn proc_address(name: *const c_char) -> *mut c_void {
    let p = wglGetProcAddress(name);
    // wglGetProcAddress returns small sentinels instead of NULL on some drivers.
    if !p.is_null() && !matches!(p as isize, 1 | 2 | 3 | -1) {
        return p;
    }
    let module = {
        let m = GetModuleHandleA(c"opengl32.dll".as_ptr());
        if m.is_null() { LoadLibraryA(c"opengl32.dll".as_ptr()) } else { m }
    };
    if module.is_null() { std::ptr::null_mut() } else { GetProcAddress(module, name) }
}

macro_rules! need {
    ($name:literal) => {{
        let p = proc_address(concat!($name, "\0").as_ptr() as *const c_char);
        if p.is_null() {
            return Err(format!("the graphics driver has no {}", $name));
        }
        std::mem::transmute::<*mut c_void, _>(p)
    }};
}
macro_rules! maybe {
    ($name:literal) => {{
        let p = proc_address(concat!($name, "\0").as_ptr() as *const c_char);
        if p.is_null() { None } else { Some(std::mem::transmute::<*mut c_void, _>(p)) }
    }};
}

impl Gl {
    unsafe fn load() -> Result<Self, String> {
        Ok(Self {
            GetString: need!("glGetString"),
            GetIntegerv: need!("glGetIntegerv"),
            GenTextures: need!("glGenTextures"),
            DeleteTextures: need!("glDeleteTextures"),
            BindTexture: need!("glBindTexture"),
            TexImage2D: need!("glTexImage2D"),
            TexParameteri: need!("glTexParameteri"),
            ReadPixels: need!("glReadPixels"),
            PixelStorei: need!("glPixelStorei"),
            GenFramebuffers: need!("glGenFramebuffers"),
            DeleteFramebuffers: need!("glDeleteFramebuffers"),
            BindFramebuffer: need!("glBindFramebuffer"),
            FramebufferTexture2D: need!("glFramebufferTexture2D"),
            CheckFramebufferStatus: need!("glCheckFramebufferStatus"),
            GenRenderbuffers: need!("glGenRenderbuffers"),
            DeleteRenderbuffers: need!("glDeleteRenderbuffers"),
            BindRenderbuffer: need!("glBindRenderbuffer"),
            RenderbufferStorage: need!("glRenderbufferStorage"),
            FramebufferRenderbuffer: need!("glFramebufferRenderbuffer"),
            GenBuffers: maybe!("glGenBuffers"),
            DeleteBuffers: maybe!("glDeleteBuffers"),
            BindBuffer: maybe!("glBindBuffer"),
            BufferData: maybe!("glBufferData"),
            MapBufferRange: maybe!("glMapBufferRange"),
            UnmapBuffer: maybe!("glUnmapBuffer"),
            FenceSync: maybe!("glFenceSync"),
            ClientWaitSync: maybe!("glClientWaitSync"),
            DeleteSync: maybe!("glDeleteSync"),
        })
    }
    fn can_read_async(&self) -> bool {
        self.GenBuffers.is_some() && self.BindBuffer.is_some() && self.BufferData.is_some() && self.MapBufferRange.is_some() && self.UnmapBuffer.is_some() && self.FenceSync.is_some() && self.ClientWaitSync.is_some() && self.DeleteSync.is_some()
    }
}

// ── The context ─────────────────────────────────────────────────────────
struct Context {
    hwnd: HWND,
    dc: HDC,
    rc: HGLRC,
    gl: Gl,
    callback: retro_hw_render_callback,
    fbo: GLuint,
    color: GLuint,
    depth: GLuint,
    fb_size: (u32, u32),
    pbo: GLuint,
    pbo_size: usize,
    /// A read in flight: (fence, width, height); the fence is null for a synchronous read.
    pending: Option<(GLsync, u32, u32)>,
    sync_pixels: Vec<u8>,
    description: String,
}

// SAFETY: the context is created, used and destroyed on the emulation thread
// only; the Mutex just gives it a home the C callbacks can reach.
unsafe impl Send for Context {}

static CONTEXT: Mutex<Option<Context>> = Mutex::new(None);

fn ctx() -> std::sync::MutexGuard<'static, Option<Context>> {
    CONTEXT.lock().unwrap_or_else(|e| e.into_inner())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn hidden_window() -> Result<(HWND, HDC), String> {
    let inst = GetModuleHandleW(std::ptr::null());
    let class = wide("SaveStateEngineGL");
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_OWNDC,
        lpfnWndProc: Some(DefWindowProcW),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: inst,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class.as_ptr(),
        hIconSm: std::ptr::null_mut(),
    };
    // Fails harmlessly when the class already exists (a second context).
    RegisterClassExW(&wc);
    let title = wide("SaveState Engine");
    let hwnd = CreateWindowExW(0, class.as_ptr(), title.as_ptr(), WS_OVERLAPPEDWINDOW | WS_CLIPSIBLINGS | WS_CLIPCHILDREN, 0, 0, 64, 64, std::ptr::null_mut(), std::ptr::null_mut(), inst, std::ptr::null_mut());
    if hwnd.is_null() {
        return Err("couldn't create the hidden graphics window".into());
    }
    let dc = GetDC(hwnd);
    let pfd = PIXELFORMATDESCRIPTOR {
        nSize: std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u16,
        nVersion: 1,
        dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
        cColorBits: 32,
        cAlphaBits: 8,
        cDepthBits: 24,
        cStencilBits: 8,
        ..Default::default()
    };
    let format = ChoosePixelFormat(dc, &pfd);
    if format == 0 || SetPixelFormat(dc, format, &pfd) == 0 {
        ReleaseDC(hwnd, dc);
        DestroyWindow(hwnd);
        return Err("the graphics driver offers no OpenGL pixel format".into());
    }
    Ok((hwnd, dc))
}

unsafe fn create_context(cb: &retro_hw_render_callback) -> Result<Context, String> {
    let (hwnd, dc) = hidden_window()?;
    let fail = |msg: String| {
        ReleaseDC(hwnd, dc);
        DestroyWindow(hwnd);
        Err(msg)
    };
    let legacy = wglCreateContext(dc);
    if legacy.is_null() || wglMakeCurrent(dc, legacy) == 0 {
        return fail("couldn't start OpenGL".into());
    }
    let create_attribs = proc_address(c"wglCreateContextAttribsARB".as_ptr());
    let (major, minor) = (cb.version_major as c_int, cb.version_minor as c_int);
    let flags = if cb.debug_context { WGL_CONTEXT_DEBUG_BIT_ARB } else { 0 };
    let attribs: Option<[c_int; 9]> = match cb.context_type {
        // GL 2.x-style core: the driver's compatibility context is exactly that.
        RETRO_HW_CONTEXT_OPENGL => None,
        RETRO_HW_CONTEXT_OPENGL_CORE => {
            let (ma, mi) = if major == 0 { (3, 2) } else { (major, minor) };
            Some([WGL_CONTEXT_MAJOR_VERSION_ARB, ma, WGL_CONTEXT_MINOR_VERSION_ARB, mi, WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_CORE_PROFILE_BIT_ARB, WGL_CONTEXT_FLAGS_ARB, flags, 0])
        }
        RETRO_HW_CONTEXT_OPENGLES2 => Some([WGL_CONTEXT_MAJOR_VERSION_ARB, 2, WGL_CONTEXT_MINOR_VERSION_ARB, 0, WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_ES2_PROFILE_BIT_EXT, WGL_CONTEXT_FLAGS_ARB, flags, 0]),
        RETRO_HW_CONTEXT_OPENGLES3 => Some([WGL_CONTEXT_MAJOR_VERSION_ARB, 3, WGL_CONTEXT_MINOR_VERSION_ARB, 0, WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_ES2_PROFILE_BIT_EXT, WGL_CONTEXT_FLAGS_ARB, flags, 0]),
        RETRO_HW_CONTEXT_OPENGLES_VERSION => Some([WGL_CONTEXT_MAJOR_VERSION_ARB, major.max(2), WGL_CONTEXT_MINOR_VERSION_ARB, minor, WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_ES2_PROFILE_BIT_EXT, WGL_CONTEXT_FLAGS_ARB, flags, 0]),
        other => {
            wglMakeCurrent(std::ptr::null_mut(), std::ptr::null_mut());
            wglDeleteContext(legacy);
            return fail(format!("context type {other} isn't OpenGL"));
        }
    };
    let rc = match attribs {
        None => legacy,
        Some(a) => {
            if create_attribs.is_null() {
                wglMakeCurrent(std::ptr::null_mut(), std::ptr::null_mut());
                wglDeleteContext(legacy);
                return fail("the graphics driver can't make modern OpenGL contexts".into());
            }
            let f: WglCreateContextAttribsARB = std::mem::transmute(create_attribs);
            let rc = f(dc, std::ptr::null_mut(), a.as_ptr());
            wglMakeCurrent(std::ptr::null_mut(), std::ptr::null_mut());
            wglDeleteContext(legacy);
            if rc.is_null() {
                return fail(format!("the graphics driver refused OpenGL {}.{} ({})", a[1], a[3], if a[5] == WGL_CONTEXT_ES2_PROFILE_BIT_EXT { "ES" } else { "core" }));
            }
            rc
        }
    };
    if wglMakeCurrent(dc, rc) == 0 {
        wglDeleteContext(rc);
        return fail("couldn't make the OpenGL context current".into());
    }
    let gl = match Gl::load() {
        Ok(g) => g,
        Err(e) => {
            wglMakeCurrent(std::ptr::null_mut(), std::ptr::null_mut());
            wglDeleteContext(rc);
            return fail(e);
        }
    };
    let s = |e: GLenum| {
        let p = (gl.GetString)(e);
        if p.is_null() { String::new() } else { CStr::from_ptr(p as *const c_char).to_string_lossy().into_owned() }
    };
    let description = format!("OpenGL {} on {}", s(GL_VERSION), s(GL_RENDERER));
    Ok(Context { hwnd, dc, rc, gl, callback: *cb, fbo: 0, color: 0, depth: 0, fb_size: (0, 0), pbo: 0, pbo_size: 0, pending: None, sync_pixels: Vec::new(), description })
}

// ── Callbacks handed to the core ────────────────────────────────────────
unsafe extern "C" fn get_current_framebuffer() -> usize {
    ctx().as_ref().map(|c| c.fbo as usize).unwrap_or(0)
}

unsafe extern "C" fn get_proc(sym: *const c_char) -> Option<retro_proc_address_t> {
    if sym.is_null() {
        return None;
    }
    let p = proc_address(sym);
    if p.is_null() { None } else { Some(std::mem::transmute::<*mut c_void, unsafe extern "C" fn()>(p)) }
}

// ── Engine side ─────────────────────────────────────────────────────────
/// SET_HW_RENDER: makes the context the core asks for. On success the core's
/// struct gets our callbacks and the call should answer true.
///
/// # Safety
/// `cb` is the core's `retro_hw_render_callback`; call on the emulation thread.
pub unsafe fn create(cb: &mut retro_hw_render_callback) -> Result<String, String> {
    if !matches!(cb.context_type, RETRO_HW_CONTEXT_OPENGL | RETRO_HW_CONTEXT_OPENGL_CORE | RETRO_HW_CONTEXT_OPENGLES2 | RETRO_HW_CONTEXT_OPENGLES3 | RETRO_HW_CONTEXT_OPENGLES_VERSION) {
        return Err(format!("context type {} (Vulkan/Direct3D) isn't provided", cb.context_type));
    }
    destroy_context();
    cb.get_current_framebuffer = Some(get_current_framebuffer);
    cb.get_proc_address = Some(get_proc);
    let c = create_context(cb)?;
    let d = c.description.clone();
    *ctx() = Some(c);
    Ok(d)
}

pub fn active() -> bool {
    ctx().is_some()
}

/// "OpenGL <version> on <GPU>" for the running context.
pub fn description() -> Option<String> {
    ctx().as_ref().map(|c| c.description.clone())
}

/// After the game has loaded: the framebuffer (largest picture size) and the
/// core's `context_reset`.
pub fn start(max_width: u32, max_height: u32) -> Result<(), String> {
    let reset = {
        let mut g = ctx();
        let Some(c) = g.as_mut() else { return Ok(()) };
        unsafe { make_framebuffer(c, max_width.max(1), max_height.max(1))? };
        c.callback.context_reset
    };
    if let Some(reset) = reset {
        // Without our lock: the core calls get_current_framebuffer/get_proc_address.
        unsafe { reset() };
    }
    Ok(())
}

/// The game grew (SET_SYSTEM_AV_INFO / SET_GEOMETRY beyond the framebuffer).
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
    let gl = &c.gl;
    let (mut prev_fb, mut prev_tex, mut prev_rb) = (0, 0, 0);
    (gl.GetIntegerv)(GL_FRAMEBUFFER_BINDING, &mut prev_fb);
    (gl.GetIntegerv)(GL_TEXTURE_BINDING_2D, &mut prev_tex);
    (gl.GetIntegerv)(GL_RENDERBUFFER_BINDING, &mut prev_rb);
    if c.fbo != 0 {
        (gl.DeleteFramebuffers)(1, &c.fbo);
        (gl.DeleteTextures)(1, &c.color);
        if c.depth != 0 {
            (gl.DeleteRenderbuffers)(1, &c.depth);
        }
        c.depth = 0;
    }
    (gl.GenTextures)(1, &mut c.color);
    (gl.BindTexture)(GL_TEXTURE_2D, c.color);
    (gl.TexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    (gl.TexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    (gl.TexImage2D)(GL_TEXTURE_2D, 0, GL_RGBA8 as GLint, w as GLsizei, h as GLsizei, 0, GL_RGBA, GL_UNSIGNED_BYTE, std::ptr::null());
    (gl.GenFramebuffers)(1, &mut c.fbo);
    (gl.BindFramebuffer)(GL_FRAMEBUFFER, c.fbo);
    (gl.FramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, c.color, 0);
    if c.callback.depth {
        (gl.GenRenderbuffers)(1, &mut c.depth);
        (gl.BindRenderbuffer)(GL_RENDERBUFFER, c.depth);
        let (format, attach) = if c.callback.stencil { (GL_DEPTH24_STENCIL8, GL_DEPTH_STENCIL_ATTACHMENT) } else { (GL_DEPTH_COMPONENT24, GL_DEPTH_ATTACHMENT) };
        (gl.RenderbufferStorage)(GL_RENDERBUFFER, format, w as GLsizei, h as GLsizei);
        (gl.FramebufferRenderbuffer)(GL_FRAMEBUFFER, attach, GL_RENDERBUFFER, c.depth);
    }
    let status = (gl.CheckFramebufferStatus)(GL_FRAMEBUFFER);
    (gl.BindFramebuffer)(GL_FRAMEBUFFER, prev_fb as GLuint);
    (gl.BindTexture)(GL_TEXTURE_2D, prev_tex as GLuint);
    (gl.BindRenderbuffer)(GL_RENDERBUFFER, prev_rb as GLuint);
    if status != GL_FRAMEBUFFER_COMPLETE {
        return Err(format!("the {w}x{h} framebuffer is incomplete (0x{status:x})"));
    }
    c.fb_size = (w, h);
    Ok(())
}

/// The core presented a frame of `width` x `height` from the framebuffer
/// (called from `video_refresh`, on the emulation thread): starts reading it.
pub fn frame_presented(width: u32, height: u32) {
    let mut g = ctx();
    let Some(c) = g.as_mut() else { return };
    if c.fbo == 0 || width == 0 || height == 0 {
        return;
    }
    let (w, h) = (width.min(c.fb_size.0), height.min(c.fb_size.1));
    unsafe {
        let gl = &c.gl;
        if let Some((fence, _, _)) = c.pending.take() {
            // Superseded before it was collected.
            if !fence.is_null() {
                (gl.DeleteSync.unwrap())(fence);
            }
        }
        let mut prev_read = 0;
        (gl.GetIntegerv)(GL_READ_FRAMEBUFFER_BINDING, &mut prev_read);
        (gl.BindFramebuffer)(GL_READ_FRAMEBUFFER, c.fbo);
        (gl.PixelStorei)(GL_PACK_ALIGNMENT, 4);
        let bytes = w as usize * h as usize * 4;
        if gl.can_read_async() {
            let (gen, bind, data) = (gl.GenBuffers.unwrap(), gl.BindBuffer.unwrap(), gl.BufferData.unwrap());
            let mut prev_pbo = 0;
            (gl.GetIntegerv)(GL_PIXEL_PACK_BUFFER_BINDING, &mut prev_pbo);
            if c.pbo == 0 {
                gen(1, &mut c.pbo);
            }
            bind(GL_PIXEL_PACK_BUFFER, c.pbo);
            if c.pbo_size < bytes {
                data(GL_PIXEL_PACK_BUFFER, bytes as isize, std::ptr::null(), GL_STREAM_READ);
                c.pbo_size = bytes;
            }
            (gl.ReadPixels)(0, 0, w as GLsizei, h as GLsizei, GL_RGBA, GL_UNSIGNED_BYTE, std::ptr::null_mut());
            let fence = (gl.FenceSync.unwrap())(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
            bind(GL_PIXEL_PACK_BUFFER, prev_pbo as GLuint);
            c.pending = Some((fence, w, h));
        } else {
            c.sync_pixels.resize(bytes, 0);
            (gl.ReadPixels)(0, 0, w as GLsizei, h as GLsizei, GL_RGBA, GL_UNSIGNED_BYTE, c.sync_pixels.as_mut_ptr() as *mut c_void);
            c.pending = Some((std::ptr::null_mut(), w, h));
        }
        (gl.BindFramebuffer)(GL_READ_FRAMEBUFFER, prev_read as GLuint);
    }
}

/// Copies the last presented frame into `out` (RGBA8, rows bottom-up when the
/// core draws with a bottom-left origin) once the GPU has finished it, waiting
/// at most `timeout_us`. Returns (width, height, bottom_up) when a frame was
/// copied; None when there was none or it isn't ready yet (call again).
pub fn collect(out: &mut Vec<u8>, timeout_us: u64) -> Option<(u32, u32, bool)> {
    let mut g = ctx();
    let c = g.as_mut()?;
    let (fence, w, h) = c.pending?;
    let bytes = w as usize * h as usize * 4;
    let bottom_up = c.callback.bottom_left_origin;
    unsafe {
        let gl = &c.gl;
        if fence.is_null() {
            out.clear();
            out.extend_from_slice(&c.sync_pixels[..bytes]);
            c.pending = None;
            return Some((w, h, bottom_up));
        }
        let r = (gl.ClientWaitSync.unwrap())(fence, GL_SYNC_FLUSH_COMMANDS_BIT, timeout_us.saturating_mul(1000));
        if r == GL_TIMEOUT_EXPIRED {
            return None;
        }
        (gl.DeleteSync.unwrap())(fence);
        c.pending = None;
        if r == GL_WAIT_FAILED {
            return None;
        }
        let bind = gl.BindBuffer.unwrap();
        let mut prev_pbo = 0;
        (gl.GetIntegerv)(GL_PIXEL_PACK_BUFFER_BINDING, &mut prev_pbo);
        bind(GL_PIXEL_PACK_BUFFER, c.pbo);
        let p = (gl.MapBufferRange.unwrap())(GL_PIXEL_PACK_BUFFER, 0, bytes as isize, GL_MAP_READ_BIT);
        let ok = !p.is_null();
        if ok {
            out.clear();
            out.extend_from_slice(std::slice::from_raw_parts(p as *const u8, bytes));
            (gl.UnmapBuffer.unwrap())(GL_PIXEL_PACK_BUFFER);
        }
        bind(GL_PIXEL_PACK_BUFFER, prev_pbo as GLuint);
        if ok { Some((w, h, bottom_up)) } else { None }
    }
}

/// A read is waiting to be collected.
pub fn pending() -> bool {
    ctx().as_ref().is_some_and(|c| c.pending.is_some())
}

/// The core's `context_destroy` (before `retro_unload_game`, as RetroArch does).
pub fn notify_destroy() {
    let destroy = ctx().as_ref().and_then(|c| c.callback.context_destroy);
    if let Some(d) = destroy {
        unsafe { d() };
    }
}

/// Deletes the context and the window (after the core has been unloaded).
pub fn destroy_context() {
    if let Some(c) = ctx().take() {
        unsafe {
            if let Some((fence, _, _)) = c.pending {
                if !fence.is_null() {
                    (c.gl.DeleteSync.unwrap())(fence);
                }
            }
            if c.pbo != 0 {
                if let Some(del) = c.gl.DeleteBuffers {
                    del(1, &c.pbo);
                }
            }
            if c.fbo != 0 {
                (c.gl.DeleteFramebuffers)(1, &c.fbo);
                (c.gl.DeleteTextures)(1, &c.color);
                if c.depth != 0 {
                    (c.gl.DeleteRenderbuffers)(1, &c.depth);
                }
            }
            wglMakeCurrent(std::ptr::null_mut(), std::ptr::null_mut());
            wglDeleteContext(c.rc);
            ReleaseDC(c.hwnd, c.dc);
            DestroyWindow(c.hwnd);
        }
    }
}
