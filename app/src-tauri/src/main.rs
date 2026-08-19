// Prevents an extra console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The running sidecar process, if the switch is on.
struct ServerProc(Mutex<Option<CommandChild>>);

#[derive(serde::Serialize)]
struct StartResult {
    url: String,
}

/// Find the first non-internal IPv4 address (same rule as lib/device.js).
fn lan_ip() -> Option<String> {
    local_ip_address::local_ip()
        .ok()
        .map(|ip| ip.to_string())
}

/// Spawn the sidecar and wait for its "listening" line on stdout.
#[tauri::command]
fn start_server(
    app: tauri::AppHandle,
    state: State<ServerProc>,
    port: u16,
) -> Result<StartResult, String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Err("server is already running".into());
    }

    if !(1..=65535).contains(&port) {
        return Err(format!("invalid port {} (must be 1-65535)", port));
    }
    let port = port;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {}", e))?;

    // The sidecar resolves resources relative to the resource dir on disk.
    let public_dir = resource_dir.join("public");
    let sidecar = app
        .shell()
        .sidecar("lanyell-server")
        .map_err(|e| format!("sidecar missing: {}. Run 'node build-sidecar.js' first.", e))?;

    let (mut rx, child) = sidecar
        .env("LANYELL_PORT", port.to_string())
        .env("LANYELL_PUBLIC_DIR", public_dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("failed to start server: {}", e))?;

    // Wait for the ready line (or an error exit) before reporting success.
    // A watcher thread forwards the outcome over a channel; in tauri-plugin-shell
    // v2 the Stdout/Stderr payloads are plain Vec<u8>.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        while let Some(event) = rx.blocking_recv() {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if String::from_utf8_lossy(&bytes).contains("listening") {
                        let _ = ready_tx.send(Ok(()));
                        return;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let _ = ready_tx.send(Err(String::from_utf8_lossy(&bytes).trim().to_string()));
                    return;
                }
                CommandEvent::Error(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
                _ => {}
            }
        }
        // The event stream ended (process exited) without a listening line.
        let _ = ready_tx.send(Err("server exited before listening".into()));
    });

    match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(msg)) => return Err(msg),
        Err(_) => return Err("server did not start within 5s".into()),
    }

    *guard = Some(child);

    let ip = lan_ip().unwrap_or_else(|| "<your-LAN-IP>".into());
    Ok(StartResult {
        url: format!("http://{}:{}", ip, port),
    })
}

/// Kill the sidecar.
#[tauri::command]
fn stop_server(state: State<ServerProc>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    match guard.take() {
        Some(child) => child
            .kill()
            .map_err(|e| format!("failed to stop server: {}", e)),
        None => Ok(()),
    }
}

/// Open a URL in the system default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map_err(|e| format!("failed to open browser: {}", e))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProc(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_server, stop_server, open_url])
        .run(tauri::generate_context!())
        .expect("error while running lanyell app");
}
