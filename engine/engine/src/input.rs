//! Controllers read by the engine itself (XInput), and controller hotkeys.
//!
//! Xbox-type controllers (and anything Steam, DS4Windows or the like present
//! as one) are polled straight from XInput each frame on the emulation
//! thread: no browser in between, so input lands on the very next frame, works
//! while the page isn't focused, and rumble reaches the controller. XInput is
//! loaded at run time (xinput1_4, then 1_3, then 9_1_0); the undocumented
//! XInputGetStateEx (ordinal 100) adds the Guide button when it exists.
//! Other controllers (DualSense, Switch Pro...) keep coming from the page's
//! Gamepad API, on the ports after the engine's.
//!
//! Hotkeys with Guide or Back held: RB save, LB load, Start menu, RT
//! fast-forward (held), LT rewind (held); Guide tapped alone opens the menu.
//! Back works the same because Windows often keeps Guide for Xbox Game Bar.
use crate::host::PortInput;
use libretro_sys::*;
use std::time::{Duration, Instant};

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct XInputGamepad {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub thumb_lx: i16,
    pub thumb_ly: i16,
    pub thumb_rx: i16,
    pub thumb_ry: i16,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct XInputState {
    packet: u32,
    pad: XInputGamepad,
}

#[repr(C)]
struct XInputVibration {
    left: u16,
    right: u16,
}

pub const XI_UP: u16 = 0x0001;
pub const XI_DOWN: u16 = 0x0002;
pub const XI_LEFT: u16 = 0x0004;
pub const XI_RIGHT: u16 = 0x0008;
pub const XI_START: u16 = 0x0010;
pub const XI_BACK: u16 = 0x0020;
pub const XI_LTHUMB: u16 = 0x0040;
pub const XI_RTHUMB: u16 = 0x0080;
pub const XI_LB: u16 = 0x0100;
pub const XI_RB: u16 = 0x0200;
pub const XI_GUIDE: u16 = 0x0400;
pub const XI_A: u16 = 0x1000;
pub const XI_B: u16 = 0x2000;
pub const XI_X: u16 = 0x4000;
pub const XI_Y: u16 = 0x8000;

const LEFT_DEADZONE: f32 = 7849.0;
const RIGHT_DEADZONE: f32 = 8689.0;
const TRIGGER_THRESHOLD: u8 = 30;
const ERROR_SUCCESS: u32 = 0;

type GetState = unsafe extern "system" fn(u32, *mut XInputState) -> u32;
type SetState = unsafe extern "system" fn(u32, *mut XInputVibration) -> u32;

/// What a controller asked of the engine (hotkeys), besides playing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hotkey {
    Save,
    Load,
    Menu,
    FastForward(bool),
    Rewind(bool),
}

/// How the face buttons reach the game.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Layout {
    /// By position: the bottom button is the console's bottom button (B on a
    /// SNES pad), as RetroArch does.
    #[default]
    Position,
    /// By label: the button marked A is the console's A.
    Labels,
}

/// One XInput controller's state as the game should see it.
pub fn to_port(p: &XInputGamepad, layout: Layout) -> PortInput {
    let mut b = 0u16;
    let mut set = |on: bool, id: u32| {
        if on {
            b |= 1 << id;
        }
    };
    let x = p.buttons;
    let (a, bb, xx, y) = (x & XI_A != 0, x & XI_B != 0, x & XI_X != 0, x & XI_Y != 0);
    match layout {
        Layout::Position => {
            set(a, RETRO_DEVICE_ID_JOYPAD_B);
            set(bb, RETRO_DEVICE_ID_JOYPAD_A);
            set(xx, RETRO_DEVICE_ID_JOYPAD_Y);
            set(y, RETRO_DEVICE_ID_JOYPAD_X);
        }
        Layout::Labels => {
            set(a, RETRO_DEVICE_ID_JOYPAD_A);
            set(bb, RETRO_DEVICE_ID_JOYPAD_B);
            set(xx, RETRO_DEVICE_ID_JOYPAD_X);
            set(y, RETRO_DEVICE_ID_JOYPAD_Y);
        }
    }
    set(x & XI_UP != 0, RETRO_DEVICE_ID_JOYPAD_UP);
    set(x & XI_DOWN != 0, RETRO_DEVICE_ID_JOYPAD_DOWN);
    set(x & XI_LEFT != 0, RETRO_DEVICE_ID_JOYPAD_LEFT);
    set(x & XI_RIGHT != 0, RETRO_DEVICE_ID_JOYPAD_RIGHT);
    set(x & XI_START != 0, RETRO_DEVICE_ID_JOYPAD_START);
    set(x & XI_BACK != 0, RETRO_DEVICE_ID_JOYPAD_SELECT);
    set(x & XI_LB != 0, RETRO_DEVICE_ID_JOYPAD_L);
    set(x & XI_RB != 0, RETRO_DEVICE_ID_JOYPAD_R);
    set(p.left_trigger > TRIGGER_THRESHOLD, RETRO_DEVICE_ID_JOYPAD_L2);
    set(p.right_trigger > TRIGGER_THRESHOLD, RETRO_DEVICE_ID_JOYPAD_R2);
    set(x & XI_LTHUMB != 0, RETRO_DEVICE_ID_JOYPAD_L3);
    set(x & XI_RTHUMB != 0, RETRO_DEVICE_ID_JOYPAD_R3);
    let (lx, ly) = stick(p.thumb_lx, p.thumb_ly, LEFT_DEADZONE);
    let (rx, ry) = stick(p.thumb_rx, p.thumb_ry, RIGHT_DEADZONE);
    PortInput {
        buttons: b,
        sticks: [[lx, ly], [rx, ry]],
        triggers: [trigger(p.left_trigger), trigger(p.right_trigger)],
    }
}

