//! Contrat — module workspace (DEN-04, lot A1).
//!
//! Persiste la liste des projets connus et le layout choisi dans un unique
//! fichier `workspace.json` — résolution de chemin sur le patron de
//! `theme.rs` (`dev_repo_base` / `user_base`) : en dev, à la racine du repo
//! (résolue via `CARGO_MANIFEST_DIR`) ; en release packagée, dans
//! `app_config_dir()`. Fichier **utilisateur** dès le départ, jamais
//! versionné (cf. `/workspace.json*` dans `.gitignore`).
//!
//! Deux commands seulement, pas de watcher : `workspace_read` /
//! `workspace_write`. Ce module ne fait que lire/écrire une chaîne brute :
//! le schéma, ses défauts et sa validation vivent côté TS
//! (`src/workspace/store.ts`). Un fichier absent se lit comme `""` — aucun
//! seed écrit à la lecture, `parseWorkspace("")` produit déjà le workspace
//! par défaut.
//!
//! Écriture : atomique (`workspace.json.tmp` puis `rename`) et précédée
//! d'une copie `workspace.json.bak` de la version courante — ce fichier est
//! l'unique copie de l'état utilisateur ; ni un crash en pleine écriture, ni
//! un écrasement après un fallback de parsing côté TS ne doivent le perdre.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tauri::Manager;

const WORKSPACE_FILE: &str = "workspace.json";
const WORKSPACE_TMP: &str = "workspace.json.tmp";
const WORKSPACE_BAK: &str = "workspace.json.bak";

/// Racine du repo (dev only). À la différence de `theme.rs::dev_repo_base`,
/// pas de test d'existence de fichier : `workspace.json` n'existe pas encore
/// au tout premier lancement, c'est le cas normal.
fn dev_repo_base() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.parent().map(|p| p.to_path_buf())
}

/// Base "fichiers utilisateur" en `app_config_dir()` (release, ou dev sans
/// racine de repo résolvable).
fn user_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("résolution du dossier de config impossible: {e}"))?;
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("création du dossier de config impossible: {e}"))?;
    Ok(config_dir)
}

/// Résout le dossier de base (dev repo ou fichiers utilisateur) selon le
/// même ordre que `theme.rs::resolve_base`.
fn resolve_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(base) = dev_repo_base() {
        return Ok(base);
    }
    user_base(app)
}

#[tauri::command]
pub fn workspace_read(app: tauri::AppHandle) -> Result<String, String> {
    let path = resolve_base(&app)?.join(WORKSPACE_FILE);
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("lecture de {} impossible: {e}", path.display())),
    }
}

#[tauri::command]
pub fn workspace_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let base = resolve_base(&app)?;
    let path = base.join(WORKSPACE_FILE);
    let tmp = base.join(WORKSPACE_TMP);
    if path.exists() {
        fs::copy(&path, base.join(WORKSPACE_BAK))
            .map_err(|e| format!("copie de sauvegarde de {} impossible: {e}", path.display()))?;
    }
    fs::write(&tmp, json)
        .map_err(|e| format!("écriture de {} impossible: {e}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("remplacement de {} impossible: {e}", path.display()))
}
