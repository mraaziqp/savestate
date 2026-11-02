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

fn start_launcher(app: &tauri::AppHandle) -> Option<Child> {
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
