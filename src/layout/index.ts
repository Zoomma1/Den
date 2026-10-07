/**
 * Module `layout` — câblage DOM du layout de `#den-app` (DEN-04 A3) :
 * applique l'état persisté (`workspace.getState().layout`) à chaque
 * démarrage, gère les deux splitters redimensionnables (pointer events) et
 * le raccourci clavier de masquage de la sidebar. La math pure (clamp,
 * calcul de drag, mises à jour immuables) vit dans `./layout.ts`, testée
 * sans DOM.
 *
 * `#den-app` est aplati (`index.html`) : `#den-sidebar`, `#den-conversation`,
 * `#den-terminal`, `#den-status` sont des enfants directs, placés par
 * `grid-area` (`layout.css`). Les deux `<div role="separator">` créés ici
 * (`data-splitter="sidebar"` / `"panes"`) sont eux aussi placés par
 * `grid-area` (`sp1`/`sp2`) — leur ordre d'insertion dans le DOM n'a donc
 * aucune importance, rien à ajouter dans `index.html`.
 *
 * Source de vérité : le layout courant se lit toujours via
 * `workspace.getState().layout`, jamais depuis une variable module-level
 * qui pourrait diverger de l'état réellement persisté — y compris pendant
 * un drag (chaque `pointermove` relit `getState()` pour les champs qu'il ne
 * modifie pas lui-même, ex. `conversationRatio` pendant un drag de la
 * sidebar). Chaque geste pousse donc son résultat **immédiatement** en
 * mémoire (`setLayout`, synchrone) — seule l'écriture disque est différée.
 *
 * Persistance : mémoire et disque sont découplés (review A3). `setLayout`
 * met l'état à jour tout de suite ; les deux splitters débattent ensuite
 * l'écriture disque via `debounce(saveState, 300ms)` (réutilise
 * `src/terminal/debounce.ts`, même usage que le `pty_resize` du module
 * terminal) — un `pointermove` ne doit pas déclencher une écriture à chaque
 * pixel. Si le debounce ne mettait à jour la mémoire qu'à son tir, un second
 * geste (autre splitter, ⌘B) dans la fenêtre de 300 ms relirait un
 * layout périmé et annulerait le premier. Le relâchement du splitter
 * (`pointerup`/`pointercancel`) annule le debounce et écrit tout de suite
 * (`flushPersist`). Les raccourcis ⌘B/⌘J écrivent immédiatement : ce sont des
 * gestes discrets, pas un flux continu.
 *
 * Pas de re-montage : ce module ne touche à aucun DOM des autres modules
 * (`terminal`, `tabs`, `markdown`). Le `ResizeObserver` déjà posé par
 * `src/terminal/index.ts` suit les changements de taille de `#den-terminal`
 * qu'une nouvelle grille CSS provoque — rien à faire ici pour xterm.
 */
import { getState, saveState, setLayout } from "../workspace";
import type { LayoutState } from "../workspace/store";
import { debounce, type Debounced } from "../terminal/debounce";
import {
  applyLayout,
  ratioFromDrag,
  sidebarPxFromDrag,
  withSidebarHidden,
  withTerminalHidden,
  withSizes,
} from "./layout";
import "./layout.css";

const PERSIST_DEBOUNCE_MS = 300;

type SplitterKind = "sidebar" | "panes";

export function init(): void {
  const app = document.getElementById("den-app");
  if (!app) {
    throw new Error("Den: point de montage #den-app introuvable dans index.html");
  }

  applyLayout(app, getState().layout);

  const sidebarSplitter = createSplitter("sidebar", "Resize sidebar");
  const panesSplitter = createSplitter("panes", "Resize conversation and terminal panes");
  app.append(sidebarSplitter, panesSplitter);
  syncPanesOrientation(app, panesSplitter);

  // Écriture disque seule — l'état mémoire est déjà à jour (`setLayout`
  // appelé à chaque `pointermove`, cf. docstring de tête).
  const persist = debounce(() => {
    void saveState();
  }, PERSIST_DEBOUNCE_MS);

  wireSidebarDrag(app, sidebarSplitter, persist);
  wirePanesDrag(app, panesSplitter, persist);
  wirePaneShortcut(app, "b", (layout) => withSidebarHidden(layout, !layout.sidebarHidden));
  wirePaneShortcut(app, "j", (layout) => withTerminalHidden(layout, !layout.terminalHidden));
}

function createSplitter(kind: SplitterKind, ariaLabel: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "den-splitter";
  el.dataset.splitter = kind;
  el.setAttribute("role", "separator");
  el.setAttribute("aria-label", ariaLabel);
  // Le splitter sidebar est toujours une ligne verticale (dispo à gauche
  // dans les deux presets) — orientation fixe, contrairement au splitter
  // `panes` dont l'axe dépend du preset (cf. syncPanesOrientation).
  if (kind === "sidebar") {
    el.setAttribute("aria-orientation", "vertical");
  }
  return el;
}

/** `aria-orientation` du splitter `panes` suit le preset : ligne verticale
 * (dividende gauche/droite) en `side-by-side`, horizontale en `stacked`. */
function syncPanesOrientation(app: HTMLElement, panesSplitter: HTMLElement): void {
  panesSplitter.setAttribute(
    "aria-orientation",
    app.dataset.layout === "stacked" ? "horizontal" : "vertical",
  );
}

