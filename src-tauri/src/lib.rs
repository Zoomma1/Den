mod pty;
mod sidecar;
mod theme;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            sidecar::sidecar_spawn,
            sidecar::sidecar_send,
            sidecar::sidecar_kill,
            theme::theme_read,
            theme::theme_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