/// A stick with a radial dead zone, rescaled so the edge of the dead zone is
/// zero and full tilt is full; up is negative (libretro), XInput's up is positive.
pub fn stick(x: i16, y: i16, deadzone: f32) -> (i16, i16) {
    let (fx, fy) = (x as f32, -(y as f32).max(-32767.0));
    let mag = (fx * fx + fy * fy).sqrt();
    if mag <= deadzone {
        return (0, 0);
    }
    let scaled = ((mag - deadzone) / (32767.0 - deadzone)).min(1.0);
    let k = scaled * 32767.0 / mag;
    ((fx * k).clamp(-32768.0, 32767.0) as i16, (fy * k).clamp(-32768.0, 32767.0) as i16)
}

fn trigger(v: u8) -> i16 {
    (v as i32 * 32767 / 255) as i16
}

/// Turns Guide and Back combinations into hotkeys, and keeps them from the game.
///
/// Guide is the natural hotkey button, but Windows often keeps it for itself
/// (Xbox Game Bar), so Back works the same way: Back + RB save, + LB load,
/// + Start menu, + RT fast-forward (held), + LT rewind (held). Back alone is
/// still Select for the game; only a combination is kept from it.
#[derive(Default)]
pub struct Chords {
    prev: u16,
    /// Raw trigger states last read (hotkeys fire on the trigger's own press).
    raw_lt: bool,
    raw_rt: bool,
    /// Rewind / fast-forward held through a hotkey.
    hk_lt: bool,
    hk_rt: bool,
    /// Something else was pressed while Guide was down (so releasing Guide isn't "menu").
    used: bool,
    /// A Back combination fired: the game doesn't see this controller until Back is released.
    back_combo: bool,
    /// Reads in a row with Guide up: a release counts only after a few, since
    /// some controllers drop the Guide bit for a single read.
    guide_up: u8,
}

/// Reads with Guide up before it counts as released (~50 ms at 60 reads a second).
const GUIDE_RELEASE_READS: u8 = 3;

impl Chords {
    /// Hotkeys from this poll; `true` when the game shouldn't see this
    /// controller now (Guide held, or a Back combination in progress).
    pub fn update(&mut self, p: &XInputGamepad, out: &mut Vec<Hotkey>) -> bool {
        let raw_guide = p.buttons & XI_GUIDE != 0;
        let held_before = self.prev & XI_GUIDE != 0;
        self.guide_up = if raw_guide { 0 } else { self.guide_up.saturating_add(1) };
        let guide = raw_guide || (held_before && self.guide_up < GUIDE_RELEASE_READS);
        let now = if guide { p.buttons | XI_GUIDE } else { p.buttons & !XI_GUIDE };
        let pressed = now & !self.prev;
        let back = now & XI_BACK != 0;
        let modifier = guide || back;
        let lt = p.left_trigger > TRIGGER_THRESHOLD;
        let rt = p.right_trigger > TRIGGER_THRESHOLD;
        if guide && pressed & XI_GUIDE != 0 {
            self.used = false;
        }
        if modifier {
            let mut fired = |hk: Hotkey, out: &mut Vec<Hotkey>| {
                out.push(hk);
                self.used = true;
                if !guide {
                    self.back_combo = true;
                }
            };
            if pressed & XI_RB != 0 {
                fired(Hotkey::Save, out);
            }
            if pressed & XI_LB != 0 {
                fired(Hotkey::Load, out);
            }
            if pressed & XI_START != 0 {
                fired(Hotkey::Menu, out);
            }
            if rt && !self.raw_rt && !self.hk_rt {
                self.hk_rt = true;
                fired(Hotkey::FastForward(true), out);
            }
            if lt && !self.raw_lt && !self.hk_lt {
                self.hk_lt = true;
                fired(Hotkey::Rewind(true), out);
            }
        }
        if self.hk_rt && (!rt || !modifier) {
            self.hk_rt = false;
            out.push(Hotkey::FastForward(false));
        }
        if self.hk_lt && (!lt || !modifier) {
            self.hk_lt = false;
            out.push(Hotkey::Rewind(false));
        }
        // Guide released alone: the menu.
        if held_before && !guide && !self.used {
            out.push(Hotkey::Menu);
        }
        if !back {
            self.back_combo = false;
        }
        self.prev = now;
        self.raw_lt = lt;
        self.raw_rt = rt;
        guide || self.back_combo
    }
}

