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

/// Seed du thème clair, même rôle que `DEFAULT_THEME_CSS`.
const LIGHT_THEME_CSS: &str = include_str!("../../themes/light.css");

/// Intervalle de polling du mtime — pas de watcher natif (pas de nouvelle
/// dépendance type `notify`), une résolution de 500ms est largement
/// suffisante pour un hot-reload de thème perçu comme instantané.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Racine des fichiers de thème pour une "base" donnée (repo en dev,
/// `app_config_dir()` sinon) : `.config` + dossier `themes/`.
struct ThemeBase {
    config_path: PathBuf,
    themes_dir: PathBuf,
    // Dossier de settings.json = base de state.json, pas forcément celle des thèmes.
    settings_dir: PathBuf,
}

/// Si présents, le `.config` + `themes/` versionnés à la racine du repo
/// (dev only).
fn dev_repo_base(settings_dir: PathBuf) -> Option<ThemeBase> {
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
            settings_dir,
        })
    } else {
        None
    }
}

/// Base "fichiers utilisateur" en `app_config_dir()`, amorcée avec les
/// seeds embarqués si elle n'existe pas encore.
fn user_base(app: &tauri::AppHandle, settings_dir: PathBuf) -> Result<ThemeBase, String> {
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

    let light_theme_path = themes_dir.join("light.css");
    if !light_theme_path.exists() {
        fs::write(&light_theme_path, LIGHT_THEME_CSS)
            .map_err(|e| format!("initialisation du thème clair impossible: {e}"))?;
    }

    Ok(ThemeBase {
        config_path,
        themes_dir,
        settings_dir,
    })
}

/// Résout la base (dev repo ou fichiers utilisateur) selon l'ordre
/// documenté en tête de module.
fn resolve_base(app: &tauri::AppHandle) -> Result<ThemeBase, String> {
    let settings_dir = crate::state::resolve_base(app)?;
    if let Some(base) = dev_repo_base(settings_dir.clone()) {
        return Ok(base);
    }
    user_base(app, settings_dir)
}

/// Nom de thème sûr : jamais de chemin hors de `themes/`.
fn is_valid_theme_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

/// Premier nom valide dont le fichier existe parmi settings puis `.config`, sinon `default`.
fn pick_theme_name(
    from_settings: Option<&str>,
    from_config: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> String {
    [from_settings, from_config]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|n| is_valid_theme_name(n) && exists(n))
        .unwrap_or("default")
        .to_string()
}

/// Thème actif : `settings.json` "theme", puis `.config`, puis `default`.
fn resolve_active_theme_path(base: &ThemeBase) -> PathBuf {
    let from_settings = crate::settings::theme_from_settings(&base.settings_dir);
    let from_config = fs::read_to_string(&base.config_path).ok();
    let name = pick_theme_name(from_settings.as_deref(), from_config.as_deref(), |n| {
        base.themes_dir.join(format!("{n}.css")).is_file()
    });
    base.themes_dir.join(format!("{name}.css"))
}

#[tauri::command]
pub fn theme_read(app: tauri::AppHandle) -> Result<String, String> {
    let base = resolve_base(&app)?;
    let theme_path = resolve_active_theme_path(&base);
    fs::read_to_string(&theme_path)
        .map_err(|e| format!("lecture du thème impossible ({}): {e}", theme_path.display()))
}

/// Noms (sans `.css`) des thèmes disponibles dans la base active, triés.
#[tauri::command]
pub fn theme_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let base = resolve_base(&app)?;
    list_themes(&base.themes_dir)
}

/// Ouvre le dossier des thèmes dans le Finder : l'utilisateur y édite ou ajoute ses `.css`.
#[tauri::command]
pub fn theme_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let base = resolve_base(&app)?;
    app.opener()
        .open_path(base.themes_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("ouverture de {} impossible: {e}", base.themes_dir.display()))
}

fn list_themes(themes_dir: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(themes_dir)
        .map_err(|e| format!("lecture de {} impossible: {e}", themes_dir.display()))?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "css"))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .filter(|n| is_valid_theme_name(n))
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub fn theme_watch(app: tauri::AppHandle, on_change: Channel<String>) -> Result<(), String> {
    let base = resolve_base(&app)?;

    thread::spawn(move || {
        let settings_path = base.settings_dir.join("settings.json");
        let mtime = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();

        let mut active_path = resolve_active_theme_path(&base);
        let mut config_modified: Option<SystemTime> = mtime(&base.config_path);
        let mut settings_modified: Option<SystemTime> = mtime(&settings_path);
        let mut theme_modified: Option<SystemTime> = mtime(&active_path);

        loop {
            thread::sleep(POLL_INTERVAL);

            // Comparaison d'Option : couvre aussi l'apparition/disparition du fichier.
            let current_config_modified = mtime(&base.config_path);
            let current_settings_modified = mtime(&settings_path);
            if current_config_modified != config_modified
                || current_settings_modified != settings_modified
            {
                config_modified = current_config_modified;
                settings_modified = current_settings_modified;
                // Un réglage sans rapport avec le thème (mode, layout) ne doit pas re-pousser le CSS.
                let resolved = resolve_active_theme_path(&base);
                if resolved != active_path {
                    active_path = resolved;
                    theme_modified = None;
                }
            }

            let current_theme_modified = match fs::metadata(&active_path).and_then(|m| m.modified()) {
                Ok(m) => m,
                // Illisible (écriture en cours) ou supprimé : on re-résout pour retomber sur un thème valide.
                Err(_) => {
                    let resolved = resolve_active_theme_path(&base);
                    if resolved != active_path {
                        active_path = resolved;
                        theme_modified = None;
                    }
                    continue;
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_names() {
        for bad in ["", "a/b", "a\\b", "..", "../x", "a..b"] {
            assert!(!is_valid_theme_name(bad), "{bad:?}");
        }
        assert!(is_valid_theme_name("light"));
    }

    #[test]
    fn settings_beats_config_beats_default() {
        let all = |_: &str| true;
        assert_eq!(pick_theme_name(Some("light"), Some("default\n"), all), "light");
        assert_eq!(pick_theme_name(None, Some(" dark \n"), all), "dark");
        assert_eq!(pick_theme_name(Some("../x"), Some("dark"), all), "dark");
        assert_eq!(pick_theme_name(Some(""), Some("a/b"), all), "default");
        assert_eq!(pick_theme_name(None, None, all), "default");
    }

    #[test]
    fn missing_theme_file_falls_back() {
        let only_config = |n: &str| n == "dark";
        assert_eq!(pick_theme_name(Some("gone"), Some("dark"), only_config), "dark");
        assert_eq!(pick_theme_name(Some("gone"), Some("also-gone"), only_config), "default");
    }

    #[test]
    fn list_themes_sorted_css_only() {
        let dir = std::env::temp_dir().join(format!("den-themes-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for f in ["light.css", "default.css", "notes.txt"] {
            fs::write(dir.join(f), "").unwrap();
        }
        assert_eq!(list_themes(&dir).unwrap(), vec!["default", "light"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
