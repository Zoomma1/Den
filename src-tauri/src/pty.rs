//! Contrat — module PTY (lot dédié).
//!
//! Implémentation réelle via `portable-pty` UNIQUEMENT — jamais
//! `tauri-plugin-shell` (n'alloue pas de PTY : vim/couleurs/SIGWINCH cassés,
//! cf. CLAUDE.md racine). Le flux de sortie du PTY est relayé exclusivement
//! via le `Channel<Vec<u8>>` fourni à `pty_spawn` (jamais `emit()` — flux
//! haut débit).
//!
//! Signatures figées (contrat inter-lots) — ne pas changer sans mettre à
//! jour les appelants côté `src/terminal/index.ts`.

use tauri::ipc::Channel;

#[tauri::command]
pub fn pty_spawn(cols: u16, rows: u16, on_data: Channel<Vec<u8>>) -> Result<u32, String> {
    let _ = (cols, rows, on_data);
    Err("not implemented".into())
}

#[tauri::command]
pub fn pty_write(id: u32, data: String) -> Result<(), String> {
    let _ = (id, data);
    Err("not implemented".into())
}

#[tauri::command]
pub fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let _ = (id, cols, rows);
    Err("not implemented".into())
}

#[tauri::command]
pub fn pty_kill(id: u32) -> Result<(), String> {
    let _ = id;
    Err("not implemented".into())
}
