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
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { DenContext } from "../core/registry";
import { decodePtyChunk, type PtyChunk } from "./decode";
import { debounce } from "./debounce";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const RESIZE_DEBOUNCE_MS = 80;

const FALLBACK_FONT_FAMILY = '"SF Mono", Menlo, Consolas, monospace';
const FALLBACK_FONT_SIZE = 13;
const FALLBACK_BACKGROUND = "#000000";
const SELECTION_ALPHA_HEX = "55";

interface TerminalStyle {
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
}

/** Lit une custom property `--den-*` sur `document.documentElement`, déjà
 * appliquée par le module `theme` (ordre d'init : theme avant terminal). */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Concatène un alpha fixe à une couleur hex `#rrggbb` ; toute autre forme
 * (nom CSS, rgb(), variable non résolue...) est renvoyée telle quelle, sans
 * alpha — on ne sait pas lui en injecter un sans risquer une valeur CSS
 * invalide. */
function withAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alphaHex}` : color;
}

/** Dérive l'ITheme xterm.js et la police depuis les tokens `--den-*` posés
 * par le module theme. Pure : ne fait que lire le CSSOM, aucun effet de
 * bord. Pas de palette ANSI custom — les 16 couleurs xterm par défaut
 * restent en place (décision validée). */
function buildTerminalStyle(): TerminalStyle {
  const background = readToken("--den-bg-surface") || readToken("--den-bg") || FALLBACK_BACKGROUND;
  const foreground = readToken("--den-fg");
  const accent = readToken("--den-accent");

  const theme: ITheme = { background };
  if (foreground) {
    theme.foreground = foreground;
  }
  if (accent) {
    theme.cursor = accent;
    theme.selectionBackground = withAlpha(accent, SELECTION_ALPHA_HEX);
  }

  const fontFamily = readToken("--den-font-mono") || FALLBACK_FONT_FAMILY;
  // Un token dégénéré (0, négatif) casserait la grille xterm — fallback aussi.
  const parsedFontSize = parseInt(readToken("--den-font-size-base"), 10);
  const fontSize = parsedFontSize > 0 ? parsedFontSize : FALLBACK_FONT_SIZE;

  return { theme, fontFamily, fontSize };
}

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

  const initialStyle = buildTerminalStyle();
  const term = new Terminal({
    fontFamily: initialStyle.fontFamily,
    fontSize: initialStyle.fontSize,
    cursorBlink: true,
    theme: initialStyle.theme,
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

  /** Un changement de thème peut changer police/taille, donc la grille
   * cols/rows — on repropage explicitement au PTY via applyResize (le
   * ResizeObserver ne se déclenche pas forcément si les dimensions en
   * pixels du viewport n'ont pas bougé). */
  const handleThemeChanged = (): void => {
    const style = buildTerminalStyle();
    term.options.theme = style.theme;
    term.options.fontFamily = style.fontFamily;
    term.options.fontSize = style.fontSize;
    applyResize();
  };
  document.addEventListener("den:theme-changed", handleThemeChanged);

  window.addEventListener("beforeunload", () => {
    debouncedResize.cancel();
    resizeObserver.disconnect();
    document.removeEventListener("den:theme-changed", handleThemeChanged);
    if (ptyId !== undefined) {
      void invoke("pty_kill", { id: ptyId });
    }
  });
}
