mod pty;
mod sidecar;
mod theme;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            workspace::workspace_read,
            workspace::workspace_write,
            workspace::workspace_canonicalize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
