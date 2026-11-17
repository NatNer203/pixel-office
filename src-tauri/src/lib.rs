
mod backend;
mod updates;

use std::fs;
use std::path::PathBuf;
use tauri::{Manager, PhysicalPosition, PhysicalSize, Position, Size};

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("window.txt"))
}

fn save_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(path, format!("{},{},{},{}", pos.x, pos.y, size.width, size.height))
        .map_err(|e| e.to_string())
}

fn default_geometry(window: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Aucun moniteur détecté")?;

    let screen = monitor.size();
    let origin = monitor.position();
    let height = screen.height / 4;

    window
        .set_size(Size::Physical(PhysicalSize::new(screen.width, height)))
        .map_err(|e| e.to_string())?;

    window
        .set_position(Position::Physical(PhysicalPosition::new(
            origin.x,
            origin.y + (screen.height - height) as i32,
        )))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reset_window(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    default_geometry(&window)?;
    save_window(&app, &window)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new()
            .pubkey(include_str!("../update.pubkey").trim())
            .build())
        .invoke_handler(tauri::generate_handler![
            reset_window,
            backend::get_profile, backend::set_profile,
            backend::list_requests, backend::create_request, backend::set_request_flags,
            backend::network_host, backend::network_connect, backend::network_disconnect,
            backend::network_status, backend::network_tick,
            updates::updates_sync_server, updates::updates_status,
            updates::updates_publish, updates::updates_check, updates::updates_install
        ])
        .setup(|app| {
            let db_dir = app.path().app_data_dir()?;
            let backend = backend::Backend::open(&db_dir.join("pixel-office.sqlite3"))
                .map_err(std::io::Error::other)?;
            app.manage(backend);

            let updates_dir = app.path().app_data_dir()?.join("updates");
            let update_service = updates::UpdateService::new(updates_dir)
                .map_err(std::io::Error::other)?;
            if let Err(e) = update_service.bootstrap() {
                eprintln!("Serveur de mises à jour non démarré : {e}");
            }
            app.manage(update_service);

            let window = app
                .get_webview_window("main")
                .expect("Fenêtre principale introuvable");

            let path = config_path(app.handle()).map_err(std::io::Error::other)?;
            let mut restored = false;

            if let Ok(content) = fs::read_to_string(path) {
                let values: Vec<i32> = content
                    .trim()
                    .split(',')
                    .filter_map(|v| v.parse::<i32>().ok())
                    .collect();

                if values.len() == 4 && values[2] >= 320 && values[3] >= 120 {
                    let width = values[2] as u32;
                    let height = values[3] as u32;

                    window.set_size(Size::Physical(PhysicalSize::new(width, height)))?;
                    window.set_position(Position::Physical(
                        PhysicalPosition::new(values[0], values[1])
                    ))?;
                    restored = true;
                }
            }

            if !restored {
                default_geometry(&window).map_err(std::io::Error::other)?;
            }

            let handle = app.handle().clone();
            let win = window.clone();

            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    if let Err(e) = save_window(&handle, &win) {
                        eprintln!("Erreur sauvegarde fenêtre : {e}");
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Erreur pendant l'exécution de Pixel Office");
}
