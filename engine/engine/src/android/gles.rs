//! EGL and OpenGL ES 3 for the Android player (Phase 7): the few calls it
//! needs, linked from the system's libEGL / libGLESv3, and the screen it draws
//! on. One GLES 3 context lives on the emulation thread for the whole game;
//! a GPU core (PPSSPP, Dolphin, ARMSX2...) draws into a framebuffer object in
//! it, a software core's picture is uploaded to a texture, and either is put
//! on the screen with one glBlitFramebuffer, scaled to fit. No shaders, no
//! read-back: the picture stays on the GPU.
#![allow(non_snake_case, non_upper_case_globals, clippy::upper_case_acronyms)]

use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

pub type EGLDisplay = *mut c_void;
pub type EGLConfig = *mut c_void;
pub type EGLContext = *mut c_void;
pub type EGLSurface = *mut c_void;
pub type GLenum = c_uint;
pub type GLuint = c_uint;
pub type GLint = c_int;
pub type GLsizei = c_int;

pub enum ANativeWindow {}

pub const EGL_NONE: c_int = 0x3038;
const EGL_RED_SIZE: c_int = 0x3024;
const EGL_GREEN_SIZE: c_int = 0x3023;
const EGL_BLUE_SIZE: c_int = 0x3022;
const EGL_ALPHA_SIZE: c_int = 0x3021;
const EGL_DEPTH_SIZE: c_int = 0x3025;
const EGL_STENCIL_SIZE: c_int = 0x3026;
const EGL_RENDERABLE_TYPE: c_int = 0x3040;
const EGL_OPENGL_ES3_BIT: c_int = 0x40;
const EGL_SURFACE_TYPE: c_int = 0x3033;
const EGL_WINDOW_BIT: c_int = 0x4;
const EGL_PBUFFER_BIT: c_int = 0x1;
const EGL_CONTEXT_CLIENT_VERSION: c_int = 0x3098;
const EGL_WIDTH: c_int = 0x3057;
const EGL_HEIGHT: c_int = 0x3056;

pub const GL_TEXTURE_2D: GLenum = 0x0DE1;
pub const GL_RGBA: GLenum = 0x1908;
pub const GL_RGB: GLenum = 0x1907;
pub const GL_RGBA8: GLenum = 0x8058;
pub const GL_RGB565: GLenum = 0x8D62;
pub const GL_UNSIGNED_BYTE: GLenum = 0x1401;
pub const GL_UNSIGNED_SHORT_5_6_5: GLenum = 0x8363;
pub const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
pub const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
pub const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
pub const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
pub const GL_CLAMP_TO_EDGE: GLint = 0x812F;
pub const GL_LINEAR: GLint = 0x2601;
pub const GL_NEAREST: GLint = 0x2600;
pub const GL_TEXTURE_SWIZZLE_R: GLenum = 0x8E42;
pub const GL_TEXTURE_SWIZZLE_B: GLenum = 0x8E44;
pub const GL_TEXTURE_SWIZZLE_A: GLenum = 0x8E45;
pub const GL_RED: GLint = 0x1903;
pub const GL_BLUE: GLint = 0x1905;
pub const GL_ALPHA: GLint = 0x1906;
pub const GL_ONE: GLint = 1;
pub const GL_UNPACK_ALIGNMENT: GLenum = 0x0CF5;
pub const GL_FRAMEBUFFER: GLenum = 0x8D40;
pub const GL_READ_FRAMEBUFFER: GLenum = 0x8CA8;
pub const GL_DRAW_FRAMEBUFFER: GLenum = 0x8CA9;
pub const GL_FRAMEBUFFER_BINDING: GLenum = 0x8CA6;
pub const GL_COLOR_ATTACHMENT0: GLenum = 0x8CE0;
pub const GL_RENDERBUFFER: GLenum = 0x8D41;
pub const GL_DEPTH24_STENCIL8: GLenum = 0x88F0;
pub const GL_DEPTH_COMPONENT24: GLenum = 0x81A6;
pub const GL_DEPTH_STENCIL_ATTACHMENT: GLenum = 0x821A;
pub const GL_DEPTH_ATTACHMENT: GLenum = 0x8D00;
pub const GL_FRAMEBUFFER_COMPLETE: GLenum = 0x8CD5;
pub const GL_COLOR_BUFFER_BIT: c_uint = 0x4000;
pub const GL_SCISSOR_TEST: GLenum = 0x0C11;
pub const GL_VERSION: GLenum = 0x1F02;
pub const GL_RENDERER: GLenum = 0x1F01;

