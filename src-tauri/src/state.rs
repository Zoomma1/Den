//! Contrat — module state (DEN-04, lot A2bis-1).
//!
//! Persiste le modèle v2 (workspaces + projets + layout) dans un unique
//! fichier `state.json` — résolution de chemin sur le patron de `theme.rs`
//! (`dev_repo_base` / `user_base`) : en dev, à la racine du repo (résolue via
//! `CARGO_MANIFEST_DIR`) ; en release packagée, dans `app_config_dir()`.
//! Fichier **utilisateur** dès le départ, jamais versionné (cf.
//! `/state.json*` dans `.gitignore`).
//!
//! Ce module ne fait que lire/écrire une chaîne brute : le schéma, ses
//! défauts et sa validation vivent côté TS (`src/workspace/store.ts`). Un
//! fichier absent se lit comme `""` — aucun seed écrit à la lecture,
//! `parsePersistedState("")` produit déjà l'état par défaut.
//!
//! Legacy v1 (`workspace.json`, lot A1) : `state_read` lit `state.json` en
//! priorité, et ne retombe sur `workspace.json` que si `state.json` est
//! absent — la migration v1 → v2 elle-même vit côté TS (`tryParsePersistedState`,
//! cf. `store.ts`). Une fois la migration réussie et `state.json` écrit,
//! `state_migrated` renomme `workspace.json` en `workspace.json.migrated` :
//! un fichier legacy qui ne sera plus jamais relu (`state_read` ne retombe
//! que sur `workspace.json`, pas sur `.migrated`), mais jamais supprimé.
//!
//! Écriture : atomique (`state.json.tmp` puis `rename`) et précédée d'une
//! copie `state.json.bak` de la version courante — ce fichier est l'unique
//! copie de l'état utilisateur ; ni un crash en pleine écriture, ni un
//! écrasement après un fallback de parsing côté TS ne doivent le perdre.
//! `state_write` n'écrit jamais `workspace.json` : le legacy n'est jamais
//! remis à jour, il ne sert plus qu'à la migration one-shot.
//!
//! `path_canonicalize` (ex-`workspace_canonicalize`, DEN-04 A2) : résout un
//! path choisi par le picker en chemin canonique (`fs::canonicalize`) avant
//! `addProject` côté TS — deux paths qui désignent le même dossier (symlink,
//! `..`) doivent dédupliquer.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use tauri::Manager;

const STATE_FILE: &str = "state.json";
const STATE_TMP: &str = "state.json.tmp";
const STATE_BAK: &str = "state.json.bak";
const LEGACY_FILE: &str = "workspace.json";
const LEGACY_MIGRATED: &str = "workspace.json.migrated";

/// Racine du repo (dev only). À la différence de `theme.rs::dev_repo_base`,
/// pas de test d'existence de fichier : `state.json` n'existe pas encore au
/// tout premier lancement, c'est le cas normal.
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

/// Lit `state.json` ; si absent, retombe sur le legacy `workspace.json` (v1,
/// pas encore migré) ; si les deux sont absents, `""` (premier lancement).
/// Toute autre erreur (permission, etc.) est remontée telle quelle.
#[tauri::command]
pub fn state_read(app: tauri::AppHandle) -> Result<String, String> {
    let base = resolve_base(&app)?;
    let path = base.join(STATE_FILE);
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let legacy_path = base.join(LEGACY_FILE);
            match fs::read_to_string(&legacy_path) {
                Ok(raw) => Ok(raw),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(String::new()),
                Err(e) => Err(format!(
                    "lecture de {} impossible: {e}",
                    legacy_path.display()
                )),
            }
        }
        Err(e) => Err(format!("lecture de {} impossible: {e}", path.display())),
    }
}

/// Canonicalise `path` (résout symlinks/`..`) pour que `addProject` déduplique
/// deux chemins désignant le même dossier. Erreur formatée en français comme
/// les autres commands de ce module.
#[tauri::command]
pub fn path_canonicalize(path: String) -> Result<String, String> {
    fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("canonicalisation de {path} impossible: {e}"))
}

/// N'écrit jamais `workspace.json` — seulement `state.json` (v2). `.bak`
/// copié depuis la version courante avant l'écriture atomique (`.tmp` puis
/// `rename`), même contrat que l'ancien `workspace_write`.
#[tauri::command]
pub fn state_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let base = resolve_base(&app)?;
    let path = base.join(STATE_FILE);
    let tmp = base.join(STATE_TMP);
    if path.exists() {
        fs::copy(&path, base.join(STATE_BAK))
            .map_err(|e| format!("copie de sauvegarde de {} impossible: {e}", path.display()))?;
    }
    fs::write(&tmp, json)
        .map_err(|e| format!("écriture de {} impossible: {e}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("remplacement de {} impossible: {e}", path.display()))
}

/// Renomme `workspace.json` en `workspace.json.migrated` — appelée côté TS
/// seulement après qu'un `state_write` de l'état migré a réussi (cf.
/// `src/workspace/index.ts::finishMigration`). No-op `Ok(())` si
/// `workspace.json` est déjà absent (migration déjà faite, ou premier
/// lancement sans legacy). Jamais de suppression : un `.migrated`
/// préexistant est écrasé par le rename (cas "legacy restauré à la main",
/// accepté).
#[tauri::command]
pub fn state_migrated(app: tauri::AppHandle) -> Result<(), String> {
    let base = resolve_base(&app)?;
    let legacy_path = base.join(LEGACY_FILE);
    if !legacy_path.exists() {
        return Ok(());
    }
    let migrated_path = base.join(LEGACY_MIGRATED);
    fs::rename(&legacy_path, &migrated_path).map_err(|e| {
        format!(
            "renommage de {} en {} impossible: {e}",
            legacy_path.display(),
            migrated_path.display()
        )
    })
}
