//! SaveState Engine: SaveState's own libretro host.
//!
//! See SAVESTATE_ENGINE_SPEC.md (repository root) for the design. Phase 2:
//! the core loader (`loader`), the environment switchboard (`env`), core
//! options (`options`), frames (`video`), the VFS with host streaming (`vfs`),
//! system files (`bios`) and a running game (`session`).
pub mod log;

pub mod bios;
pub mod env;
pub mod host;
pub mod input;
pub mod loader;
pub mod options;
pub mod rewind;
pub mod audio;
pub mod session;
pub mod sync;
pub mod timing;
pub mod vfs;
pub mod video;

// The PC's GPU context (WGL), capture bridge, virtual controllers and the
// page's WebSocket server are Windows parts. Elsewhere (Android, Phase 7)
// the picture is drawn by the app itself (android::, hw_egl.rs: EGL/GLES).
#[cfg(windows)]
pub mod capture;
#[cfg(windows)]
pub mod hw;
#[cfg(target_os = "android")]
#[path = "hw_egl.rs"]
pub mod hw;
#[cfg(all(not(windows), not(target_os = "android")))]
#[path = "hw_none.rs"]
pub mod hw;
#[cfg(target_os = "android")]
pub mod android;
#[cfg(windows)]
pub mod serve;
#[cfg(windows)]
pub mod vigem;
#[cfg(windows)]
pub mod ws;

pub use session::{Content, Session, SessionConfig};
