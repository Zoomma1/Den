//! Contrat — module sidecar (lot dédié).
//!
//! Un sidecar Node (`sidecar/`, Agent SDK) par session/tab — un crash
//! n'emporte qu'un tab. Le flux NDJSON du sidecar (cf.
//! `src/types/protocol.ts`) est relayé exclusivement via le
//! `Channel<String>` fourni à `sidecar_spawn` (jamais `emit()` — flux haut
//! débit). Jamais `ANTHROPIC_API_KEY` dans l'environnement du process
//! sidecar — l'auth passe par l'OAuth du CLI loggé.
//!
//! Signatures figées (contrat inter-lots) — ne pas changer sans mettre à
//! jour les appelants côté `src/tabs/index.ts` / `src/markdown/index.ts`.

use tauri::ipc::Channel;

#[tauri::command]
pub fn sidecar_spawn(tab_id: String, cwd: String, on_message: Channel<String>) -> Result<(), String> {
    let _ = (tab_id, cwd, on_message);
    Err("not implemented".into())
}

#[tauri::command]
pub fn sidecar_send(tab_id: String, message: String) -> Result<(), String> {
    let _ = (tab_id, message);
    Err("not implemented".into())
}

#[tauri::command]
pub fn sidecar_kill(tab_id: String) -> Result<(), String> {
    let _ = tab_id;
    Err("not implemented".into())
}
