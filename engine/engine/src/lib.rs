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
pub mod hw;
pub mod loader;
pub mod options;
pub mod audio;
pub mod serve;
pub mod session;
pub mod timing;
pub mod vfs;
pub mod video;
pub mod ws;

pub use session::{Content, Session, SessionConfig};