struct Slot {
    connected: bool,
    checked: Option<Instant>,
    pad: XInputGamepad,
    chords: Chords,
    rumble: (u16, u16),
}

/// SAVESTATE_TRACE_PADS=1 logs every change a controller reports.
fn trace() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("SAVESTATE_TRACE_PADS").is_some_and(|v| v != "0"))
}

/// The XInput controllers on this PC.
pub struct Native {
    _lib: Option<libloading::Library>,
    get: Option<GetState>,
    set: Option<SetState>,
    pub guide: bool,
    slots: [Slot; 4],
    pub layout: Layout,
}

impl Native {
    pub fn open() -> Self {
        let mut n = Native { _lib: None, get: None, set: None, guide: false, slots: std::array::from_fn(|_| Slot { connected: false, checked: None, pad: XInputGamepad::default(), chords: Chords::default(), rumble: (0, 0) }), layout: Layout::Position };
        for name in ["xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll"] {
            let Ok(lib) = (unsafe { libloading::Library::new(name) }) else { continue };
            unsafe {
                let ex: Option<GetState> = {
                    let w: libloading::os::windows::Library = lib.into();
                    let ex = w.get_ordinal::<GetState>(100).ok().map(|s| *s);
                    let lib: libloading::Library = w.into();
                    n.get = ex.or_else(|| lib.get::<GetState>(b"XInputGetState\0").ok().map(|s| *s));
                    n.set = lib.get::<SetState>(b"XInputSetState\0").ok().map(|s| *s);
                    n._lib = Some(lib);
                    ex
                };
                n.guide = ex.is_some();
            }
            crate::info!("controllers: {name}{}", if n.guide { " (with the Guide button)" } else { "" });
            break;
        }
        n
    }

    pub fn available(&self) -> bool {
        self.get.is_some()
    }

    /// Reads the controllers. Unplugged slots are asked once a second
    /// (asking an empty XInput slot is slow). Returns, in slot order, the
    /// input of each connected controller (None while it's in hotkey mode)
    /// and appends hotkeys to `hotkeys`.
    pub fn poll(&mut self, hotkeys: &mut Vec<Hotkey>) -> Vec<Option<PortInput>> {
        let Some(get) = self.get else { return Vec::new() };
        let mut out = Vec::new();
        let now = Instant::now();
        for (i, s) in self.slots.iter_mut().enumerate() {
            if !s.connected && s.checked.is_some_and(|t| now.duration_since(t) < Duration::from_secs(1)) {
                continue;
            }
            s.checked = Some(now);
            let mut st = XInputState::default();
            let ok = unsafe { get(i as u32, &mut st) } == ERROR_SUCCESS;
            if !ok {
                s.connected = false;
                continue;
            }
            s.connected = true;
            if st.pad != s.pad && trace() {
                crate::log::emit(crate::log::Level::Info, "pads", &format!("slot {i}: buttons {:04x} lt {} rt {}", st.pad.buttons, st.pad.left_trigger, st.pad.right_trigger));
            }
            s.pad = st.pad;
            let hotkey_mode = s.chords.update(&st.pad, hotkeys);
            out.push(if hotkey_mode { None } else { Some(to_port(&st.pad, self.layout)) });
        }
        out
    }

    /// How many controllers are connected.
    pub fn count(&self) -> usize {
        self.slots.iter().filter(|s| s.connected).count()
    }

    /// Rumble for the controller on game port `port` (the n-th connected one).
    pub fn rumble(&mut self, port: usize, strong: u16, weak: u16) {
        let Some(set) = self.set else { return };
        if let Some((i, s)) = self.slots.iter_mut().enumerate().filter(|(_, s)| s.connected).nth(port) {
            if s.rumble != (strong, weak) {
                s.rumble = (strong, weak);
                let mut v = XInputVibration { left: strong, right: weak };
                unsafe { set(i as u32, &mut v) };
            }
        }
    }

