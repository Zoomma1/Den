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
use std::time::{Duration, Instant};

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

/// Énumère les PID de TOUS les descendants transitifs de `root` (DEN-06,
/// escalade de `sidecar_kill`), le wrapper exclu. Parcours de l'arbre via
/// `pgrep -P` — PAS `ps -ppid`, qui n'existe pas sur macOS (BSD ps :
/// "Invalid process id"). Récursif car l'arbre réel a ≥3 niveaux sous le
/// wrapper (tsx -> node main.ts -> CLI claude -> bash éventuels) : ne tuer
/// que les enfants directs orphelinerait le CLI. macOS ne permet pas
/// d'énumérer par marqueur d'env (l'env d'un process n'est pas lisible par
/// `ps`) — la parenté, parent vivant, est la seule voie disponible, d'où
/// l'appel juste avant de tuer le wrapper (au-delà, ses descendants sont
/// reparentés et leur ppid d'origine est perdu).
/// Best-effort, deux limites assumées : un échec de `pgrep` (binaire
/// absent, sandbox...) donne une liste vide plutôt qu'une erreur —
/// l'escalade continue quand même avec le kill du wrapper lui-même ; et
/// l'énumération est un instantané (TOCTOU) — un descendant qui fork entre
/// l'instantané et son propre kill laisse un petit-fils non énuméré. Ce
/// chemin n'est que le filet du filet (mort douce ratée après 3 s) ; la
/// garantie de fond reste l'auto-terminaison côté `main.ts`.
fn enumerate_descendants(root: u32) -> Vec<u32> {
    let mut descendants = Vec::new();
    let mut frontier = vec![root];
    while let Some(pid) = frontier.pop() {
        let output = match Command::new("pgrep").arg("-P").arg(pid.to_string()).output() {
            Ok(output) => output,
            Err(_) => continue,
        };
        for child in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
        {
            descendants.push(child);
            frontier.push(child);
        }
    }
    descendants
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

    let mut command = resolve_sidecar_command(&cwd)?;

    // Marqueur d'identification de l'ARBRE sidecar (DEN-06) : hérité par
    // tout descendant (tsx -> node main.ts -> CLI -> bash detached), il
    // permet de découvrir/compter les arbres via `ps -E`. Découverte
    // uniquement — tout kill reste gardé PID par PID après vérification.
    let marker = format!(
        "{tab_id}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    command.env("DEN_SIDECAR", &marker);

    // PID du process Rust, pour le watchdog de `sidecar/src/main.ts`
    // (DEN-06) : `process.ppid` là-bas ne voit que le wrapper tsx (main.ts
    // tourne dans un node FILS du wrapper), jamais ce process — un crash de
    // l'app laisserait le tsx orphelin vivant et le ppid du node inchangé.
    // Le sidecar sonde donc directement la vie de CE pid (`kill(pid, 0)`).
    command.env("DEN_PARENT_PID", std::process::id().to_string());

    let mut child: Child = command
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
            // Mort douce puis escalade (DEN-06). Le retrait du registre
            // (`sidecar_kill`/`sidecar_kill_all`, avant que `shutdown` ne
            // passe à `true`) a déjà drop l'unique `Arc<Mutex<ChildStdin>>`
            // du tab -> EOF sur le stdin du wrapper tsx -> `rl.on("close")`
            // côté `sidecar/src/main.ts` -> `dieGracefully()` -> cascade
            // jusqu'au CLI claude et au wrapper lui-même. On laisse cette
            // cascade s'exécuter avant de tuer quoi que ce soit : `shutdown_at`
            // marque l'instant de la première observation du flag, jamais
            // réarmé ensuite (une seule fenêtre de grâce par tab).
            let mut shutdown_at: Option<Instant> = None;
            let mut escalated = false;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => {
                        if shutdown.load(Ordering::SeqCst) {
                            match shutdown_at {
                                None => shutdown_at = Some(Instant::now()),
                                Some(at)
                                    if !escalated && at.elapsed() >= Duration::from_secs(3) =>
                                {
                                    // Mort douce sans effet après 3s (main.ts
                                    // bloqué, hard-exit qui pend, wrapper qui
                                    // n'a jamais reçu l'EOF...) : escalade.
                                    // Énumération des enfants directs du
                                    // wrapper AVANT de le tuer — un wrapper
                                    // mort ne les laisse plus retrouver par
                                    // ppid (reparentés/orphelins, ppid perdu).
                                    escalated = true;
                                    let descendants = enumerate_descendants(child.id());
                                    let _ = child.kill();
                                    for pid in descendants {
                                        // PID exact fraîchement énuméré —
                                        // jamais de pkill/pattern (cf.
                                        // commentaire du marqueur DEN_SIDECAR
                                        // plus haut : découverte uniquement,
                                        // kill toujours PID par PID vérifié).
                                        // `-9` : même sémantique que le
                                        // `child.kill()` (SIGKILL) du wrapper
                                        // — dans cette branche le process est
                                        // présumé gelé, un SIGTERM catchable
                                        // ne garantirait rien.
                                        let _ = Command::new("kill")
                                            .arg("-9")
                                            .arg(pid.to_string())
                                            .status();
                                    }
                                }
                                _ => {}
                            }
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
    //
    // Le `remove` ici est ce qui déclenche la mort douce (DEN-06) : `entry`
    // est possédé localement puis drop en fin de fonction, entraînant le
    // drop du dernier `Arc<Mutex<ChildStdin>>` du tab (aucun autre clone ne
    // survit ailleurs — `sidecar_send` ne fait qu'emprunter le sien le
    // temps d'une écriture, cf. doc de `TabSidecar::stdin`) => fermeture du
    // fd => EOF côté sidecar, AVANT même que `shutdown` ne soit vu par le
    // thread de surveillance.
    if let Some(entry) = lock_registry().remove(&tab_id) {
        entry.shutdown.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn sidecar_kill_all() -> Result<(), String> {
    // Purge totale du registre (DEN-06) : appelée par `src/tabs/index.ts`
    // en tout début de `init()`, avant tout `sidecar_spawn`, pour tuer les
    // sidecars d'une session précédente qui auraient échappé à
    // `sidecar_kill` (ex. l'app tuée avant fermeture propre des tabs — le
    // thread de surveillance de chaque sidecar orphelin les rattrape aussi
    // via le watchdog ppid côté `main.ts`, mais cette purge est immédiate).
    // Même séquence de mort douce que `sidecar_kill`, tab par tab : le
    // `drain` possède chaque `entry` localement, elle drop en fin de corps
    // de boucle -> même cascade EOF que ci-dessus, pour chaque tab.
    let mut registry = lock_registry();
    for (_, entry) in registry.drain() {
        entry.shutdown.store(true, Ordering::SeqCst);
    }
    Ok(())
}
