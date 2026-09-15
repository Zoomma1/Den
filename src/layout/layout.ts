/**
 * Module `layout/layout` — pur (aucun import DOM global type `document`, ni
 * Tauri) : pose l'état de layout (`LayoutState`, cf. `workspace/store.ts`)
 * sur un élément `HTMLElement` reçu en paramètre, et fournit la math du
 * drag des deux splitters. Testable en `happy-dom` sans mock — c'est
 * `src/layout/index.ts` qui fait le pont avec `#den-app`, `workspace` et les
 * événements pointer.
 *
 * Deux presets : `side-by-side` (actuel — sidebar | conversation | terminal)
 * et `stacked` (sidebar | conversation au-dessus du terminal). `applyLayout`
 * pose `data-layout`, `data-sidebar` et les custom properties CSS que
 * `layout.css` consomme dans ses `grid-template-columns`/`-rows` — voir ce
 * fichier pour le détail des deux grilles.
 *
 * Écart à la lettre du ticket, assumé (cf. plan DEN-04 A3) : le modèle
 * persisté garde `conversationRatio` (un seul ratio, `LayoutSizes`), mais
 * `calc()` ne sait pas multiplier une unité `fr` — le ratio est donc projeté
 * à l'application en **deux** custom properties `fr`
 * (`--den-conversation-fr` / `--den-terminal-fr`, qui somment à `1fr`),
 * jamais persistées telles quelles.
 *
 * Clamp à l'application (`applyLayout`), pas à la persistance : un
 * `state.json` édité à la main avec `sidebarPx: 0` ou `conversationRatio: 0`
 * ne doit jamais pouvoir écraser un pane à l'affichage (cf. grill A2, "vue
 * cible" DEN-04 §7).
 */

import type { LayoutPreset, LayoutSizes, LayoutState } from "../workspace/store";

/** Largeur de la sidebar, en pixels — bornes de confort (assez pour un nom
 * de projet lisible, jamais toute la fenêtre). */
export const MIN_SIDEBAR_PX = 160;
export const MAX_SIDEBAR_PX = 640;

/** Ratio conversation/terminal — jamais 0 ni 1 : chaque pane garde toujours
 * une portion visible, même si `state.json` est édité à la main. */
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampSidebarPx(px: number): number {
  return clamp(px, MIN_SIDEBAR_PX, MAX_SIDEBAR_PX);
}

export function clampRatio(ratio: number): number {
  return clamp(ratio, MIN_RATIO, MAX_RATIO);
}

/**
 * Pose sur `app` (`#den-app`) l'attribut `data-layout` (preset courant),
 * `data-sidebar="hidden"` (retiré quand la sidebar est visible) et les
 * custom properties CSS consommées par `layout.css` :
 * - `--den-sidebar-px` : largeur de la sidebar du preset courant, clampée.
 * - `--den-conversation-fr` / `--den-terminal-fr` : le `conversationRatio`
 *   du preset courant, clampé puis projeté en deux `fr` complémentaires.
 *
 * Idempotent — rejouable à chaque changement de preset, taille ou visibilité
 * de la sidebar sans état caché ailleurs que dans `layout` lui-même.
 */
export function applyLayout(app: HTMLElement, layout: LayoutState): void {
  const sizes = layout.sizes[layout.preset];
  const sidebarPx = clampSidebarPx(sizes.sidebarPx);
  const ratio = clampRatio(sizes.conversationRatio);

  app.dataset.layout = layout.preset;
  if (layout.sidebarHidden) {
    app.dataset.sidebar = "hidden";
  } else {
    delete app.dataset.sidebar;
  }

  app.style.setProperty("--den-sidebar-px", `${sidebarPx}px`);
  app.style.setProperty("--den-conversation-fr", `${roundFr(ratio)}fr`);
  // `1 - ratio` en flottant JS (ex. 1 - 0.7 = 0.30000000000000004) donnerait
  // une custom property illisible dans le devtools — arrondi à 4 décimales.
  app.style.setProperty("--den-terminal-fr", `${roundFr(1 - ratio)}fr`);
}

function roundFr(value: number): number {
  return Number(value.toFixed(4));
}

/** Nouvelle largeur de sidebar pendant un drag : `startPx` = largeur au
 * `pointerdown`, `delta` = déplacement du pointeur depuis lors (en pixels,
 * signe selon l'axe) — arrondie au pixel entier puis clampée. Arrondi (grill
 * A3) : `getBoundingClientRect` rend des sous-pixels (`259.93359375`) qui
 * finissaient tels quels dans `state.json`, censé rester lisible à la main. */
export function sidebarPxFromDrag(startPx: number, delta: number): number {
  return clampSidebarPx(Math.round(startPx + delta));
}

/** Nouveau ratio conversation/terminal pendant un drag du splitter `panes` :
 * `startPrimaryPx` = taille du pane conversation au `pointerdown`,
 * `totalPx` = largeur (ou hauteur, en `stacked`) totale des deux panes +
 * splitter à ce moment, `delta` = déplacement du pointeur depuis lors —
 * arrondi à 3 décimales (même motif de lisibilité que `sidebarPxFromDrag` —
 * au millième, l'écart est sous le pixel sur n'importe quel écran) puis
 * clampé. `totalPx` figé au `pointerdown` : un ratio doit rester stable
 * même si `#den-app` change de taille en cours de drag. */
export function ratioFromDrag(startPrimaryPx: number, totalPx: number, delta: number): number {
  if (totalPx <= 0) return clampRatio(0.5);
  return clampRatio(Number(((startPrimaryPx + delta) / totalPx).toFixed(3)));
}

/** Nouvel état avec `preset` changé — les tailles de l'autre preset ne sont
 * pas touchées (`sizes[preset]` restauré tel quel au preset précédent si on
 * y revient). Immuable. */
export function withPreset(layout: LayoutState, preset: LayoutPreset): LayoutState {
  return { ...layout, preset };
}

/** Nouvel état avec les tailles du preset `preset` remplacées par `sizes` —
 * les autres presets ne sont pas touchés. Immuable. */
export function withSizes(layout: LayoutState, preset: LayoutPreset, sizes: LayoutSizes): LayoutState {
  return { ...layout, sizes: { ...layout.sizes, [preset]: sizes } };
}

/** Nouvel état avec `sidebarHidden` remplacé. Immuable. */
export function withSidebarHidden(layout: LayoutState, hidden: boolean): LayoutState {
  return { ...layout, sidebarHidden: hidden };
}
