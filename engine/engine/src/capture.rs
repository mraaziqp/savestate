//! `savestate-engine capture`: another emulator, shown inside the SaveState page.
//!
//! For consoles no libretro core plays well (PS3 in RPCS3, Switch in
//! Ryujinx, Wii U in Cemu, Xbox in xemu) and for standalone PCSX2/PPSSPP,
//! the engine starts the emulator windowed, finds its game window, moves
//! it off-screen (it keeps drawing) and gives the keyboard back to the
//! browser. Windows Graphics Capture delivers each picture the emulator
//! presents as a GPU texture; it is copied to a CPU-readable texture,
//! cropped to the window's client area and sent to the page exactly like
//! a libretro game's picture (serve.rs's host and protocol, format 1, BGRA).
//!
//! Controls: the emulator reads the person's controllers itself; the page's
//! keyboard and its own controllers reach it as virtual Xbox 360 controllers
//! (vigem.rs). Sound: the emulator plays it itself on this PC.
//! Quitting closes the emulator (and anything it started).
use crate::serve::{self, Command, Shared};
use crate::vigem::Bus;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Child;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::core::{factory, Interface};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{BOOL, HMODULE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11ShaderResourceView, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_RESOURCE_MISC_GENERATE_MIPS, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetForegroundWindow, GetSystemMetrics, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow, GW_OWNER, SM_CXVIRTUALSCREEN, SM_XVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_RESTORE,
    WM_CLOSE,
};

pub struct CaptureConfig {
    pub exe: PathBuf,
    pub args: Vec<String>,
    /// The game's name, for the page.
    pub title: String,
    /// The emulator's name ("RPCS3"), for the page.
    pub emulator: String,
    pub key: String,
    pub port: u16,
    pub origins: Vec<String>,
    pub idle_exit: Duration,
    /// Move the emulator's window off-screen (it keeps drawing); otherwise it stays where it opens.
    pub offscreen: bool,
}

pub fn run(cfg: CaptureConfig) -> i32 {
    let (key, port, origins) = (cfg.key.clone(), cfg.port, cfg.origins.clone());
    serve::host(port, key, origins, move |shared, rx, tx| capture(cfg, shared, rx, tx))
}

// ── Finding the emulator's window ───────────────────────────────────────
/// The process and everything it started (some emulators draw from a child).
fn process_tree(root: u32) -> Vec<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    let mut all = vec![root];
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return all };
        let mut pairs = Vec::new();
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                pairs.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snap);
        let mut i = 0;
        while i < all.len() {
            let parent = all[i];
            for (pid, ppid) in &pairs {
                if *ppid == parent && !all.contains(pid) {
                    all.push(*pid);
                }
            }
            i += 1;
        }
    }
    all
}

/// The biggest visible top-level window of these processes.
fn game_window(pids: &[u32]) -> Option<HWND> {
    struct Ctx<'a> {
        pids: &'a [u32],
        best: Option<(HWND, i64)>,
    }
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
        let ctx = &mut *(l.0 as *mut Ctx);
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if ctx.pids.contains(&pid) && IsWindowVisible(h).as_bool() && GetWindow(h, GW_OWNER).map(|o| o.is_invalid()).unwrap_or(true) && GetWindowTextLengthW(h) >= 0 {
            let mut r = RECT::default();
            if GetClientRect(h, &mut r).is_ok() {
                let area = (r.right - r.left) as i64 * (r.bottom - r.top) as i64;
                if area >= 200 * 150 && ctx.best.map(|b| area > b.1).unwrap_or(true) {
                    ctx.best = Some((h, area));
                }
            }
        }
        BOOL(1)
    }
    let mut ctx = Ctx { pids, best: None };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.best.map(|b| b.0)
}

/// Where the client area sits inside the captured picture (which includes the frame), and its size.
fn client_crop(hwnd: HWND) -> Option<(u32, u32, u32, u32)> {
    unsafe {
        let mut frame = RECT::default();
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).ok()?;
        let mut pt = POINT::default();
        if !ClientToScreen(hwnd, &mut pt).as_bool() {
            return None;
        }
        let mut cr = RECT::default();
        GetClientRect(hwnd, &mut cr).ok()?;
        Some(((pt.x - frame.left).max(0) as u32, (pt.y - frame.top).max(0) as u32, cr.right.max(0) as u32, cr.bottom.max(0) as u32))
    }
}

