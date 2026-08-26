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
//!
//! Registre global (`Mutex<HashMap<tab_id, ...>>`) plutôt que du state géré
//! par Tauri : les signatures ci-dessous sont figées SANS paramètre
//! `State<...>`, donc pas d'autre choix qu'un global pour partager l'état
//! entre `sidecar_spawn`/`sidecar_send`/`sidecar_kill`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::ipc::Channel;

/// Un sidecar en cours d'exécution pour un tab donné.
struct TabSidecar {
    /// `Arc` plutôt qu'un `Mutex<ChildStdin>` nu : `sidecar_send` clone ce
    /// handle puis relâche IMMÉDIATEMENT le verrou du registre global avant
    /// d'écrire sur stdin. Sans ça, écrire (et flush) sous le verrou global
    /// bloquerait `sidecar_send`/`sidecar_spawn`/`sidecar_kill` de TOUS les
    /// autres tabs pendant l'écriture d'un seul.
    stdin: Arc<Mutex<ChildStdin>>,
    /// Positionné à `true` par `sidecar_kill` ; lu par le thread de
    /// surveillance de fin de vie (cf. `sidecar_spawn`), qui tue alors
    /// réellement le process. Volontairement PAS de `Mutex<Child>` partagé
    /// entre ce thread et les commandes : `sidecar_kill` a besoin d'agir
    /// sur ce tab pendant que le thread de surveillance est bloqué en
    /// attente de fin de process — un verrou partagé entre "wait() qui ne
    /// rend la main qu'à la mort du process" et "kill() qui a besoin du
    /// même verrou pour agir" dead-lock (le kill ne peut jamais s'exécuter
    /// tant que wait() tient le verrou, et wait() ne rend la main que si le
    /// process meurt — ce qui suppose kill()). L'`AtomicBool` découple les
    /// deux sans jamais se bloquer mutuellement.
    shutdown: Arc<AtomicBool>,
}

/// Registre global par tab_id.
static REGISTRY: OnceLock<Mutex<HashMap<String, TabSidecar>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, TabSidecar>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Un panic dans un thread pendant qu'il tient le verrou empoisonnerait le
/// `Mutex` — sans quoi une seule session buggée figerait `sidecar_send`/
/// `sidecar_kill` pour TOUS les tabs. On récupère la garde même empoisonnée
/// (l'app reste responsive) plutôt que de propager le panic.
fn lock_registry() -> MutexGuard<'static, HashMap<String, TabSidecar>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Résout la commande de spawn du sidecar Node.
///
/// En dev : `npx tsx <repo>/sidecar/src/main.ts`, exécuté avec `cwd` = le
/// cwd de session demandé (paramètre `cwd` de `sidecar_spawn`).
///
/// `<repo>` est résolu via `CARGO_MANIFEST_DIR` (constante de compilation,
/// toujours égale à `src-tauri/` — cf. Cargo.toml — indépendamment du cwd
/// d'exécution du binaire), et PAS via le cwd courant du process : celui
/// qu'on passe à `Command::current_dir` ci-dessous est celui de la
/// SESSION (un dossier utilisateur arbitraire, potentiellement sans aucun
/// rapport avec ce repo). Un `npx tsx` lancé avec ce cwd ne retrouverait
/// jamais le `tsx` installé localement dans `sidecar/node_modules` — npx
/// résout ses binaires locaux en remontant depuis son PROPRE cwd, pas
/// depuis le chemin du fichier à exécuter. On invoque donc directement le
/// binaire `tsx` par son chemin absolu : équivalent fonctionnel de
/// `npx tsx <repo>/sidecar/src/main.ts` lancé depuis la racine du repo,
/// mais indépendant du cwd de session.
///
/// Limitation connue (dev uniquement, documentée) : en build packagé il
/// n'y a pas de `sidecar/node_modules` à côté du binaire — packager le
/// sidecar en exécutable autonome (sidecar bundling `tauri.conf.json`) est
/// hors scope de ce lot.
fn resolve_sidecar_command(cwd: &str) -> Result<Command, String> {
    let src_tauri_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = src_tauri_dir.parent().ok_or_else(|| {
        "CARGO_MANIFEST_DIR (src-tauri/) sans dossier parent — layout de repo inattendu".to_string()
    })?;

    let sidecar_entry = repo_root.join("sidecar").join("src").join("main.ts");
    let tsx_bin = repo_root
        .join("sidecar")
        .join("node_modules")
        .join(".bin")
        .join("tsx");

    let mut command = Command::new(tsx_bin);
    command.arg(sidecar_entry);
    command.current_dir(cwd);

    // JAMAIS de clé API dans l'env de ce process — l'auth passe par
    // l'OAuth du CLI déjà loggé (cf. CLAUDE.md racine, incident
    // 2026-08-24). Pas de `env_clear()` : casserait PATH/HOME et donc la
    // résolution de node lui-même et l'OAuth.
    command.env_remove("ANTHROPIC_API_KEY");

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(command)
}