#[link(name = "EGL")]
extern "C" {
    fn eglGetDisplay(id: *mut c_void) -> EGLDisplay;
    fn eglInitialize(d: EGLDisplay, major: *mut c_int, minor: *mut c_int) -> c_uint;
    fn eglChooseConfig(d: EGLDisplay, attrs: *const c_int, configs: *mut EGLConfig, size: c_int, n: *mut c_int) -> c_uint;
    fn eglCreateContext(d: EGLDisplay, c: EGLConfig, share: EGLContext, attrs: *const c_int) -> EGLContext;
    fn eglCreateWindowSurface(d: EGLDisplay, c: EGLConfig, w: *mut ANativeWindow, attrs: *const c_int) -> EGLSurface;
    fn eglCreatePbufferSurface(d: EGLDisplay, c: EGLConfig, attrs: *const c_int) -> EGLSurface;
    fn eglMakeCurrent(d: EGLDisplay, draw: EGLSurface, read: EGLSurface, c: EGLContext) -> c_uint;
    fn eglSwapBuffers(d: EGLDisplay, s: EGLSurface) -> c_uint;
    fn eglSwapInterval(d: EGLDisplay, interval: c_int) -> c_uint;
    fn eglDestroySurface(d: EGLDisplay, s: EGLSurface) -> c_uint;
    fn eglDestroyContext(d: EGLDisplay, c: EGLContext) -> c_uint;
    fn eglTerminate(d: EGLDisplay) -> c_uint;
    fn eglQuerySurface(d: EGLDisplay, s: EGLSurface, attr: c_int, value: *mut c_int) -> c_uint;
    fn eglGetError() -> c_int;
    pub fn eglGetProcAddress(name: *const c_char) -> *mut c_void;
}

#[link(name = "GLESv3")]
extern "C" {
    pub fn glGenTextures(n: GLsizei, t: *mut GLuint);
    pub fn glDeleteTextures(n: GLsizei, t: *const GLuint);
    pub fn glBindTexture(target: GLenum, t: GLuint);
    pub fn glTexParameteri(target: GLenum, pname: GLenum, v: GLint);
    pub fn glTexImage2D(target: GLenum, level: GLint, internal: GLint, w: GLsizei, h: GLsizei, border: GLint, format: GLenum, ty: GLenum, data: *const c_void);
    pub fn glTexSubImage2D(target: GLenum, level: GLint, x: GLint, y: GLint, w: GLsizei, h: GLsizei, format: GLenum, ty: GLenum, data: *const c_void);
    pub fn glPixelStorei(pname: GLenum, v: GLint);
    pub fn glGenFramebuffers(n: GLsizei, f: *mut GLuint);
    pub fn glDeleteFramebuffers(n: GLsizei, f: *const GLuint);
    pub fn glBindFramebuffer(target: GLenum, f: GLuint);
    pub fn glFramebufferTexture2D(target: GLenum, attach: GLenum, textarget: GLenum, t: GLuint, level: GLint);
    pub fn glGenRenderbuffers(n: GLsizei, r: *mut GLuint);
    pub fn glDeleteRenderbuffers(n: GLsizei, r: *const GLuint);
    pub fn glBindRenderbuffer(target: GLenum, r: GLuint);
    pub fn glRenderbufferStorage(target: GLenum, format: GLenum, w: GLsizei, h: GLsizei);
    pub fn glFramebufferRenderbuffer(target: GLenum, attach: GLenum, rbtarget: GLenum, r: GLuint);
    pub fn glCheckFramebufferStatus(target: GLenum) -> GLenum;
    pub fn glBlitFramebuffer(sx0: GLint, sy0: GLint, sx1: GLint, sy1: GLint, dx0: GLint, dy0: GLint, dx1: GLint, dy1: GLint, mask: c_uint, filter: GLenum);
    pub fn glViewport(x: GLint, y: GLint, w: GLsizei, h: GLsizei);
    pub fn glClearColor(r: f32, g: f32, b: f32, a: f32);
    pub fn glClear(mask: c_uint);
    pub fn glDisable(cap: GLenum);
    pub fn glGetIntegerv(pname: GLenum, v: *mut GLint);
    pub fn glGetString(name: GLenum) -> *const u8;
}

