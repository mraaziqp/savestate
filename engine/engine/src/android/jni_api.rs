//! What the SaveState app calls (Java class com.savestate.nexus.NxEngine,
//! static native methods). One game at a time; see player.rs.
use super::gles::ANativeWindow;
use super::player::{self, Cmd, Start, Window};
use crate::host::PortInput;
use jni::objects::{JClass, JObject, JString};
use jni::sys::{jboolean, jint, jstring, JNI_TRUE};
use jni::JNIEnv;
use std::path::PathBuf;

#[link(name = "android")]
extern "C" {
    fn ANativeWindow_fromSurface(env: *mut jni::sys::JNIEnv, surface: jni::sys::jobject) -> *mut ANativeWindow;
}

fn string(env: &mut JNIEnv, s: &JString) -> String {
    if s.is_null() {
        return String::new();
    }
    env.get_string(s).map(|v| v.into()).unwrap_or_default()
}

fn window(env: &mut JNIEnv, surface: &JObject) -> Option<Window> {
    if surface.is_null() {
        return None;
    }
    let w = unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) };
    if w.is_null() { None } else { Some(Window(w)) }
}

/// Starts a game: the core library, the game file, the folders for system
/// files, saves and cache, and the Surface to draw on.
#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativeStart<'l>(
    mut env: JNIEnv<'l>, _class: JClass<'l>, core: JString<'l>, game: JString<'l>, system: JString<'l>, saves: JString<'l>, cache: JString<'l>, surface: JObject<'l>,
) {
    let s = Start {
        core: PathBuf::from(string(&mut env, &core)),
        game: PathBuf::from(string(&mut env, &game)),
        system_dir: PathBuf::from(string(&mut env, &system)),
        save_dir: PathBuf::from(string(&mut env, &saves)),
        cache_dir: PathBuf::from(string(&mut env, &cache)),
        window: window(&mut env, &surface),
    };
    crate::info!("android: start {} with {}", s.game.display(), s.core.display());
    player::start(s);
}

/// The game's Surface was created or changed (null: it went away).
#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativeSurface<'l>(mut env: JNIEnv<'l>, _class: JClass<'l>, surface: JObject<'l>) {
    player::send(Cmd::Window(window(&mut env, &surface)));
}

/// Controller state for one player: RETRO_DEVICE_ID_JOYPAD bits and the two sticks.
#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativeInput<'l>(
    _env: JNIEnv<'l>, _class: JClass<'l>, port: jint, buttons: jint, lx: jint, ly: jint, rx: jint, ry: jint,
) {
    let c = |v: jint| v.clamp(-32768, 32767) as i16;
    let i = PortInput { buttons: buttons as u16, sticks: [[c(lx), c(ly)], [c(rx), c(ry)]], triggers: [0, 0] };
    player::send(Cmd::Input(port.max(0) as usize, i));
}

#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativePause<'l>(_env: JNIEnv<'l>, _class: JClass<'l>, paused: jboolean) {
    player::send(Cmd::Pause(paused == JNI_TRUE));
}

#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativeSaveState<'l>(mut env: JNIEnv<'l>, _class: JClass<'l>, path: JString<'l>) {
    let p = string(&mut env, &path);
    player::send(Cmd::SaveState(PathBuf::from(p)));
}

#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativeLoadState<'l>(mut env: JNIEnv<'l>, _class: JClass<'l>, path: JString<'l>) {
    let p = string(&mut env, &path);
    player::send(Cmd::LoadState(PathBuf::from(p)));
}

/// Stops the game (battery save written) and waits for it to end.
#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativeStop<'l>(_env: JNIEnv<'l>, _class: JClass<'l>) {
    player::stop();
}

/// The player's state as JSON: running, paused, fps, error, core, gpu, size, sound, message.
#[no_mangle]
pub extern "system" fn Java_com_savestate_nexus_NxEngine_nativeStatus<'l>(env: JNIEnv<'l>, _class: JClass<'l>) -> jstring {
    let json = serde_json::to_string(&player::status()).unwrap_or_else(|_| "{}".into());
    env.new_string(json).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}
