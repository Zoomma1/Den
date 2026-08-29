//! Contrat — module theme (lot dédié).
//!
//! Le thème actif est désigné par un fichier `.config` (une seule ligne :
//! le nom du thème, ex. `default`) qui pointe vers `themes/<nom>.css` — un
//! fichier CSS tokens-only (un unique bloc `:root { --den-*: ...; }`, cf.
//! `src/theme/theme.ts` pour le parseur). Le fichier de thème est un
//! fichier *utilisateur* sur disque (éditable en prod packagée — un asset
//! bundlé par Vite ne le serait pas) : résolution du chemin par le lot
//! theme (dossier de config app via le path resolver Tauri, fallback dev :
//! `.config` + `themes/` à la racine du repo). Les changements sont
//! poussés via le `Channel<String>` fourni à `theme_watch` (contenu CSS
//! brut du fichier de thème actif — le parsing vit côté TS, cf.
//! `src/theme/index.ts`).
//!
//! Signatures figées (contrat inter-lots) — ne pas changer sans mettre à
//! jour l'appelant côté `src/theme/index.ts`.
//!
//! ## Résolution du chemin (ordre choisi)
//!
//! 1. **Dev** (`debug_assertions`) : si `.config` et `themes/` existent à la
//!    racine du repo (déterminée via `CARGO_MANIFEST_DIR`, résolu à la
//!    compilation — `src-tauri/` -> parent), on les utilise **directement**.
//!    Ça permet d'éditer les fichiers versionnés du repo pendant le dev
//!    sans passer par le dossier de config utilisateur.
//! 2. **Sinon** (release packagée, ou dev sans fichiers racine) :
//!    `app_config_dir()/.config` + `app_config_dir()/themes/<nom>.css` —
//!    fichiers utilisateur, mutables en prod packagée. Le dossier est créé
//!    s'il n'existe pas ; au tout premier accès, `.config` et
//!    `themes/default.css` sont initialisés avec le contenu par défaut
//!    (embarqué dans le binaire via `include_str!` à la compilation — un
//!    *seed* pour amorcer les fichiers utilisateur, pas un asset Vite non
//!    éditable : une fois copiés, ces fichiers vivent sur disque et
//!    deviennent éditables/surveillables comme n'importe quel fichier
//!    utilisateur).
//!
//! `theme_watch` fait tourner un thread de polling (std uniquement, pas de
//! nouvelle dépendance) qui compare le mtime du `.config` **et** du
//! fichier de thème actif toutes les ~500ms : si `.config` change, le
//! fichier actif est re-résolu et son contenu poussé ; si le fichier actif
//! change, son contenu est poussé.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::ipc::Channel;
use tauri::Manager;

/// Contenu par défaut de `.config`, embarqué à la compilation. Sert
/// uniquement de seed pour initialiser le fichier utilisateur en
/// `app_config_dir` — jamais lu directement en dehors de ce cas.
const DEFAULT_CONFIG: &str = include_str!("../../.config");

/// Contenu par défaut du thème "default", embarqué à la compilation depuis
/// `themes/default.css` (versionné à la racine du repo). Même rôle de seed
/// que `DEFAULT_CONFIG`.
const DEFAULT_THEME_CSS: &str = include_str!("../../themes/default.css");

/// Intervalle de polling du mtime — pas de watcher natif (pas de nouvelle
/// dépendance type `notify`), une résolution de 500ms est largement
/// suffisante pour un hot-reload de thème perçu comme instantané.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Racine des fichiers de thème pour une "base" donnée (repo en dev,
/// `app_config_dir()` sinon) : `.config` + dossier `themes/`.
struct ThemeBase {
    config_path: PathBuf,
    themes_dir: PathBuf,
}

/// Si présents, le `.config` + `themes/` versionnés à la racine du repo
/// (dev only).
fn dev_repo_base() -> Option<ThemeBase> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent()?;
    let config_path = repo_root.join(".config");
    let themes_dir = repo_root.join("themes");
    if config_path.exists() && themes_dir.exists() {
        Some(ThemeBase {
            config_path,
            themes_dir,
        })
    } else {
        None
    }
}

