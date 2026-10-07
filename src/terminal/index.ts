/**
 * Module `terminal` — xterm.js branché sur le PTY Rust (portable-pty) via
 * les commands `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill` et un
 * `Channel<Vec<u8>>` Tauri pour le flux de données (jamais `emit()`, cf.
 * CLAUDE.md racine).
 *
 * Le format exact livré par le `Channel<Vec<u8>>` côté JS (ArrayBuffer ou
 * tableau de nombres, selon le mécanisme IPC emprunté) est normalisé par
 * `decodePtyChunk` (voir `decode.ts`) — le module ne présume pas de la forme.
 *
 * DEN-04 A4-2 — groupes de terminaux par nœud propriétaire : un groupe de
 * shells (au moins un onglet) par owner de session (`groupKey`, cf.
 * `./group.ts`), chaque PTY ouvert dans le `cwd` de la session, créé
 * paresseusement au premier `den:active-tab-changed` pour cet owner. Même
 * patron de multiplexage que `ConversationView`/`src/markdown/index.ts` :
 * une `Map` de groupes, création paresseuse, `el.hidden` pour montrer/cacher
 * (jamais `display:none` à la main ni retrait du DOM), owner `null` cache
 * tout sans rien créer.
 *
 * WebGL (~16 contextes/page) : seul l'onglet ACTIF du groupe VISIBLE porte
 * un `WebglAddon` — `refreshWebgl` (dessous) est l'unique point qui
 * charge/décharge ces addons, appelé après tout changement de visibilité de
 * groupe ou d'onglet actif. Au plus un contexte WebGL vivant à tout instant.
 *
 * Contrat d'événements consommés (sur `window`, sauf `den:theme-changed` sur
 * `document` — cf. `src/theme`) :
 * - `den:active-tab-changed` (`detail: { tabId, cwd, owner }`, cf.
 *   `src/tabs/index.ts`) : `owner`/`cwd`/`tabId` non nuls -> montre le
 *   groupe de cet owner/cwd (créé paresseusement si absent, avec un premier
 *   shell spawné immédiatement) ; `null` -> tout masqué, rien créé.
 * - `den:owner-removed` (`detail: { kind, id }`) : si `kind === "project"`,
 *   tue tous les onglets du groupe correspondant et le retire ; tout autre
 *   `kind` est ignoré. Un groupe ne meurt que sur cet événement (son projet
 *   reste dans l'arbre, on peut y rouvrir une session).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { DenContext } from "../core/registry";
import { decodePtyChunk, type PtyChunk } from "./decode";
import { debounce, type Debounced } from "./debounce";
import { groupKey, nextActiveIndex, shellLabel } from "./group";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

const RESIZE_DEBOUNCE_MS = 80;

const FALLBACK_FONT_FAMILY = '"SF Mono", Menlo, Consolas, monospace';
const FALLBACK_FONT_SIZE = 13;
// Si la police ne se résout jamais, on ouvre la gate quand même : un terminal à la mauvaise police vaut mieux qu'un terminal mort.
const FONT_GATE_TIMEOUT_MS = 2000;
const FALLBACK_BACKGROUND = "#000000";
const SELECTION_ALPHA_HEX = "55";

interface TerminalStyle {
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
}

/** Owner minimal tel que porté par `den:active-tab-changed` /
 * `den:owner-removed` — structurellement compatible
 * avec `Owner` (`src/tabs/owner.ts`) sans avoir besoin de l'importer (le
 * `cwd` d'une session arrive déjà résolu dans ces détails, cf. docstring de
 * tête : aucun besoin de `resolveCwd` ici non plus). */
interface OwnerLike {
  kind: "project";
  id: string;
}

interface ActiveTabChangedDetail {
  tabId: string | null;
  cwd: string | null;
  owner: OwnerLike | null;
}

interface OwnerRemovedDetail {
  kind: string;
  id: string;
}

/** Un onglet shell d'un groupe : son xterm.js, son addon WebGL (chargé
 * seulement si c'est l'onglet actif du groupe visible, cf. `refreshWebgl`),
 * son PTY, et tout ce qui gère son redimensionnement (garde dimensionnelle
 * d'A4-1, appliquée PAR onglet — chaque onglet a son propre viewport,
 * `fitAddon`, `ResizeObserver`, `debouncedResize`). */
