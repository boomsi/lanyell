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
) -> Result<StartResult, String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Err("server is already running".into());
    }

    let port = 3000u16;
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
    let ready = std::sync::mpsc::channel();
    {
        let ready = ready.clone();
        std::thread::spawn(move || {
            while let Some(event) = rx.blocking_recv() {
                match event {
                    CommandEvent::Stdout(line) => {
                        let s = String::from_utf8_lossy(&line.stdout).to_string();
                        if s.contains("listening") {
                            let _ = ready.0.send(Ok(()));
                            return;
                        }
                    }
                    CommandEvent::Stderr(line) => {
                        let s = String::from_utf8_lossy(&line.stderr).to_string();
                        let _ = ready.0.send(Err(s.trim().to_string()));
                        return;
                    }
                    CommandEvent::Error(e) => {
                        let _ = ready.0.send(Err(e.to_string()));
                        return;
                    }
                    _ => {}
                }
            }
        });
    }

    match ready.1.recv_timeout(std::time::Duration::from_secs(5)) {
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProc(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_server, stop_server])
        .run(tauri::generate_context!())
        .expect("error while running lanyell app");
}
