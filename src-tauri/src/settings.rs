//! `settings.json` (DEN-55), même base que `state.json` ; schéma et validation côté TS, ici chaîne brute.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::state::{atomic_write, resolve_base};

const SETTINGS_FILE: &str = "settings.json";

/// `""` si le fichier est absent (premier lancement).
#[tauri::command]
pub fn settings_read(app: tauri::AppHandle) -> Result<String, String> {
    let base = resolve_base(&app)?;
    let path = base.join(SETTINGS_FILE);
    match fs::read_to_string(&path) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("lecture de {} impossible: {e}", path.display())),
    }
}

#[tauri::command]
pub fn settings_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let base = resolve_base(&app)?;
    atomic_write(&base, SETTINGS_FILE, &json)
}

/// Clé `theme` de `settings.json` ; `None` si absent, illisible, invalide ou non-string.
pub(crate) fn theme_from_settings(base: &Path) -> Option<String> {
    let raw = fs::read_to_string(base.join(SETTINGS_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("theme")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(tag: &str, content: Option<&str>) -> Option<String> {
        let dir = std::env::temp_dir().join(format!("den-settings-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        if let Some(c) = content {
            fs::write(dir.join(SETTINGS_FILE), c).unwrap();
        }
        let out = theme_from_settings(&dir);
        fs::remove_dir_all(&dir).unwrap();
        out
    }

    #[test]
    fn reads_theme_key() {
        assert_eq!(check("ok", Some(r#"{"theme":"light","x":1}"#)), Some("light".into()));
    }

    #[test]
    fn none_when_missing_invalid_absent_or_not_string() {
        assert_eq!(check("missing", None), None);
        assert_eq!(check("invalid", Some("{nope")), None);
        assert_eq!(check("nokey", Some(r#"{"a":1}"#)), None);
        assert_eq!(check("num", Some(r#"{"theme":3}"#)), None);
    }
}