interface TerminalShell {
  term: Terminal;
  fitAddon: FitAddon;
  webgl: WebglAddon | null;
  viewportEl: HTMLElement;
  tabButtonEl: HTMLButtonElement;
  ptyId: number | undefined;
  spawnFailed: boolean;
  resizeObserver: ResizeObserver;
  debouncedResize: Debounced<[]>;
  /** Applique immédiatement (pas debouncé) le resize xterm + `pty_resize` —
   * même garde dimensionnelle que le `ResizeObserver` (viewport 0×0 ->
   * no-op). Appelé au réaffichage d'un onglet (le `ResizeObserver` seul ne
   * se redéclenche pas forcément si les dimensions px n'ont pas bougé
   * pendant le masquage). */
  applyResize: () => void;
}

/** Un groupe de terminaux : un ou plusieurs onglets shell partageant le même
 * `cwd` (celui de la session propriétaire, cf. `groupKey`). */
interface TerminalGroup {
  key: string;
  cwd: string;
  groupEl: HTMLElement;
  tabsBarEl: HTMLElement;
  addButtonEl: HTMLButtonElement;
  shells: TerminalShell[];
  /** Index de l'onglet actif dans `shells`, `-1` si le groupe est vide
   * (dernier onglet fermé — le "+" le repeuple). */
  activeIndex: number;
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
  // Fond opaque : --den-terminal-bg, puis --den-bg-surface, sans allowTransparency.
  const background =
    readToken("--den-terminal-bg") || readToken("--den-bg-surface") || FALLBACK_BACKGROUND;
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

  theme.overviewRulerBorder = readToken("--den-edge") || "transparent";
  const sliderBg = readToken("--den-glass-3");
  const sliderHover = readToken("--den-edge-hi");
  if (sliderBg) theme.scrollbarSliderBackground = sliderBg;
  if (sliderHover) {
    theme.scrollbarSliderHoverBackground = sliderHover;
    theme.scrollbarSliderActiveBackground = accent || sliderHover;
  }

  const fontFamily = readToken("--den-font-mono") || FALLBACK_FONT_FAMILY;
  // Un token dégénéré (0, négatif) casserait la grille xterm — fallback aussi.
  const parsedFontSize = parseInt(readToken("--den-font-size-base"), 10);
  const fontSize = parsedFontSize > 0 ? parsedFontSize : FALLBACK_FONT_SIZE;

  return { theme, fontFamily, fontSize };
}

/** Charge l'addon WebGL et retourne l'instance créée (`null` si
 * indisponible) — retombe silencieusement sur le rendu DOM par défaut de
 * xterm.js si le contexte WebGL2 n'est pas disponible, ou s'il est perdu en
 * cours de route. La référence retournée est ce que `refreshWebgl` dispose
 * quand l'onglet cesse d'être l'onglet actif du groupe visible. */
function loadWebglWithFallback(term: Terminal): WebglAddon | null {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      console.warn("Den/terminal: contexte WebGL perdu, retour au rendu DOM");
      webgl.dispose();
    });
    term.loadAddon(webgl);
    return webgl;
  } catch (err) {
    console.warn("Den/terminal: WebGL indisponible, rendu DOM standard", err);
    return null;
  }
}

