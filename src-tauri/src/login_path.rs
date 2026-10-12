//! PATH du shell de login (DEN-11). Une app lancée depuis Finder hérite d'un
//! PATH minimal où `node` (nvm) et Homebrew sont introuvables ; on lit donc
//! le PATH de `$SHELL -ilc` (login interactif : même `node` que le terminal).

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

const START: &str = "__DEN_PATH_START__";
const END: &str = "__DEN_PATH_END__";
const TIMEOUT: Duration = Duration::from_secs(5);

/// Extrait le PATH entre les marqueurs, malgré le bruit que `.zshrc` peut imprimer.
pub fn extract_path(stdout: &str) -> Option<String> {
    let after_start = stdout.split_once(START)?.1;
    let path = after_start.split_once(END)?.0.trim();
    (!path.is_empty()).then(|| path.to_string())
}

fn read_login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(shell)
        .arg("-ilc")
        .arg(format!("printf '{START}%s{END}' \"$PATH\""))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        // Arrêt dès le marqueur de fin : un process d'arrière-plan de .zshrc peut garder le pipe ouvert sans EOF.
        let (mut acc, mut chunk) = (Vec::new(), [0u8; 4096]);
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    acc.extend_from_slice(&chunk[..n]);
                    if let Some(path) = extract_path(&String::from_utf8_lossy(&acc)) {
                        let _ = tx.send(path);
                        return;
                    }
                }
            }
        }
    });

    let path = rx.recv_timeout(TIMEOUT).ok();
    // Shell bloqué (prompt interactif, .zshrc qui pend) ou déjà fini : kill sans effet dans ce cas.
    let _ = child.kill();
    let _ = child.wait();
    path
}

/// Lu une seule fois ; les appels concurrents attendent le premier.
pub fn login_path() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(read_login_path).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_path_despite_noise() {
        let out = "welcome\n__DEN_PATH_START__/opt/homebrew/bin:/usr/bin__DEN_PATH_END__\nbye";
        assert_eq!(extract_path(out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
    }

    #[test]
    fn none_without_markers() {
        assert_eq!(extract_path("/usr/bin:/bin"), None);
        assert_eq!(extract_path("__DEN_PATH_START__/usr/bin"), None);
    }

    #[test]
    fn none_on_empty_path() {
        assert_eq!(extract_path("__DEN_PATH_START____DEN_PATH_END__"), None);
        assert_eq!(extract_path("__DEN_PATH_START__  __DEN_PATH_END__"), None);
    }
}
