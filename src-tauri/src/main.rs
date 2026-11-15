// SaveState for Windows (native): savestate.co.za in its own window, and the
// game launcher (client-launcher.cjs on the bundled Node.js) running beside it
// so Play opens games on this PC. One copy at a time: opening it again brings
// the window forward. The launcher it started stops when the app closes; a
// launcher already running (the one-click installer's) is left alone.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const SITE: &str = "https://savestate.co.za";
const LAUNCHER_PORT: u16 = 17373;

struct Launcher(Mutex<Option<Child>>);

fn launcher_running() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], LAUNCHER_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// The launcher's own folder, as the one-click installer uses it.
fn client_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("NexusEmuClient")
}

/// PCs set up with the one-click installer run their own copy of the launcher
/// (NexusEmuClient, kept going by nexus-runner.vbs), which nothing updated: a
/// newer app's fixes never reached it. When this app's copy is newer (the
/// installer keeps each file's build time) and different, it replaces that
/// copy and stops the old process; the runner starts the new one in ~10 s.
/// Never a downgrade, and nothing at all on PCs without that setup.
fn refresh_client_launcher(res: &std::path::Path) {
    let bundled = res.join("client-launcher.cjs");
    let installed = client_dir().join("client-launcher.cjs");
    let (Ok(b), Ok(i)) = (std::fs::metadata(&bundled), std::fs::metadata(&installed)) else { return };
    let (Ok(bm), Ok(im)) = (b.modified(), i.modified()) else { return };
    if bm <= im {
        return;
    }
    let (Ok(new), Ok(old)) = (std::fs::read(&bundled), std::fs::read(&installed)) else { return };
    if new == old {
        return;
    }
    let tmp = installed.with_extension("cjs.new");
    if std::fs::write(&tmp, &new).is_err() {
        return;
    }
    if std::fs::rename(&tmp, &installed).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    let mut stop = Command::new("powershell.exe");
    stop.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*NexusEmuClient*client-launcher.cjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        stop.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = stop.status();
    // Wait for the old one to let go of the port, so this app starts the new
    // launcher at once (the runner took about a minute to get round to it).
    for _ in 0..20 {
        if !launcher_running() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn start_launcher(app: &tauri::AppHandle) -> Option<Child> {
    if let Ok(res) = app.path().resource_dir() {
        refresh_client_launcher(&res);
    }
    if launcher_running() {
        return None;
    }
    let res = app.path().resource_dir().ok()?;
    let node = res.join("node").join("node.exe");
    let script = res.join("client-launcher.cjs");
    if !node.exists() || !script.exists() {
        return None;
    }
    let dir = client_dir();
    let _ = std::fs::create_dir_all(&dir);
    let host = dir.join("preferred-host-url.txt");
    if !host.exists() {
        let _ = std::fs::write(&host, format!("{SITE}\n"));
    }
    let mut cmd = Command::new(node);
    cmd.arg(script).current_dir(&dir);
    // Nothing of this process's own settings goes to the launcher.
    for k in ["PORT", "HOST", "NODE_OPTIONS"] {
        cmd.env_remove(k);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().ok()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(Launcher(Mutex::new(None)))
        .setup(|app| {
            let child = start_launcher(app.handle());
            *app.state::<Launcher>().0.lock().unwrap() = child;
            let url = SITE.parse().expect("site address");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("SaveState")
                .inner_size(1400.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .maximized(true)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("SaveState failed to start");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Launcher>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
