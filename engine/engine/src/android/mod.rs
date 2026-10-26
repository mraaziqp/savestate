//! The SaveState Android app's own player (Phase 7, SAVESTATE_ENGINE_SPEC.md
//! 14): the engine runs cores inside the app, drawing with OpenGL ES straight
//! to the game's window, with AAudio sound. No other emulator app needed.
pub mod audio;
pub mod gles;
mod jni_api;
pub mod player;
