//! Contrat — module theme (lot dédié).
//!
//! Le fichier de thème est un fichier *utilisateur* sur disque (éditable en
//! prod packagée — un asset bundlé par Vite ne le serait pas) : résolution du
//! chemin par le lot theme (dossier de config app via le path resolver Tauri,
//! fallback dev : `den-theme.json` à la racine du repo). Les changements sont
//! poussés via le `Channel<String>` fourni à `theme_watch` (contenu JSON brut
//! du fichier — le parsing vit côté TS, cf. `src/theme/index.ts`).
//!
//! Signatures figées (contrat inter-lots) — ne pas changer sans mettre à
//! jour l'appelant côté `src/theme/index.ts`.

use tauri::ipc::Channel;

#[tauri::command]
pub fn theme_read() -> Result<String, String> {
    Err("not implemented".into())
}

#[tauri::command]
pub fn theme_watch(on_change: Channel<String>) -> Result<(), String> {
    let _ = on_change;
    Err("not implemented".into())
}
