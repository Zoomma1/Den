//! Module PTY — `portable-pty` UNIQUEMENT, jamais `tauri-plugin-shell`
//! (n'alloue pas de PTY : vim/couleurs/SIGWINCH cassés, cf. CLAUDE.md
//! racine). Le flux de sortie du PTY est relayé exclusivement via le
//! `Channel<Vec<u8>>` fourni à `pty_spawn` (jamais `emit()` — flux haut
//! débit).
//!
//! Signatures figées (contrat inter-lots) — ne pas changer sans mettre à
//! jour les appelants côté `src/terminal/index.ts`.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;

use tauri::ipc::Channel;

/// Une session PTY vivante : de quoi lui écrire, la redimensionner et la
/// tuer. La lecture de sa sortie tourne dans un thread dédié (spawné par
/// `pty_spawn`) qui ne passe jamais par ce registre — seul le nettoyage en
/// fin de vie (EOF ou erreur) y touche, via son propre lock, bref.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Cloné depuis le `Child` avant que celui-ci ne soit déplacé dans le
    /// thread lecteur (qui a besoin de `.wait()` pour éviter un zombie) —
    /// c'est ce clone indépendant que `pty_kill` signale depuis un autre
    /// thread.
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Registre global des sessions PTY vivantes, par id.
fn sessions() -> &'static Mutex<HashMap<u32, PtySession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, PtySession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_session_id() -> u32 {
    static NEXT_ID: AtomicU32 = AtomicU32::new(1);
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// Shell interactif de l'utilisateur : `$SHELL`, sinon `/bin/zsh`.
fn resolve_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

#[tauri::command]
pub fn pty_spawn(cols: u16, rows: u16, on_data: Channel<Vec<u8>>) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("ouverture du PTY impossible: {err}"))?;

    let mut cmd = CommandBuilder::new(resolve_shell());
    // xterm.js (addon webgl) rend le 256-couleurs et le truecolor : sans ces
    // deux variables, vim & co retombent sur la palette 8/16 couleurs.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("lancement du shell impossible: {err}"))?;

    // Le côté slave appartient désormais au process enfant (hérité au
    // fork/exec côté Unix) ; le refermer ici évite que le parent n'en garde
    // une copie ouverte — sinon les lectures sur le master ne verraient
    // jamais l'EOF une fois l'enfant terminé.
    drop(pair.slave);

    // À cloner AVANT de déplacer `child` dans le thread lecteur ci-dessous :
    // c'est ce clone que `pty_kill` utilise pour signaler la mort du
    // process depuis un autre thread pendant que le thread lecteur est
    // bloqué dans `reader.read`/`child.wait`.
    let killer = child.clone_killer();

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("clonage du lecteur PTY impossible: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("récupération de l'écrivain PTY impossible: {err}"))?;

    let id = next_session_id();
    sessions().lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            killer,
        },
    );

    // Thread lecteur dédié : lit le PTY en bloquant et pousse chaque chunk
    // via le Channel. Aucun lock du registre n'est tenu pendant ces I/O
    // bloquants (`reader.read`, `on_data.send`) — seul le nettoyage final
    // touche au registre, brièvement.
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF : le shell (ou son dernier enfant) a fermé le pty.
                Ok(n) => {
                    if on_data.send(buf[..n].to_vec()).is_err() {
                        // Plus personne côté front pour lire : on arrête de pomper.
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Récolte le process pour éviter un zombie (no-op s'il a déjà été
        // tué et récolté via pty_kill), puis nettoie le registre.
        let _ = child.wait();
        sessions().lock().unwrap().remove(&id);
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(id: u32, data: String) -> Result<(), String> {
    let mut guard = sessions().lock().unwrap();
    let session = guard
        .get_mut(&id)
        .ok_or_else(|| format!("session PTY {id} introuvable"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("écriture PTY impossible: {err}"))?;
    session
        .writer
        .flush()
        .map_err(|err| format!("flush PTY impossible: {err}"))
}

#[tauri::command]
pub fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let guard = sessions().lock().unwrap();
    let session = guard
        .get(&id)
        .ok_or_else(|| format!("session PTY {id} introuvable"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("resize PTY impossible: {err}"))
}

#[tauri::command]
pub fn pty_kill(id: u32) -> Result<(), String> {
    let removed = sessions().lock().unwrap().remove(&id);
    if let Some(mut session) = removed {
        session
            .killer
            .kill()
            .map_err(|err| format!("kill PTY impossible: {err}"))?;
    }
    Ok(())
}
