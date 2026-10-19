//! Virtual Xbox 360 controllers through the ViGEmBus driver.
//!
//! When the engine shows another emulator's window (capture.rs), that
//! emulator reads controllers itself. The page's controls (keyboard,
//! controllers the browser reads) reach it as virtual Xbox 360 controllers
//! plugged into ViGEmBus (installed with Sunshine, and by many controller
//! tools). The driver is used directly through its device interface, the
//! same requests the ViGEmClient library makes, so no extra DLL ships.
//! Without the driver the emulator still gets the person's real
//! controllers; the page's own controls then have nowhere to go.
use crate::host::PortInput;
use libretro_sys::*;
use std::ffi::c_void;
use windows::core::{GUID, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW, SetupDiGetDeviceInterfaceDetailW, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT,
    SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W,
};
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
use windows::Win32::System::IO::DeviceIoControl;

/// The bus's device interface ({96E42B22-F5E9-42F8-B043-ED0F932F014F}).
const BUS: GUID = GUID::from_u128(0x96E42B22_F5E9_42F8_B043_ED0F932F014F);
const fn ctl(function: u32) -> u32 {
    // CTL_CODE(FILE_DEVICE_BUS_EXTENDER, function, METHOD_BUFFERED, FILE_WRITE_DATA)
    (0x2A << 16) | (2 << 14) | (function << 2)
}
const IOCTL_PLUGIN: u32 = ctl(0x801);
const IOCTL_UNPLUG: u32 = ctl(0x802);
const IOCTL_CHECK_VERSION: u32 = ctl(0x803);
const IOCTL_WAIT_READY: u32 = ctl(0x804);
const IOCTL_XUSB_REPORT: u32 = ctl(0xA02);
const COMMON_VERSION: u32 = 0x0001;

#[repr(C)]
struct CheckVersion {
    size: u32,
    version: u32,
}
#[repr(C)]
struct Plugin {
    size: u32,
    serial: u32,
    target_type: u32,
    vendor: u16,
    product: u16,
}
#[repr(C)]
struct Serial {
    size: u32,
    serial: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct XusbReport {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub lx: i16,
    pub ly: i16,
    pub rx: i16,
    pub ry: i16,
}
#[repr(C)]
struct SubmitReport {
    size: u32,
    serial: u32,
    report: XusbReport,
}

pub struct Bus {
    handle: HANDLE,
    /// Serial number of each port's virtual controller (0 = none yet).
    pads: [u32; 4],
    last: [XusbReport; 4],
    /// When each port's controller was plugged in, and when its state was last resent.
    plugged: [Option<(std::time::Instant, std::time::Instant)>; 4],
}

// SAFETY: the handle is used from the one thread that owns the Bus.
unsafe impl Send for Bus {}

fn ioctl<T>(h: HANDLE, code: u32, data: &mut T) -> bool {
    let mut ret = 0u32;
    let p = data as *mut T as *mut c_void;
    let n = std::mem::size_of::<T>() as u32;
    unsafe { DeviceIoControl(h, code, Some(p), n, Some(p), n, Some(&mut ret), None).is_ok() }
}

impl Bus {
    /// Opens the driver; None when ViGEmBus isn't installed.
    pub fn open() -> Option<Self> {
        unsafe {
            let set = SetupDiGetClassDevsW(Some(&BUS), PCWSTR::null(), None, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE).ok()?;
            let mut iface = SP_DEVICE_INTERFACE_DATA { cbSize: std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32, ..Default::default() };
            let found = SetupDiEnumDeviceInterfaces(set, None, &BUS, 0, &mut iface).is_ok();
            let mut path: Option<Vec<u16>> = None;
            if found {
                let mut need = 0u32;
                let _ = SetupDiGetDeviceInterfaceDetailW(set, &iface, None, 0, Some(&mut need), None);
                let mut buf = vec![0u8; need as usize + 8];
                let detail = buf.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
                (*detail).cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
                if SetupDiGetDeviceInterfaceDetailW(set, &iface, Some(detail), need, None, None).is_ok() {
                    let start = std::ptr::addr_of!((*detail).DevicePath) as *const u16;
                    let mut len = 0;
                    while *start.add(len) != 0 {
                        len += 1;
                    }
                    let mut p: Vec<u16> = std::slice::from_raw_parts(start, len).to_vec();
                    p.push(0);
                    path = Some(p);
                }
            }
            let _ = SetupDiDestroyDeviceInfoList(set);
            let path = path?;
            let handle = CreateFileW(PCWSTR(path.as_ptr()), (GENERIC_READ | GENERIC_WRITE).0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None).ok()?;
            let mut v = CheckVersion { size: 8, version: COMMON_VERSION };
            if !ioctl(handle, IOCTL_CHECK_VERSION, &mut v) {
                let _ = CloseHandle(handle);
                crate::warn!("ViGEmBus is installed but answered the version check with an error");
                return None;
            }
            crate::info!("virtual controllers: ViGEmBus");
            Some(Self { handle, pads: [0; 4], last: [XusbReport::default(); 4], plugged: [None; 4] })
        }
    }