/// Base "fichiers utilisateur" en `app_config_dir()`, amorcée avec les
/// seeds embarqués si elle n'existe pas encore.
fn user_base(app: &tauri::AppHandle) -> Result<ThemeBase, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("résolution du dossier de config impossible: {e}"))?;
    let themes_dir = config_dir.join("themes");
    fs::create_dir_all(&themes_dir)
        .map_err(|e| format!("création du dossier de config impossible: {e}"))?;

    let config_path = config_dir.join(".config");
    if !config_path.exists() {
        fs::write(&config_path, DEFAULT_CONFIG)
            .map_err(|e| format!("initialisation de .config impossible: {e}"))?;
    }

    let default_theme_path = themes_dir.join("default.css");
    if !default_theme_path.exists() {
        fs::write(&default_theme_path, DEFAULT_THEME_CSS)
            .map_err(|e| format!("initialisation du thème par défaut impossible: {e}"))?;
    }

    Ok(ThemeBase {
        config_path,
        themes_dir,
    })
}

/// Résout la base (dev repo ou fichiers utilisateur) selon l'ordre
/// documenté en tête de module.
fn resolve_base(app: &tauri::AppHandle) -> Result<ThemeBase, String> {
    if let Some(base) = dev_repo_base() {
        return Ok(base);
    }
    user_base(app)
}

/// Lit `.config` et résout le chemin du fichier de thème actif qu'il
/// désigne (`themes/<nom>.css`).
fn resolve_active_theme_path(base: &ThemeBase) -> Result<PathBuf, String> {
    let name = fs::read_to_string(&base.config_path)
        .map_err(|e| {
            format!(
                "lecture de .config impossible ({}): {e}",
                base.config_path.display()
            )
        })?
        .trim()
        .to_string();
    Ok(base.themes_dir.join(format!("{name}.css")))
}

#[tauri::command]
pub fn theme_read(app: tauri::AppHandle) -> Result<String, String> {
    let base = resolve_base(&app)?;
    let theme_path = resolve_active_theme_path(&base)?;
    fs::read_to_string(&theme_path)
        .map_err(|e| format!("lecture du thème impossible ({}): {e}", theme_path.display()))
}

#[tauri::command]
pub fn theme_watch(app: tauri::AppHandle, on_change: Channel<String>) -> Result<(), String> {
    let base = resolve_base(&app)?;

    thread::spawn(move || {
        let mut active_path = match resolve_active_theme_path(&base) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("den: theme_watch — résolution du thème actif impossible: {e}");
                return;
            }
        };

        let mut config_modified: Option<SystemTime> =
            fs::metadata(&base.config_path).and_then(|m| m.modified()).ok();
        let mut theme_modified: Option<SystemTime> =
            fs::metadata(&active_path).and_then(|m| m.modified()).ok();

        loop {
            thread::sleep(POLL_INTERVAL);

            // .config a-t-il changé ? Si oui, re-résoudre le thème actif.
            let current_config_modified =
                fs::metadata(&base.config_path).and_then(|m| m.modified()).ok();
            let config_changed = match (current_config_modified, config_modified) {
                (Some(cur), Some(prev)) => cur != prev,
                (Some(_), None) => true,
                _ => false,
            };
            if current_config_modified.is_some() {
                config_modified = current_config_modified;
            }

            if config_changed {
                match resolve_active_theme_path(&base) {
                    Ok(new_path) => {
                        active_path = new_path;
                        // Nouveau fichier actif : on force le push de son
                        // contenu ci-dessous en oubliant son mtime connu.
                        theme_modified = None;
                    }
                    Err(e) => {
                        eprintln!("den: theme_watch — re-résolution du thème impossible: {e}");
                        continue;
                    }
                }
            }

            let current_theme_modified = match fs::metadata(&active_path).and_then(|m| m.modified()) {
                Ok(m) => m,
                // Fichier temporairement illisible (ex. écriture en cours) —
                // on retente au prochain tick, pas d'erreur remontée.
                Err(_) => continue,
            };

            let theme_changed = match theme_modified {
                Some(prev) => current_theme_modified != prev,
                None => true,
            };
            if !theme_changed {
                continue;
            }
            theme_modified = Some(current_theme_modified);

            match fs::read_to_string(&active_path) {
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
                        active_path.display()
                    );
                }
            }
        }
    });

    Ok(())
}
