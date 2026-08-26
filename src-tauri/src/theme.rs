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
//!
//! ## Résolution du chemin (ordre choisi)
//!
//! 1. **Dev** (`debug_assertions`) : si `den-theme.json` existe à la racine
//!    du repo (déterminée via `CARGO_MANIFEST_DIR`, résolu à la compilation —
//!    `src-tauri/` -> parent), on l'utilise **directement**. Ça permet
//!    d'éditer le fichier versionné du repo pendant le dev sans passer par le
//!    dossier de config utilisateur.
//! 2. **Sinon** (release packagée, ou dev sans fichier racine) :
//!    `app_config_dir()/den-theme.json` — fichier utilisateur, mutable en
//!    prod packagée. Le dossier est créé s'il n'existe pas ; au tout premier
//!    accès, le fichier est initialisé avec le contenu par défaut de
//!    `den-theme.json` (embarqué dans le binaire via `include_str!` à la
//!    compilation — un *seed* pour amorcer le fichier utilisateur, pas un
//!    asset Vite non éditable : une fois copié, ce fichier vit sur disque et
//!    devient éditable/surveillable comme n'importe quel fichier utilisateur).
//!
//! `theme_watch` fait tourner un thread de polling (std uniquement, pas de
//! nouvelle dépendance) qui compare le mtime du fichier toutes les ~500ms et
//! renvoie le contenu brut via le channel à chaque changement détecté.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::ipc::Channel;
use tauri::Manager;

/// Contenu par défaut du thème, embarqué à la compilation depuis le
/// `den-theme.json` versionné à la racine du repo. Sert uniquement de seed
/// pour initialiser le fichier utilisateur en `app_config_dir` — jamais lu
/// directement en dehors de ce cas (cf. résolution du chemin ci-dessus).
const DEFAULT_THEME: &str = include_str!("../../den-theme.json");

/// Intervalle de polling du mtime — pas de watcher natif (pas de nouvelle
/// dépendance type `notify`), une résolution de 500ms est largement
/// suffisante pour un hot-reload de thème perçu comme instantané.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Si présent, le `den-theme.json` versionné à la racine du repo (dev only).
fn dev_repo_theme_path() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent()?;
    let candidate = repo_root.join("den-theme.json");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

/// Résout le chemin du fichier de thème selon l'ordre documenté en tête de
/// module, en créant/amorçant le fichier de config utilisateur si besoin.
fn resolve_theme_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dev_path) = dev_repo_theme_path() {
        return Ok(dev_path);
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("résolution du dossier de config impossible: {e}"))?;
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("création du dossier de config impossible: {e}"))?;

    let user_path = config_dir.join("den-theme.json");
    if !user_path.exists() {
        fs::write(&user_path, DEFAULT_THEME)
            .map_err(|e| format!("initialisation du thème par défaut impossible: {e}"))?;
    }
    Ok(user_path)
}

#[tauri::command]
pub fn theme_read(app: tauri::AppHandle) -> Result<String, String> {
    let path = resolve_theme_path(&app)?;
    fs::read_to_string(&path)
        .map_err(|e| format!("lecture du thème impossible ({}): {e}", path.display()))
}

#[tauri::command]
pub fn theme_watch(app: tauri::AppHandle, on_change: Channel<String>) -> Result<(), String> {
    let path = resolve_theme_path(&app)?;

    thread::spawn(move || {
        let mut last_modified: Option<SystemTime> =
            fs::metadata(&path).and_then(|m| m.modified()).ok();

        loop {
            thread::sleep(POLL_INTERVAL);

            let modified = match fs::metadata(&path).and_then(|m| m.modified()) {
                Ok(m) => m,
                // Fichier temporairement illisible (ex. écriture en cours) —
                // on retente au prochain tick, pas d'erreur remontée.
                Err(_) => continue,
            };

            let changed = match last_modified {
                Some(prev) => modified != prev,
                None => true,
            };
            if !changed {
                continue;
            }
            last_modified = Some(modified);

            match fs::read_to_string(&path) {
                Ok(contents) => {
                    if on_change.send(contents).is_err() {
                        // Le frontend a fermé le channel (tab/fenêtre fermée) :
                        // plus personne n'écoute, on arrête le thread.
                        break;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "den: theme_watch — lecture impossible ({}): {e}",
                        path.display()
                    );
                }
            }
        }
    });

    Ok(())
}
