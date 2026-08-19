// Prevents an extra console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{
    Manager, State,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The running sidecar process, if the switch is on.
struct ServerProc(Mutex<Option<CommandChild>>);

/// Whether the app should keep living in the menu bar when the window closes.
struct TrayKeep(Mutex<bool>);

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

/// Build the tray menu: Show (reopen the window) and Quit.
fn build_tray_menu(app: &tauri::AppHandle) -> tauri::menu::Menu<tauri::Wry> {
    let show = tauri::menu::MenuItem::with_id(app, "show", "Show lanyell", true, None::<&str>)
        .expect("menu item show");
    let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit lanyell", true, None::<&str>)
        .expect("menu item quit");
    tauri::menu::Menu::with_items(app, &[&show, &quit]).expect("tray menu")
}

/// Enable "keep in menu bar": register a tray icon. On macOS the app lives in
/// the Dock regardless; the tray just adds a status-bar entry. Quitting happens
/// via Dock right-click, Cmd+Q, or the tray menu — and the sidecar is killed
/// on RunEvent::Exit no matter which path quits the app.
#[tauri::command]
fn set_tray_keep(app: tauri::AppHandle, state: State<TrayKeep>, keep: bool) -> Result<(), String> {
    *state.0.lock().unwrap() = keep;
    if keep {
        if app.tray_by_id("lanyell").is_none() {
            let tray = TrayIconBuilder::with_id("lanyell")
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .menu(&build_tray_menu(&app))
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click toggles the main window (menus open on right
                    // click).
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle().clone();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(&app)
                .map_err(|e| format!("tray build: {}", e))?;
            let _ = tray.set_tooltip(Some("lanyell"));
        }
    } else if let Some(tray) = app.tray_by_id("lanyell") {
        let _ = tray.set_visible(false);
        app.remove_tray_by_id("lanyell");
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProc(Mutex::new(None)))
        .manage(TrayKeep(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            open_url,
            set_tray_keep
        ])
        .on_window_event(|window, event| {
            // The close button NEVER exits the app — it only hides the window,
            // the server keeps running. Quit via Dock / tray / Cmd+Q.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building lanyell app")
        .run(|app, event| {
            match event {
                // Kill the sidecar on any real exit path (Dock quit, Cmd+Q,
                // tray Quit). Without this the child process outlives the app
                // and the port stays occupied.
                tauri::RunEvent::Exit => {
                    if let Some(proc) = app.try_state::<ServerProc>() {
                        if let Ok(mut guard) = proc.0.lock() {
                            if let Some(child) = guard.take() {
                                let _ = child.kill();
                            }
                        }
                    }
                }
                // macOS: clicking the Dock icon after the window was hidden
                // must bring the window back (Reopen is the standard event).
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
                _ => {}
            }
        });
}