/// Moves the window just past the right edge of every screen: it keeps
/// drawing (the capture still gets its pictures) without covering anything.
fn park_offscreen(hwnd: HWND) {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 64;
        let _ = SetWindowPos(hwnd, None, x, 0, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

/// Gives the keyboard back to the browser the person pressed Play in.
fn refocus(window: HWND) {
    unsafe {
        if window.is_invalid() || !IsWindow(window).as_bool() {
            return;
        }
        if !SetForegroundWindow(window).as_bool() {
            // Windows lets a background process take the foreground right after an Alt press.
            keybd_event(VK_MENU.0 as u8, 0, Default::default(), 0);
            let _ = SetForegroundWindow(window);
            keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
    }
}

// ── Windows Graphics Capture ────────────────────────────────────────────
struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt: IDirect3DDevice,
}

impl Gpu {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))?;
            let device: ID3D11Device = device.ok_or_else(windows::core::Error::empty)?;
            let dxgi: IDXGIDevice = device.cast()?;
            let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
            Ok(Self { device, context: context.ok_or_else(windows::core::Error::empty)?, winrt })
        }
    }
}

/// Pictures wider than this are halved on the GPU before they're read back
/// (1080p and up: 8 MB a frame is more than the page can take 60 times a second).
const HALVE_ABOVE: u32 = 1600;

struct Capture {
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    size: SizeInt32,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    /// A two-level mip texture for halving big pictures (its second level is the half-size picture).
    half: Option<(ID3D11Texture2D, ID3D11ShaderResourceView, u32, u32)>,
}

