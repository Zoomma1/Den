/**
 * Module `terminal` — xterm.js branché sur le PTY Rust (portable-pty) via
 * les commands `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill` et un
 * `Channel<Vec<u8>>` Tauri pour le flux de données (jamais `emit()`, cf.
 * CLAUDE.md racine).
 *
 * Le format exact livré par le `Channel<Vec<u8>>` côté JS (ArrayBuffer ou
 * tableau de nombres, selon le mécanisme IPC emprunté) est normalisé par
 * `decodePtyChunk` (voir `decode.ts`) — le module ne présume pas de la forme.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { DenContext } from "../core/registry";
import { decodePtyChunk, type PtyChunk } from "./decode";
import { debounce } from "./debounce";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const RESIZE_DEBOUNCE_MS = 80;

/** Charge l'addon WebGL ; retombe silencieusement sur le rendu DOM par
 * défaut de xterm.js si le contexte WebGL2 n'est pas disponible, ou s'il est
 * perdu en cours de route. */
function loadWebglWithFallback(term: Terminal): void {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      console.warn("Den/terminal: contexte WebGL perdu, retour au rendu DOM");
      webgl.dispose();
    });
    term.loadAddon(webgl);
  } catch (err) {
    console.warn("Den/terminal: WebGL indisponible, rendu DOM standard", err);
  }
}

export function init(ctx: DenContext): void {
  const root = ctx.mounts.terminal;
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.className = "den-terminal__toolbar";
  toolbar.textContent = "Terminal";

  const viewport = document.createElement("div");
  viewport.className = "den-terminal__viewport";

  root.append(toolbar, viewport);

  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: "#000000" },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  loadWebglWithFallback(term);

  term.open(viewport);
  fitAddon.fit();

  let ptyId: number | undefined;
  let spawnFailed = false;

  const onData = new Channel<PtyChunk>();
  onData.onmessage = (chunk) => {
    term.write(decodePtyChunk(chunk));
  };

  invoke<number>("pty_spawn", { cols: term.cols, rows: term.rows, onData })
    .then((id) => {
      ptyId = id;
    })
    .catch((err: unknown) => {
      spawnFailed = true;
      console.error("Den/terminal: pty_spawn en échec", err);
      term.writeln(`\r\n\x1b[31mDen: impossible de démarrer le shell (${String(err)})\x1b[0m`);
    });

  term.onData((data) => {
    if (ptyId === undefined || spawnFailed) {
      return;
    }
    void invoke("pty_write", { id: ptyId, data }).catch((err: unknown) => {
      console.error("Den/terminal: pty_write en échec", err);
    });
  });

  const applyResize = (): void => {
    fitAddon.fit();
    if (ptyId === undefined) {
      return;
    }
    void invoke("pty_resize", { id: ptyId, cols: term.cols, rows: term.rows }).catch(
      (err: unknown) => {
        console.error("Den/terminal: pty_resize en échec", err);
      },
    );
  };

  const debouncedResize = debounce(applyResize, RESIZE_DEBOUNCE_MS);

  const resizeObserver = new ResizeObserver(() => {
    debouncedResize();
  });
  resizeObserver.observe(viewport);

  window.addEventListener("beforeunload", () => {
    debouncedResize.cancel();
    resizeObserver.disconnect();
    if (ptyId !== undefined) {
      void invoke("pty_kill", { id: ptyId });
    }
  });
}