    /// Stops every motor (the game closed or paused).
    pub fn quiet(&mut self) {
        for port in 0..4 {
            self.rumble(port, 0, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_buttons_by_position_and_by_label() {
        let pad = XInputGamepad { buttons: XI_A | XI_UP | XI_START, right_trigger: 200, ..Default::default() };
        let p = to_port(&pad, Layout::Position);
        assert_eq!(p.buttons & (1 << RETRO_DEVICE_ID_JOYPAD_B), 1 << RETRO_DEVICE_ID_JOYPAD_B);
        assert_eq!(p.buttons & (1 << RETRO_DEVICE_ID_JOYPAD_A), 0);
        assert_ne!(p.buttons & (1 << RETRO_DEVICE_ID_JOYPAD_UP), 0);
        assert_ne!(p.buttons & (1 << RETRO_DEVICE_ID_JOYPAD_START), 0);
        assert_ne!(p.buttons & (1 << RETRO_DEVICE_ID_JOYPAD_R2), 0);
        assert!(p.triggers[1] > 25_000);
        let l = to_port(&pad, Layout::Labels);
        assert_ne!(l.buttons & (1 << RETRO_DEVICE_ID_JOYPAD_A), 0);
    }

    #[test]
    fn sticks_have_a_dead_zone_and_up_is_negative() {
        assert_eq!(stick(3000, -3000, LEFT_DEADZONE), (0, 0));
        let (x, y) = stick(0, 32767, LEFT_DEADZONE);
        assert_eq!(x, 0);
        assert!(y <= -32700);
        let (x, _) = stick(32767, 0, LEFT_DEADZONE);
        assert!(x >= 32700);
    }

    #[test]
    fn guide_combinations_are_hotkeys() {
        let mut c = Chords::default();
        let mut out = Vec::new();
        let g = |b: u16, lt: u8, rt: u8| XInputGamepad { buttons: b, left_trigger: lt, right_trigger: rt, ..Default::default() };
        assert!(c.update(&g(XI_GUIDE, 0, 0), &mut out));
        assert!(c.update(&g(XI_GUIDE | XI_RB, 0, 0), &mut out));
        assert!(c.update(&g(XI_GUIDE, 0, 255), &mut out));
        for _ in 0..GUIDE_RELEASE_READS - 1 {
            assert!(c.update(&g(0, 0, 0), &mut out));
        }
        assert!(!c.update(&g(0, 0, 0), &mut out));
        assert_eq!(out, vec![Hotkey::Save, Hotkey::FastForward(true), Hotkey::FastForward(false)]);
        out.clear();
        // A tap of Guide alone opens the menu (once it's been up a few reads).
        c.update(&g(XI_GUIDE, 0, 0), &mut out);
        for _ in 0..GUIDE_RELEASE_READS {
            c.update(&g(0, 0, 0), &mut out);
        }
        assert_eq!(out, vec![Hotkey::Menu]);
        out.clear();
        // A one-read dropout of Guide is not a release.
        c.update(&g(XI_GUIDE, 0, 0), &mut out);
        c.update(&g(0, 0, 0), &mut out);
        c.update(&g(XI_GUIDE | XI_RB, 0, 0), &mut out);
        assert_eq!(out, vec![Hotkey::Save]);
        for _ in 0..GUIDE_RELEASE_READS {
            c.update(&g(0, 0, 0), &mut out);
        }
        assert_eq!(out, vec![Hotkey::Save]);
    }

    #[test]
    fn back_combinations_are_hotkeys_and_back_alone_is_select() {
        let mut c = Chords::default();
        let mut out = Vec::new();
        let g = |b: u16, lt: u8, rt: u8| XInputGamepad { buttons: b, left_trigger: lt, right_trigger: rt, ..Default::default() };
        // Back alone: the game sees it.
        assert!(!c.update(&g(XI_BACK, 0, 0), &mut out));
        assert!(out.is_empty());
        // Back + LB: load, and the game stops seeing the controller until Back is let go.
        assert!(c.update(&g(XI_BACK | XI_LB, 0, 0), &mut out));
        assert!(c.update(&g(XI_BACK, 0, 0), &mut out));
        assert!(!c.update(&g(0, 0, 0), &mut out));
        assert_eq!(out, vec![Hotkey::Load]);
        out.clear();
        // Back + LT held: rewind while held.
        c.update(&g(XI_BACK, 0, 0), &mut out);
        assert!(c.update(&g(XI_BACK, 255, 0), &mut out));
        c.update(&g(XI_BACK, 0, 0), &mut out);
        assert_eq!(out, vec![Hotkey::Rewind(true), Hotkey::Rewind(false)]);
        out.clear();
        // A trigger already held when Back is pressed is not a hotkey.
        c.update(&g(0, 0, 0), &mut out);
        c.update(&g(0, 0, 255), &mut out);
        c.update(&g(XI_BACK, 0, 255), &mut out);
        assert!(out.is_empty());
        // Back + Start opens the menu.
        c.update(&g(0, 0, 0), &mut out);
        c.update(&g(XI_BACK | XI_START, 0, 0), &mut out);
        assert_eq!(out, vec![Hotkey::Menu]);
    }
}