#[link(name = "android")]
extern "C" {
    pub fn ANativeWindow_release(w: *mut ANativeWindow);
}

/// The screen: the EGL display, a GLES 3 context, and the surface it draws
/// on (the game's window, or a 1x1 off-screen surface while there is none).
pub struct Screen {
    display: EGLDisplay,
    config: EGLConfig,
    context: EGLContext,
    surface: EGLSurface,
    window: *mut ANativeWindow,
    pub width: i32,
    pub height: i32,
    sw_tex: GLuint,
    sw_fbo: GLuint,
    sw_size: (u32, u32, u32),
}

impl Screen {
    /// Makes the context (current on this thread) with an off-screen surface.
    pub fn new() -> Result<Self, String> {
        unsafe {
            let display = eglGetDisplay(std::ptr::null_mut());
            if display.is_null() || eglInitialize(display, std::ptr::null_mut(), std::ptr::null_mut()) == 0 {
                return Err(format!("EGL didn't start (0x{:x})", eglGetError()));
            }
            let attrs = [
                EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_SURFACE_TYPE, EGL_WINDOW_BIT | EGL_PBUFFER_BIT,
                EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
                EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8, EGL_NONE,
            ];
            let mut config = std::ptr::null_mut();
            let mut n = 0;
            if eglChooseConfig(display, attrs.as_ptr(), &mut config, 1, &mut n) == 0 || n < 1 {
                eglTerminate(display);
                return Err("this phone's GPU has no OpenGL ES 3 configuration".into());
            }
            let ctx_attrs = [EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE];
            let context = eglCreateContext(display, config, std::ptr::null_mut(), ctx_attrs.as_ptr());
            if context.is_null() {
                eglTerminate(display);
                return Err(format!("OpenGL ES 3 context refused (0x{:x})", eglGetError()));
            }
            let pb = [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
            let surface = eglCreatePbufferSurface(display, config, pb.as_ptr());
            if surface.is_null() || eglMakeCurrent(display, surface, surface, context) == 0 {
                eglDestroyContext(display, context);
                eglTerminate(display);
                return Err(format!("couldn't make the OpenGL ES context current (0x{:x})", eglGetError()));
            }
            Ok(Screen { display, config, context, surface, window: std::ptr::null_mut(), width: 1, height: 1, sw_tex: 0, sw_fbo: 0, sw_size: (0, 0, 0) })
        }
    }

    /// "OpenGL ES 3.2 ... on Adreno 650" for the status.
    pub fn description(&self) -> String {
        let s = |e| unsafe {
            let p = glGetString(e);
            if p.is_null() { String::new() } else { CStr::from_ptr(p as *const c_char).to_string_lossy().into_owned() }
        };
        format!("{} on {}", s(GL_VERSION), s(GL_RENDERER))
    }

    pub fn has_window(&self) -> bool {
        !self.window.is_null()
    }

    /// The game's window changed: draws on `window` from now on (owned: it is
    /// released when replaced), or off-screen when None.
    pub fn set_window(&mut self, window: Option<*mut ANativeWindow>) {
        unsafe {
            let pb = [EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
            let next = match window {
                Some(w) if !w.is_null() => eglCreateWindowSurface(self.display, self.config, w, [EGL_NONE].as_ptr()),
                _ => eglCreatePbufferSurface(self.display, self.config, pb.as_ptr()),
            };
            if next.is_null() {
                crate::warn!("android: surface not made (0x{:x})", eglGetError());
                if let Some(w) = window { if !w.is_null() { ANativeWindow_release(w); } }
                return;
            }
            eglMakeCurrent(self.display, next, next, self.context);
            eglDestroySurface(self.display, self.surface);
            if !self.window.is_null() {
                ANativeWindow_release(self.window);
            }
            self.surface = next;
            self.window = window.filter(|w| !w.is_null()).unwrap_or(std::ptr::null_mut());
            // Paced by the engine (the core's own rate), not the screen's
            // 60/90/120 Hz: a 120 Hz phone would otherwise run games twice as fast.
            eglSwapInterval(self.display, 0);
            let (mut w, mut h) = (1, 1);
            eglQuerySurface(self.display, self.surface, EGL_WIDTH, &mut w);
            eglQuerySurface(self.display, self.surface, EGL_HEIGHT, &mut h);
            self.width = w.max(1);
            self.height = h.max(1);
        }
    }

    /// Where a picture of aspect `aspect` goes on the screen: (x, y, w, h), centred.
    fn fit(&self, aspect: f32) -> (i32, i32, i32, i32) {
        let (sw, sh) = (self.width as f32, self.height as f32);
        let a = if aspect.is_finite() && aspect > 0.0 { aspect } else { 4.0 / 3.0 };
        let (w, h) = if sw / sh > a { (sh * a, sh) } else { (sw, sw / a) };
        (((sw - w) / 2.0) as i32, ((sh - h) / 2.0) as i32, w as i32, h as i32)
    }

    /// Copies (0,0)-(w,h) of framebuffer `fbo` to the screen, fitted to
    /// `aspect`; `flip` when its rows run top to bottom. Then shows it.
    pub fn present_framebuffer(&mut self, fbo: GLuint, w: u32, h: u32, flip: bool, aspect: f32, smooth: bool) {
        if self.window.is_null() {
            return;
        }
        let (x, y, dw, dh) = self.fit(aspect);
        unsafe {
            glDisable(GL_SCISSOR_TEST);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
            glViewport(0, 0, self.width, self.height);
            glClearColor(0.0, 0.0, 0.0, 1.0);
            glClear(GL_COLOR_BUFFER_BIT);
            glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
            let (dy0, dy1) = if flip { (y + dh, y) } else { (y, y + dh) };
            glBlitFramebuffer(0, 0, w as GLint, h as GLint, x, dy0, x + dw, dy1, GL_COLOR_BUFFER_BIT, if smooth { GL_LINEAR } else { GL_NEAREST } as GLenum);
            glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
            eglSwapBuffers(self.display, self.surface);
        }
    }

    /// Uploads a software core's picture (tightly packed rows, top first) and
    /// shows it. `format`: 0 = RGB565, 1 = XRGB8888 (B,G,R,X bytes), 2 = RGBA8.
    pub fn present_pixels(&mut self, data: &[u8], w: u32, h: u32, format: u32, aspect: f32) {
        if self.window.is_null() || w == 0 || h == 0 {
            return;
        }
        unsafe {
            if self.sw_tex == 0 {
                glGenTextures(1, &mut self.sw_tex);
                glGenFramebuffers(1, &mut self.sw_fbo);
            }
            glBindTexture(GL_TEXTURE_2D, self.sw_tex);
            let (internal, fmt, ty) = match format {
                0 => (GL_RGB565, GL_RGB, GL_UNSIGNED_SHORT_5_6_5),
                _ => (GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE),
            };
            glPixelStorei(GL_UNPACK_ALIGNMENT, if format == 0 { 2 } else { 4 });
            if self.sw_size != (w, h, format) {
                glTexImage2D(GL_TEXTURE_2D, 0, internal as GLint, w as GLsizei, h as GLsizei, 0, fmt, ty, data.as_ptr() as *const c_void);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                // XRGB8888 is B,G,R,X in memory: read it as RGBA with red and
                // blue swapped and alpha forced to 1 (GLES 3 texture swizzle).
                let bgr = format == 1;
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_R, if bgr { GL_BLUE } else { GL_RED });
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_B, if bgr { GL_RED } else { GL_BLUE });
                glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_A, if format == 2 { GL_ALPHA } else { GL_ONE });
                glBindFramebuffer(GL_FRAMEBUFFER, self.sw_fbo);
                glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, self.sw_tex, 0);
                glBindFramebuffer(GL_FRAMEBUFFER, 0);
                self.sw_size = (w, h, format);
            } else {
                glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w as GLsizei, h as GLsizei, fmt, ty, data.as_ptr() as *const c_void);
            }
            glBindTexture(GL_TEXTURE_2D, 0);
        }
        // Rows were uploaded top first, so the picture is upside down in GL terms.
        let fbo = self.sw_fbo;
        self.present_framebuffer(fbo, w, h, true, aspect, false);
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        unsafe {
            if self.sw_tex != 0 {
                glDeleteTextures(1, &self.sw_tex);
                glDeleteFramebuffers(1, &self.sw_fbo);
            }
            eglMakeCurrent(self.display, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
            eglDestroySurface(self.display, self.surface);
            eglDestroyContext(self.display, self.context);
            eglTerminate(self.display);
            if !self.window.is_null() {
                ANativeWindow_release(self.window);
            }
        }
    }
}