#[tauri::command]
pub fn sidecar_spawn(
    tab_id: String,
    cwd: String,
    on_message: Channel<String>,
) -> Result<(), String> {
    if lock_registry().contains_key(&tab_id) {
        return Err(format!("un sidecar tourne déjà pour le tab {tab_id}"));
    }

    let mut child: Child = resolve_sidecar_command(&cwd)?
        .spawn()
        .map_err(|err| format!("échec du spawn du sidecar: {err}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "stdin du sidecar indisponible".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout du sidecar indisponible".to_string())?;
    let stderr = child.stderr.take();

    let shutdown = Arc::new(AtomicBool::new(false));

    lock_registry().insert(
        tab_id.clone(),
        TabSidecar {
            stdin: Arc::new(Mutex::new(stdin)),
            shutdown: shutdown.clone(),
        },
    );

    // Lecture stdout ligne par ligne -> relais NDJSON brut sur le channel
    // (jamais `emit()` — flux potentiellement haut débit, cf. CLAUDE.md
    // racine). Une ligne = un message NDJSON complet ; le parsing/la
    // validation contre le protocole vivent côté TS (cf. `src/tabs/router.ts`).
    {
        let on_message = on_message.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        // `lines()` strippe le `\n` — le rétablir : le
                        // NdjsonLineBuffer côté TS ne délivre une ligne
                        // qu'une fois son `\n` terminal reçu.
                        if on_message.send(format!("{line}\n")).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Stderr : hors protocole NDJSON (aucun type prévu pour du texte brut
    // côté `src/types/protocol.ts`) — juste drainé vers les logs Rust pour
    // ne jamais bloquer le sidecar si son pipe stderr se remplit.
    if let Some(stderr) = stderr {
        let tab_id = tab_id.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[sidecar:{tab_id}] {line}");
            }
        });
    }

    // Surveillance de fin de vie du process, en polling non bloquant (cf.
    // note sur `TabSidecar::shutdown` : jamais de `child.wait()` bloquant
    // sous un verrou partagé avec `sidecar_kill`). `child` est déplacé
    // entièrement ici — ce thread en est l'unique propriétaire dès cet
    // instant, y compris pour le tuer.
    {
        let tab_id = tab_id.clone();
        thread::spawn(move || {
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => {
                        if shutdown.load(Ordering::SeqCst) {
                            let _ = child.kill();
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                    Err(_) => break None,
                }
            };

            // Nettoyage : idempotent avec `sidecar_kill`, qui a pu déjà
            // retirer l'entrée (cas d'une fermeture de tab demandée par
            // l'utilisateur plutôt qu'un crash détecté ici).
            let _ = lock_registry().remove(&tab_id);

            let message = match status {
                Some(status) => format!(
                    "Le sidecar du tab {tab_id} s'est terminé (code: {:?}).",
                    status.code()
                ),
                None => format!(
                    "Le sidecar du tab {tab_id} a échappé à la surveillance de son process."
                ),
            };

            // `\n` terminal obligatoire : le NdjsonLineBuffer côté TS ne
            // délivre une ligne qu'une fois son `\n` reçu (même contrat que
            // le relais stdout ci-dessus).
            let _ = on_message.send(format!(
                "{}\n",
                serde_json::json!({
                    "type": "error",
                    "message": message,
                    "recoverable": false,
                })
            ));
        });
    }

    Ok(())
}

#[tauri::command]
pub fn sidecar_send(tab_id: String, message: String) -> Result<(), String> {
    // Le verrou du registre n'est tenu que le temps de cloner le handle
    // stdin de CE tab — jamais pendant l'écriture elle-même (cf. doc de
    // `TabSidecar::stdin`).
    let stdin_handle = {
        let registry = lock_registry();
        let entry = registry
            .get(&tab_id)
            .ok_or_else(|| format!("aucun sidecar actif pour le tab {tab_id}"))?;
        entry.stdin.clone()
    };

    let mut stdin = stdin_handle
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    writeln!(stdin, "{message}").map_err(|err| format!("échec d'écriture NDJSON: {err}"))?;
    stdin
        .flush()
        .map_err(|err| format!("échec de flush stdin: {err}"))
}

#[tauri::command]
pub fn sidecar_kill(tab_id: String) -> Result<(), String> {
    // Idempotent : un tab déjà mort (crash détecté par le thread de
    // surveillance, qui s'est déjà retiré du registre) ne doit jamais faire
    // échouer la fermeture du tab côté UI.
    if let Some(entry) = lock_registry().remove(&tab_id) {
        entry.shutdown.store(true, Ordering::SeqCst);
    }
    Ok(())
}