export function init(ctx: DenContext): void {
  const root = ctx.mounts.terminal;
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.className = "den-terminal__toolbar";

  const labelEl = document.createElement("div");
  labelEl.className = "den-terminal__label";
  labelEl.textContent = "Terminal";
  toolbar.appendChild(labelEl);

  const viewsEl = document.createElement("div");
  viewsEl.className = "den-terminal__views";

  root.append(toolbar, viewsEl);

  const groups = new Map<string, TerminalGroup>();
  /** Clé du groupe actuellement montré, `null` si aucun (owner null, ou
   * aucune session active). */
  let shownKey: string | null = null;

  /** Unique point qui charge/décharge les `WebglAddon` (cf. docstring de
   * tête) — ssi l'onglet est l'onglet actif du groupe visible. Rappelée
   * après tout changement de groupe visible ou d'onglet actif. */
  function refreshWebgl(): void {
    for (const group of groups.values()) {
      const groupShown = group.key === shownKey;
      group.shells.forEach((shell, idx) => {
        const shouldHaveWebgl = groupShown && idx === group.activeIndex;
        if (shouldHaveWebgl && !shell.webgl) {
          shell.webgl = loadWebglWithFallback(shell.term);
        } else if (!shouldHaveWebgl && shell.webgl) {
          shell.webgl.dispose();
          shell.webgl = null;
        }
      });
    }
  }

  /** Renumérote les libellés "shell N" après un retrait d'onglet (les index
   * ont glissé). */
  function relabelShells(group: TerminalGroup): void {
    group.shells.forEach((shell, idx) => {
      const labelSpan = shell.tabButtonEl.querySelector<HTMLElement>(".den-terminal__tab-label");
      if (labelSpan) labelSpan.textContent = shellLabel(idx);
    });
  }

  /** Change l'onglet actif d'un groupe : bascule `hidden` sur les
   * viewports, resynchronise WebGL, et — si le groupe est actuellement
   * visible — déclenche un resize immédiat du nouvel onglet actif (son
   * viewport vient potentiellement de passer de masqué à visible). */
  function setActiveShellIndex(group: TerminalGroup, index: number): void {
    group.activeIndex = index;
    group.shells.forEach((shell, idx) => {
      const active = idx === index;
      shell.viewportEl.hidden = !active;
      shell.tabButtonEl.classList.toggle("den-terminal__tab--active", active);
      shell.tabButtonEl.setAttribute("aria-selected", String(active));
    });
    refreshWebgl();
    if (group.key === shownKey) {
      group.shells[index]?.applyResize();
    }
  }

  /** Crée un onglet shell dans `group` (xterm.js + PTY spawné dans
   * `group.cwd`) — n'active PAS l'onglet, c'est au caller de le faire via
   * `setActiveShellIndex`. */
  function spawnShell(group: TerminalGroup): TerminalShell {
    const index = group.shells.length;

    const viewportEl = document.createElement("div");
    viewportEl.className = "den-terminal__viewport";
    viewportEl.hidden = true;
    group.groupEl.appendChild(viewportEl);

    const tabButtonEl = document.createElement("button");
    tabButtonEl.type = "button";
    tabButtonEl.className = "den-terminal__tab";
    tabButtonEl.setAttribute("role", "tab");
    const labelSpan = document.createElement("span");
    labelSpan.className = "den-terminal__tab-label";
    labelSpan.textContent = shellLabel(index);
    const closeSpan = document.createElement("span");
    closeSpan.className = "den-terminal__tab-close";
    closeSpan.textContent = "×";
    closeSpan.setAttribute("role", "button");
    closeSpan.setAttribute("aria-label", "Close shell");
    tabButtonEl.append(labelSpan, closeSpan);
    group.tabsBarEl.insertBefore(tabButtonEl, group.addButtonEl);

    const initialStyle = buildTerminalStyle();
    const term = new Terminal({
      fontFamily: initialStyle.fontFamily,
      fontSize: initialStyle.fontSize,
      cursorBlink: true,
      theme: initialStyle.theme,
      // Largeur de la scrollbar (14px par défaut) ; FitAddon la relit pour la grille.
      overviewRuler: { width: 6 },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(viewportEl);

    const shell: TerminalShell = {
      term,
      fitAddon,
      webgl: null,
      viewportEl,
      tabButtonEl,
      ptyId: undefined,
      spawnFailed: false,
      // Assignés juste dessous — `applyResize` referme sur `shell` lui-même
      // (ptyId muté après coup par la résolution de `pty_spawn`).
      resizeObserver: undefined as unknown as ResizeObserver,
      debouncedResize: undefined as unknown as Debounced<[]>,
      applyResize: () => {},
    };

    const applyResize = (): void => {
      // Garde dimensionnelle (DEN-04 A4-1, PAR onglet) : un onglet masqué
      // (`hidden`, cf. `setActiveShellIndex`/`showGroup`) a un viewport
      // 0×0 — `fitAddon.fit()` y calculerait une grille dégénérée et
      // enverrait 2 col × 1 ligne au PTY, repliant tout ce qui s'écrit
      // pendant le masquage. Rien à faire au réaffichage : le
      // `ResizeObserver` de cet onglet refire dès qu'il repasse d'une
      // taille nulle à une taille réelle.
      if (viewportEl.clientWidth === 0 || viewportEl.clientHeight === 0) return;
      fitAddon.fit();
      if (shell.ptyId === undefined) return;
      void invoke("pty_resize", { id: shell.ptyId, cols: term.cols, rows: term.rows }).catch(
        (err: unknown) => {
          console.error("Den/terminal: pty_resize en échec", err);
        },
      );
    };
    shell.applyResize = applyResize;

    const debouncedResize = debounce(applyResize, RESIZE_DEBOUNCE_MS);
    shell.debouncedResize = debouncedResize;

    const resizeObserver = new ResizeObserver(() => {
      debouncedResize();
    });
    resizeObserver.observe(viewportEl);
    shell.resizeObserver = resizeObserver;

    tabButtonEl.addEventListener("click", () => {
      setActiveShellIndex(group, group.shells.indexOf(shell));
    });
    closeSpan.addEventListener("click", (event) => {
      event.stopPropagation();
      closeShell(group, shell);
    });

    const onData = new Channel<PtyChunk>();
    onData.onmessage = (chunk) => {
      term.write(decodePtyChunk(chunk));
    };

    invoke<number>("pty_spawn", { cols: term.cols, rows: term.rows, cwd: group.cwd, onData })
      .then((id) => {
        shell.ptyId = id;
      })
      .catch((err: unknown) => {
        shell.spawnFailed = true;
        console.error("Den/terminal: pty_spawn en échec", err);
        term.writeln(`\r\n\x1b[31mDen: unable to start the shell (${String(err)})\x1b[0m`);
      });

    term.onData((data) => {
      if (shell.ptyId === undefined || shell.spawnFailed) {
        return;
      }
      void invoke("pty_write", { id: shell.ptyId, data }).catch((err: unknown) => {
        console.error("Den/terminal: pty_write en échec", err);
      });
    });

    group.shells.push(shell);
    return shell;
  }

  /** Nettoie complètement un onglet shell (PTY, xterm, observer) — sans
   * toucher au DOM du groupe au-delà de son propre bouton/viewport (retirés
   * par l'appelant selon le contexte : `closeShell` les retire du DOM,
   * `killGroup` retire le groupe entier donc n'a pas besoin de le faire
   * onglet par onglet). */
  function disposeShell(shell: TerminalShell): void {
    shell.debouncedResize.cancel();
    shell.resizeObserver.disconnect();
    if (shell.webgl) {
      shell.webgl.dispose();
      shell.webgl = null;
    }
    shell.term.dispose();
    if (shell.ptyId !== undefined) {
      void invoke("pty_kill", { id: shell.ptyId }).catch((err: unknown) => {
        console.error("Den/terminal: pty_kill en échec", err);
      });
    }
  }

  /** Ferme un onglet shell (clic sur sa croix) : PTY tué, xterm disposé,
   * retiré de la liste, onglet voisin activé (`nextActiveIndex`) — un
   * groupe vide après retrait est autorisé, le "+" le repeuple. */
  function closeShell(group: TerminalGroup, shell: TerminalShell): void {
    const index = group.shells.indexOf(shell);
    if (index === -1) return;
    const countBefore = group.shells.length;

    disposeShell(shell);
    shell.tabButtonEl.remove();
    shell.viewportEl.remove();
    group.shells.splice(index, 1);
    relabelShells(group);

    const next = nextActiveIndex(countBefore, index);
    if (next === null) {
      group.activeIndex = -1;
      refreshWebgl();
    } else {
      setActiveShellIndex(group, next);
    }
  }

  /** Tue TOUS les onglets d'un groupe et retire le groupe (PTY, xterm, DOM)
   * — `den:owner-removed` d'un projet. */
  function killGroup(key: string): void {
    const group = groups.get(key);
    if (!group) return;
    for (const shell of group.shells) {
      disposeShell(shell);
    }
    group.groupEl.remove();
    group.tabsBarEl.remove();
    groups.delete(key);
    if (shownKey === key) {
      shownKey = null;
      labelEl.hidden = false;
    }
  }

  /** Crée un groupe (DOM + premier onglet spawné immédiatement, comme le
   * comportement actuel au démarrage — pas d'état "groupe vide" au premier
   * affichage). N'active pas sa visibilité : c'est `showGroup` qui s'en
   * charge, appelé juste après par `handleActiveTabChanged`. */
  function createGroup(key: string, cwd: string): TerminalGroup {
    const groupEl = document.createElement("div");
    groupEl.className = "den-terminal__group";
    groupEl.hidden = true;
    viewsEl.appendChild(groupEl);

    const tabsBarEl = document.createElement("div");
    tabsBarEl.className = "den-terminal__tabs";
    tabsBarEl.hidden = true;

    const addButtonEl = document.createElement("button");
    addButtonEl.type = "button";
    addButtonEl.className = "den-terminal__add";
    addButtonEl.textContent = "+";
    addButtonEl.setAttribute("aria-label", "New shell");
    tabsBarEl.appendChild(addButtonEl);
    toolbar.appendChild(tabsBarEl);

    const group: TerminalGroup = {
      key,
      cwd,
      groupEl,
      tabsBarEl,
      addButtonEl,
      shells: [],
      activeIndex: -1,
    };
    groups.set(key, group);

    addButtonEl.addEventListener("click", () => {
      spawnShell(group);
      setActiveShellIndex(group, group.shells.length - 1);
    });

    spawnShell(group);
    setActiveShellIndex(group, 0);

    return group;
  }

  /** Montre le groupe `key` (le crée d'abord si absent), masque tous les
   * autres — jamais de retrait DOM, `hidden` uniquement (cf. docstring de
   * tête). `null` masque tout sans rien créer. */
  function showGroup(key: string | null): void {
    shownKey = key;
    for (const group of groups.values()) {
      const shown = group.key === key;
      group.groupEl.hidden = !shown;
      group.tabsBarEl.hidden = !shown;
    }
    labelEl.hidden = key !== null;
    refreshWebgl();
    const group = key ? groups.get(key) : undefined;
    if (group && group.activeIndex >= 0) {
      group.shells[group.activeIndex]?.applyResize();
    }
  }

  function handleActiveTabChanged(event: Event): void {
    const detail = (event as CustomEvent<ActiveTabChangedDetail>).detail;
    if (!detail || detail.owner === null || detail.cwd === null || detail.tabId === null) {
      showGroup(null);
      return;
    }
    const key = groupKey(detail.owner);
    let group = groups.get(key);
    if (!group) {
      group = createGroup(key, detail.cwd);
    } else if (group.cwd !== detail.cwd) {
      // Le path d'un projet peut changer après coup : sans resync, les FUTURS `+` du groupe spawneraient dans l'ancien dossier (les onglets ouverts gardent leur cwd figé).
      group.cwd = detail.cwd;
    }
    showGroup(key);
  }

  function handleOwnerRemoved(event: Event): void {
    const detail = (event as CustomEvent<OwnerRemovedDetail>).detail;
    if (!detail || detail.kind !== "project") return;
    killGroup(groupKey({ kind: "project", id: detail.id }));
  }

  /** Un changement de thème peut changer police/taille, donc la grille
   * cols/rows de CHAQUE onglet de CHAQUE groupe — on repropage explicitement
   * au PTY via `applyResize` (le `ResizeObserver` ne se déclenche pas
   * forcément si les dimensions en pixels du viewport n'ont pas bougé). Un
   * onglet actuellement masqué est un no-op observable (garde dimensionnelle
   * dans `applyResize`), corrigé au prochain réaffichage. */
  function handleThemeChanged(): void {
    const style = buildTerminalStyle();
    for (const group of groups.values()) {
      for (const shell of group.shells) {
        shell.term.options.theme = style.theme;
        shell.term.options.fontFamily = style.fontFamily;
        shell.term.options.fontSize = style.fontSize;
        shell.applyResize();
      }
    }
  }

  // Gate police : les événements sont mis en file (ordre conservé) jusqu'à ce que la police mono soit chargée, pour que xterm mesure la bonne grille ; synchrone si document.fonts est absent.
  let fontsReady = false;
  const pendingEvents: Array<() => void> = [];
  function gated(handler: (event: Event) => void): (event: Event) => void {
    return (event) => {
      if (fontsReady) handler(event);
      else pendingEvents.push(() => handler(event));
    };
  }
  function openGate(): void {
    fontsReady = true;
    for (const run of pendingEvents.splice(0)) run();
  }
  const fontSet = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fontSet && typeof fontSet.load === "function") {
    const { fontSize, fontFamily } = buildTerminalStyle();
    let loading: Promise<unknown>;
    try {
      loading = fontSet.load(`${fontSize}px ${fontFamily}`);
    } catch {
      loading = Promise.resolve();
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, FONT_GATE_TIMEOUT_MS));
    void Promise.race([loading.catch(() => undefined), timeout]).then(openGate);
  } else {
    fontsReady = true;
  }

  window.addEventListener("den:active-tab-changed", gated(handleActiveTabChanged));
  window.addEventListener("den:owner-removed", gated(handleOwnerRemoved));
  document.addEventListener("den:theme-changed", handleThemeChanged);

  window.addEventListener("beforeunload", () => {
    document.removeEventListener("den:theme-changed", handleThemeChanged);
    for (const group of groups.values()) {
      for (const shell of group.shells) {
        shell.debouncedResize.cancel();
        shell.resizeObserver.disconnect();
        if (shell.ptyId !== undefined) {
          void invoke("pty_kill", { id: shell.ptyId });
        }
      }
    }
  });
}