impl Capture {
    fn start(gpu: &Gpu, hwnd: HWND) -> windows::core::Result<Self> {
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd)? };
        let size = item.Size()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&gpu.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsCursorCaptureEnabled(false);
        // Windows 11 only (no yellow frame); Windows 10 draws one around the parked window.
        let _ = session.SetIsBorderRequired(false);
        session.StartCapture()?;
        Ok(Self { _item: item, pool, session, size, staging: None, half: None })
    }

    /// The newest picture, if one arrived: (BGRA rows of the crop, width, height).
    fn next(&mut self, gpu: &Gpu, crop: (u32, u32, u32, u32), out: &mut Vec<u8>) -> windows::core::Result<Option<(u32, u32)>> {
        // Take the newest frame waiting (older ones are skipped).
        let mut frame = None;
        while let Ok(f) = self.pool.TryGetNextFrame() {
            frame = Some(f);
        }
        let Some(frame) = frame else { return Ok(None) };
        let content = frame.ContentSize()?;
        if content.Width != self.size.Width || content.Height != self.size.Height {
            self.size = content;
            self.pool.Recreate(&gpu.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content)?;
        }
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        let (tw, th) = (desc.Width, desc.Height);
        // Big pictures: copy into mip level 0 of a two-level texture, let the
        // GPU average each 2x2 block into level 1, and read that back.
        let halve = tw > HALVE_ABOVE;
        let scale = if halve { 2 } else { 1 };
        let (rw, rh) = (tw / scale, th / scale);
        if halve && self.half.as_ref().map(|h| (h.2, h.3)) != Some((tw, th)) {
            let hd = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
                MipLevels: 2,
                ArraySize: 1,
                ..desc
            };
            let mut t = None;
            unsafe { gpu.device.CreateTexture2D(&hd, None, Some(&mut t))? };
            let t = t.ok_or_else(windows::core::Error::empty)?;
            let mut view = None;
            unsafe { gpu.device.CreateShaderResourceView(&t.cast::<ID3D11Resource>()?, None, Some(&mut view))? };
            self.half = Some((t, view.ok_or_else(windows::core::Error::empty)?, tw, th));
        }
        if self.staging.as_ref().map(|s| (s.1, s.2)) != Some((rw, rh)) {
            let sd = D3D11_TEXTURE2D_DESC {
                Width: rw,
                Height: rh,
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
                MipLevels: 1,
                ArraySize: 1,
                ..desc
            };
            let mut t = None;
            unsafe { gpu.device.CreateTexture2D(&sd, None, Some(&mut t))? };
            self.staging = t.map(|t| (t, rw, rh));
        }
        let Some((staging, _, _)) = &self.staging else { return Ok(None) };
        let (ox, oy, cw, ch) = (crop.0 / scale, crop.1 / scale, crop.2 / scale, crop.3 / scale);
        // The client area, clamped to what was captured (and to the visible content).
        let vw = ((content.Width.max(0) as u32) / scale).min(rw);
        let vh = ((content.Height.max(0) as u32) / scale).min(rh);
        let (ox, oy) = (ox.min(vw.saturating_sub(1)), oy.min(vh.saturating_sub(1)));
        let w = if cw == 0 { vw - ox } else { cw.min(vw - ox) };
        let h = if ch == 0 { vh - oy } else { ch.min(vh - oy) };
        if w == 0 || h == 0 {
            return Ok(None);
        }
        unsafe {
            let dst = staging.cast::<ID3D11Resource>()?;
            if let (true, Some((half, view, _, _))) = (halve, &self.half) {
                let hr = half.cast::<ID3D11Resource>()?;
                gpu.context.CopySubresourceRegion(&hr, 0, 0, 0, 0, &texture.cast::<ID3D11Resource>()?, 0, None);
                gpu.context.GenerateMips(view);
                gpu.context.CopySubresourceRegion(&dst, 0, 0, 0, 0, &hr, 1, None);
            } else {
                gpu.context.CopyResource(&dst, &texture.cast::<ID3D11Resource>()?);
            }
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context.Map(&dst, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
            out.clear();
            out.reserve(w as usize * h as usize * 4);
            let base = m.pData as *const u8;
            for y in 0..h {
                let row = base.add((y + oy) as usize * m.RowPitch as usize + ox as usize * 4);
                out.extend_from_slice(std::slice::from_raw_parts(row, w as usize * 4));
            }
            gpu.context.Unmap(&dst, 0);
        }
        Ok(Some((w, h)))
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

// ── The emulator ────────────────────────────────────────────────────────
fn close_emulator(child: &mut Child, hwnd: Option<HWND>) {
    if let Some(h) = hwnd {
        unsafe {
            let _ = PostMessageW(h, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
    // Some ask "are you sure?" (PCSX2): don't wait on a question no one sees.
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // Still there: it and everything it started.
    let _ = std::process::Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output();
    let _ = child.kill();
}

fn capture(cfg: CaptureConfig, shared: Arc<Shared>, cmd_rx: Receiver<Command>, ready_tx: Sender<Result<Value, String>>) {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let browser = unsafe { GetForegroundWindow() };
    let mut child = match std::process::Command::new(&cfg.exe).args(&cfg.args).current_dir(cfg.exe.parent().unwrap_or(std::path::Path::new("."))).spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("couldn't start {}: {e}", cfg.emulator)));
            shared.quit.store(true, Ordering::SeqCst);
            return;
        }
    };
    let pid = child.id();
    crate::info!("capture: started {} (pid {pid})", cfg.exe.display());

    // Its game window (emulators can take a while to show it).
    let until = Instant::now() + Duration::from_secs(240);
    let mut hwnd = None;
    while Instant::now() < until {
        if let Ok(Some(status)) = child.try_wait() {
            let _ = ready_tx.send(Err(format!("{} closed straight away ({status})", cfg.emulator)));
            shared.quit.store(true, Ordering::SeqCst);
            return;
        }
        if let Some(h) = game_window(&process_tree(pid)) {
            // Give it a moment: some show a small window first, then the game's.
            std::thread::sleep(Duration::from_millis(800));
            hwnd = game_window(&process_tree(pid)).or(Some(h));
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let Some(mut window) = hwnd else {
        close_emulator(&mut child, None);
        let _ = ready_tx.send(Err(format!("{} didn't open a window", cfg.emulator)));
        shared.quit.store(true, Ordering::SeqCst);
        return;
    };
    let gpu = match Gpu::new() {
        Ok(g) => g,
        Err(e) => {
            close_emulator(&mut child, Some(window));
            let _ = ready_tx.send(Err(format!("couldn't start capturing: {e}")));
            shared.quit.store(true, Ordering::SeqCst);
            return;
        }
    };
    let mut cap = match Capture::start(&gpu, window) {
        Ok(c) => c,
        Err(e) => {
            close_emulator(&mut child, Some(window));
            let _ = ready_tx.send(Err(format!("couldn't capture {}'s window: {e}", cfg.emulator)));
            shared.quit.store(true, Ordering::SeqCst);
            return;
        }
    };
    if cfg.offscreen {
        park_offscreen(window);
    }
    refocus(browser);
    let mut bus = Bus::open();
    let mut crop = client_crop(window).unwrap_or((0, 0, 0, 0));
    let info = json!({
        "capture": true,
        "game": cfg.title,
        "core": cfg.emulator,
        "fps": 60.0,
        "sampleRate": crate::audio::OUTPUT_RATE,
        "width": crop.2,
        "height": crop.3,
        "aspect": if crop.3 > 0 { crop.2 as f64 / crop.3 as f64 } else { 16.0 / 9.0 },
        "rotation": 0,
        "nativeControllers": true,
        "virtualControllers": bus.is_some(),
    });
    shared.set_hello(&info);
    let _ = ready_tx.send(Ok(info));

    let (mut connected, mut quit) = (false, false);
    let mut idle_since = Instant::now();
    let mut pixels = Vec::new();
    let (mut frames, mut stat_frames, mut stat_at, mut size) = (0u64, 0u32, Instant::now(), (0u32, 0u32));
    let mut checked = Instant::now();
    let mut last_frame_at = Instant::now();
    let mut reparked = false;
    loop {
        shared.beat();
        loop {
            match cmd_rx.recv_timeout(Duration::from_millis(2)) {
                Ok(Command::Input(port, input)) => {
                    if let Some(b) = bus.as_mut() {
                        b.send(port, &input);
                    }
                }
                Ok(Command::Connected) => connected = true,
                Ok(Command::Disconnected(generation)) => {
                    if shared.out().generation == generation {
                        connected = false;
                    }
                }
                Ok(Command::Quit) => quit = true,
                Ok(Command::Display(hz)) => {
                    let gap = if (20.0..=500.0).contains(&hz) { 1e6 / hz * 0.8 } else { 0.0 };
                    shared.min_video_gap_us.store(gap as u64, Ordering::Relaxed);
                }
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    quit = true;
                    break;
                }
            }
        }
        if quit {
            break;
        }
        if let Some(b) = bus.as_mut() {
            b.tick();
        }
        if let Ok(Some(status)) = child.try_wait() {
            crate::info!("capture: {} ended ({status})", cfg.emulator);
            break;
        }
        if connected {
            idle_since = Instant::now();
        } else if idle_since.elapsed() > cfg.idle_exit {
            break;
        }

        // Once a second: the window may have changed (a boot window, then the game's) or moved.
        if checked.elapsed() >= Duration::from_secs(1) {
            checked = Instant::now();
            if let Some(h) = game_window(&process_tree(pid)) {
                if h != window {
                    if let Ok(c) = Capture::start(&gpu, h) {
                        crate::info!("capture: following {}'s new window", cfg.emulator);
                        cap = c;
                        window = h;
                        if cfg.offscreen {
                            park_offscreen(window);
                        }
                    }
                }
            }
            crop = client_crop(window).unwrap_or(crop);
            // Nothing for 3 s off-screen: some emulators stop drawing there;
            // put the window back where it can draw (behind the browser).
            if cfg.offscreen && !reparked && frames > 0 && last_frame_at.elapsed() > Duration::from_secs(3) {
                reparked = true;
                unsafe {
                    let _ = SetWindowPos(window, None, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                }
                refocus(browser);
            }
        }

        match cap.next(&gpu, crop, &mut pixels) {
            Ok(Some((w, h))) => {
                frames += 1;
                stat_frames += 1;
                last_frame_at = Instant::now();
                if (w, h) != size {
                    size = (w, h);
                    shared.text(json!({ "type": "geometry", "width": w, "height": h, "aspect": w as f64 / h as f64, "fps": 60.0, "rotation": 0 }));
                }
                shared.picture(1, false, w, h, frames, |v| v.extend_from_slice(&pixels));
            }
            Ok(None) => {}
            Err(e) => crate::warn!("capture: {e}"),
        }

        if stat_at.elapsed() >= Duration::from_secs(1) {
            let secs = stat_at.elapsed().as_secs_f64();
            shared.text(json!({
                "type": "status",
                "capture": true,
                "fps": (stat_frames as f64 / secs * 10.0).round() / 10.0,
                "dropped": shared.dropped.swap(0, Ordering::Relaxed),
                "pads": bus.as_ref().map(Bus::count).unwrap_or(0),
                "width": size.0,
                "height": size.1,
                "canSave": false,
            }));
            stat_frames = 0;
            stat_at = Instant::now();
        }
    }

    crate::info!("capture: closing {}", cfg.emulator);
    drop(cap);
    drop(bus.take());
    close_emulator(&mut child, Some(window));
    shared.text(json!({ "type": "exit" }));
    shared.quit.store(true, Ordering::SeqCst);
    shared.wake.notify_all();
}
