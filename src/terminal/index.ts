/**
 * Module `terminal` — xterm.js branché sur le PTY Rust (portable-pty) via
 * les commands `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill` et un
 * `Channel<Vec<u8>>` Tauri pour le flux de données (jamais `emit()`).
 *
 * Stub lot 0 : placeholder visible, aucune logique PTY/xterm.
 */
import type { DenContext } from "../core/registry";

export function init(ctx: DenContext): void {
  ctx.mounts.terminal.textContent =
    "terminal: en attente d'implémentation (lot dédié)";
}
