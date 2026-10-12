mod login_path;
mod pty;
mod sidecar;
mod state;
mod theme;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            sidecar::sidecar_spawn,
            sidecar::sidecar_send,
            sidecar::sidecar_kill,
            sidecar::sidecar_kill_all,
            theme::theme_read,
            theme::theme_watch,
            state::state_read,
            state::state_write,
            state::path_canonicalize,
            state::state_migrated,
        ])
        .setup(|_app| {
            // Préchauffe le cache : le premier sidecar ne paie pas la latence du shell.
            std::thread::spawn(|| {
                login_path::login_path();
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