    /// Plugs in a virtual Xbox 360 controller for `port` (once).
    fn ensure(&mut self, port: usize) -> Option<u32> {
        if self.pads[port] != 0 {
            return Some(self.pads[port]);
        }
        for serial in 1..=16u32 {
            let mut p = Plugin { size: std::mem::size_of::<Plugin>() as u32, serial, target_type: 0, vendor: 0x045E, product: 0x028E };
            if ioctl(self.handle, IOCTL_PLUGIN, &mut p) {
                let mut w = Serial { size: 8, serial };
                // Older buses don't know this request; the controller is usable anyway.
                let _ = ioctl(self.handle, IOCTL_WAIT_READY, &mut w);
                self.pads[port] = serial;
                let now = std::time::Instant::now();
                self.plugged[port] = Some((now, now));
                crate::info!("virtual controller {serial} for player {}", port + 1);
                return Some(serial);
            }
        }
        None
    }

    /// Sends a port's controls to its virtual controller (plugged in on the
    /// first press, so idle ports don't show up as controllers).
    pub fn send(&mut self, port: usize, input: &PortInput) {
        if port >= 4 {
            return;
        }
        let report = to_xusb(input);
        if report == self.last[port] {
            return;
        }
        if self.pads[port] == 0 && report == XusbReport::default() {
            return;
        }
        let Some(serial) = self.ensure(port) else { return };
        self.last[port] = report;
        self.submit(serial, report);
    }

    fn submit(&self, serial: u32, report: XusbReport) {
        let mut r = SubmitReport { size: std::mem::size_of::<SubmitReport>() as u32, serial, report };
        let _ = ioctl(self.handle, IOCTL_XUSB_REPORT, &mut r);
    }

    /// Call often: for 3 s after a controller is plugged in, Windows may not
    /// have attached it yet and drops what it's sent, so its state is sent
    /// again every 100 ms until then.
    pub fn tick(&mut self) {
        let now = std::time::Instant::now();
        for port in 0..4 {
            if let Some((at, last)) = self.plugged[port] {
                if now.duration_since(at) > std::time::Duration::from_secs(3) {
                    self.plugged[port] = None;
                } else if now.duration_since(last) >= std::time::Duration::from_millis(100) {
                    self.plugged[port] = Some((at, now));
                    self.submit(self.pads[port], self.last[port]);
                }
            }
        }
    }

    /// How many virtual controllers are plugged in.
    pub fn count(&self) -> usize {
        self.pads.iter().filter(|s| **s != 0).count()
    }
}

impl Drop for Bus {
    fn drop(&mut self) {
        for serial in self.pads.iter().copied().filter(|s| *s != 0) {
            let mut u = Serial { size: 8, serial };
            let _ = ioctl(self.handle, IOCTL_UNPLUG, &mut u);
        }
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// libretro's controls as an Xbox 360 report: the console's bottom button
/// (B on a SNES pad) is the Xbox's bottom button (A), and so on by position.
pub fn to_xusb(p: &PortInput) -> XusbReport {
    let on = |id: u32| p.buttons & (1 << id) != 0;
    let mut b = 0u16;
    for (id, bit) in [
        (RETRO_DEVICE_ID_JOYPAD_UP, 0x0001),
        (RETRO_DEVICE_ID_JOYPAD_DOWN, 0x0002),
        (RETRO_DEVICE_ID_JOYPAD_LEFT, 0x0004),
        (RETRO_DEVICE_ID_JOYPAD_RIGHT, 0x0008),
        (RETRO_DEVICE_ID_JOYPAD_START, 0x0010),
        (RETRO_DEVICE_ID_JOYPAD_SELECT, 0x0020),
        (RETRO_DEVICE_ID_JOYPAD_L3, 0x0040),
        (RETRO_DEVICE_ID_JOYPAD_R3, 0x0080),
        (RETRO_DEVICE_ID_JOYPAD_L, 0x0100),
        (RETRO_DEVICE_ID_JOYPAD_R, 0x0200),
        (RETRO_DEVICE_ID_JOYPAD_B, 0x1000),
        (RETRO_DEVICE_ID_JOYPAD_A, 0x2000),
        (RETRO_DEVICE_ID_JOYPAD_Y, 0x4000),
        (RETRO_DEVICE_ID_JOYPAD_X, 0x8000),
    ] {
        if on(id) {
            b |= bit;
        }
    }
    let trig = |analog: i16, digital: bool| -> u8 { if analog > 0 { (analog as i32 * 255 / 32767) as u8 } else if digital { 255 } else { 0 } };
    // libretro's up is negative, XInput's is positive.
    let up = |v: i16| -> i16 { (-(v as i32)).clamp(-32768, 32767) as i16 };
    XusbReport {
        buttons: b,
        left_trigger: trig(p.triggers[0], on(RETRO_DEVICE_ID_JOYPAD_L2)),
        right_trigger: trig(p.triggers[1], on(RETRO_DEVICE_ID_JOYPAD_R2)),
        lx: p.sticks[0][0],
        ly: up(p.sticks[0][1]),
        rx: p.sticks[1][0],
        ry: up(p.sticks[1][1]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_map_to_xbox_by_position() {
        let p = PortInput { buttons: (1 << RETRO_DEVICE_ID_JOYPAD_B) | (1 << RETRO_DEVICE_ID_JOYPAD_START) | (1 << RETRO_DEVICE_ID_JOYPAD_R2), sticks: [[0, -32768], [0, 0]], triggers: [0, 0] };
        let r = to_xusb(&p);
        assert_eq!(r.buttons, 0x1000 | 0x0010);
        assert_eq!(r.right_trigger, 255);
        assert_eq!(r.ly, 32767);
        // The request codes ViGEmClient uses.
        assert_eq!(IOCTL_PLUGIN, 0x2AA004);
        assert_eq!(IOCTL_XUSB_REPORT, 0x2AA808);
    }
}