/** Démarre un drag pointer : capture le pointeur, pose `data-dragging` sur
 * `#den-app`, retire tout au `pointerup`/`pointercancel` puis appelle
 * `onEnd` (écriture immédiate, cf. `flushPersist`) — seulement si au moins
 * un `pointermove` a eu lieu : un simple clic sur le splitter ne change
 * rien et ne doit pas écrire. Un `pointerdown` pendant un drag déjà en cours
 * (second pointeur) est ignoré, sinon deux jeux de listeners s'empilent.
 * `onMove` reçoit l'événement pointer et fait tout le travail (calcul +
 * `setLayout` + `applyLayout` + `persist`) — factorisé ici car identique
 * entre les deux splitters. */
function startDrag(
  app: HTMLElement,
  el: HTMLElement,
  pointerId: number,
  onMove: (ev: PointerEvent) => void,
  onEnd: () => void,
): void {
  if (app.dataset.dragging !== undefined) return;
  el.setPointerCapture(pointerId);
  // Valeur = le splitter en cours (`sidebar` / `panes`) : `layout.css` ne
  // surligne que celui-là pendant le drag, pas les deux.
  app.dataset.dragging = el.dataset.splitter ?? "";

  let moved = false;
  const handleMove = (ev: PointerEvent): void => {
    moved = true;
    onMove(ev);
  };
  const stop = (ev: PointerEvent): void => {
    el.releasePointerCapture(ev.pointerId);
    delete app.dataset.dragging;
    el.removeEventListener("pointermove", handleMove);
    el.removeEventListener("pointerup", stop);
    el.removeEventListener("pointercancel", stop);
    if (moved) onEnd();
  };

  el.addEventListener("pointermove", handleMove);
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
}

/** Fin de drag : annule l'écriture débouncée encore en attente et écrit tout
 * de suite — l'état mémoire est déjà à jour (`setLayout` à chaque move).
 * Sans ça, fermer l'app dans les 300 ms après avoir relâché un splitter
 * perdait la dernière taille (mineur de la review A3). */
function flushPersist(persist: Debounced<[]>): void {
  persist.cancel();
  void saveState();
}

function wireSidebarDrag(app: HTMLElement, el: HTMLElement, persist: Debounced<[]>): void {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const preset = getState().layout.preset;
    const startPx = document.getElementById("den-sidebar")!.getBoundingClientRect().width;
    const startClientX = e.clientX;

    startDrag(app, el, e.pointerId, (ev) => {
      const newSidebarPx = sidebarPxFromDrag(startPx, ev.clientX - startClientX);
      const current = getState().layout;
      const next = withSizes(current, preset, { ...current.sizes[preset], sidebarPx: newSidebarPx });
      setLayout(next);
      applyLayout(app, next);
      persist();
    }, () => flushPersist(persist));
  });
}

function wirePanesDrag(app: HTMLElement, el: HTMLElement, persist: Debounced<[]>): void {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const preset = getState().layout.preset;
    const axisX = preset !== "stacked";
    const conversationRect = document.getElementById("den-conversation")!.getBoundingClientRect();
    const terminalRect = document.getElementById("den-terminal")!.getBoundingClientRect();
    const startPrimaryPx = axisX ? conversationRect.width : conversationRect.height;
    const totalPx = axisX
      ? conversationRect.width + terminalRect.width
      : conversationRect.height + terminalRect.height;
    const startClientPos = axisX ? e.clientX : e.clientY;

    startDrag(app, el, e.pointerId, (ev) => {
      const clientPos = axisX ? ev.clientX : ev.clientY;
      const newRatio = ratioFromDrag(startPrimaryPx, totalPx, clientPos - startClientPos);
      const current = getState().layout;
      const next = withSizes(current, preset, {
        ...current.sizes[preset],
        conversationRatio: newRatio,
      });
      setLayout(next);
      applyLayout(app, next);
      persist();
    }, () => flushPersist(persist));
  });
}

/** ⌘<key> sur macOS, Ctrl+<key> ailleurs — un seul modificateur par
 * plateforme, jamais les deux (`Ctrl+B` est le préfixe tmux dans le
 * terminal, `Ctrl+J` un LF brut). Écoute en capture sur `window` : la
 * capture donne l'ORDRE (avant xterm), pas l'exclusivité —
 * `stopPropagation` est ce qui empêche la frappe d'atteindre le
 * `<textarea>` de xterm (son `_keyDown` ne regarde jamais
 * `defaultPrevented` et enverrait le caractère de contrôle correspondant au
 * PTY). `preventDefault` + `stopPropagation` seulement quand le raccourci
 * matche vraiment. `event.repeat` ignoré : une touche maintenue ne doit
 * produire qu'un seul toggle (et une seule écriture), pas un clignotement à
 * la cadence de répétition de l'OS.
 *
 * Factorisé pour `⌘B`/`Ctrl+B` (sidebar) et `⌘J`/`Ctrl+J` (terminal, DEN-04
 * A4-1) : la doctrine ci-dessus ne doit être écrite qu'une fois. `toggle`
 * reçoit le `layout` courant et rend le nouvel état — `withSidebarHidden`/
 * `withTerminalHidden` appliqués à la négation de leur propre champ. */
function wirePaneShortcut(
  app: HTMLElement,
  key: string,
  toggle: (layout: LayoutState) => LayoutState,
): void {
  const isMac = /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);

  window.addEventListener(
    "keydown",
    (e) => {
      const modifierMatches = isMac ? e.metaKey : e.ctrlKey;
      if (!modifierMatches || e.key.toLowerCase() !== key) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;

      const next = toggle(getState().layout);
      setLayout(next);
      applyLayout(app, next);
      void saveState();
    },
    { capture: true },
  );
}
