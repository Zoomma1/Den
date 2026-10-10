// @vitest-environment happy-dom
//
// `applyLayout` lit/écrit `HTMLElement.style` et `.dataset` — cf.
// `../tabs/sidebar.test.ts` pour la même annotation par-fichier.
import { describe, it, expect } from "vitest";
import {
  applyLayout,
  clampRatio,
  clampRightPx,
  clampSidebarPx,
  DEFAULT_RIGHT_PX,
  MAX_RIGHT_PX,
  MIN_RIGHT_PX,
  rightPxFromDrag,
  withRightPaneHidden,
  withRightPx,
  MAX_RATIO,
  MAX_SIDEBAR_PX,
  MIN_RATIO,
  MIN_SIDEBAR_PX,
  ratioFromDrag,
  sidebarPxFromDrag,
  withPreset,
  withSidebarHidden,
  withTerminalHidden,
  withSizes,
} from "./layout";
import { defaultState, type LayoutState } from "../workspace/store";

function makeLayout(overrides: Partial<LayoutState> = {}): LayoutState {
  return { ...defaultState().layout, ...overrides };
}

describe("applyLayout", () => {
  it("pose data-layout et les custom properties depuis le preset courant", () => {
    const app = document.createElement("div");
    applyLayout(
      app,
      makeLayout({
        preset: "stacked",
        sizes: {
          "side-by-side": { sidebarPx: 240, conversationRatio: 0.6 },
          stacked: { sidebarPx: 300, conversationRatio: 0.7 },
        },
      }),
    );

    expect(app.dataset.layout).toBe("stacked");
    expect(app.style.getPropertyValue("--den-sidebar-px")).toBe("300px");
    expect(app.style.getPropertyValue("--den-conversation-fr")).toBe("0.7fr");
    expect(app.style.getPropertyValue("--den-terminal-fr")).toBe("0.3fr");
  });

  it("pose data-sidebar=hidden quand sidebarHidden est vrai, absent sinon", () => {
    const app = document.createElement("div");
    applyLayout(app, makeLayout({ sidebarHidden: true }));
    expect(app.dataset.sidebar).toBe("hidden");

    applyLayout(app, makeLayout({ sidebarHidden: false }));
    expect(app.dataset.sidebar).toBeUndefined();
  });

  it("pose data-terminal=hidden quand terminalHidden est vrai, absent sinon", () => {
    const app = document.createElement("div");
    applyLayout(app, makeLayout({ terminalHidden: true }));
    expect(app.dataset.terminal).toBe("hidden");

    applyLayout(app, makeLayout({ terminalHidden: false }));
    expect(app.dataset.terminal).toBeUndefined();
  });

  it("clamp sidebarPx et conversationRatio hors bornes à l'application", () => {
    const app = document.createElement("div");
    applyLayout(
      app,
      makeLayout({
        preset: "side-by-side",
        sizes: {
          "side-by-side": { sidebarPx: 0, conversationRatio: 0 },
          stacked: { sidebarPx: 240, conversationRatio: 0.6 },
        },
      }),
    );

    expect(app.style.getPropertyValue("--den-sidebar-px")).toBe(`${MIN_SIDEBAR_PX}px`);
    expect(app.style.getPropertyValue("--den-conversation-fr")).toBe(`${MIN_RATIO}fr`);
    expect(app.style.getPropertyValue("--den-terminal-fr")).toBe(`${1 - MIN_RATIO}fr`);
  });

  it("clamp sidebarPx et conversationRatio au plafond", () => {
    const app = document.createElement("div");
    applyLayout(
      app,
      makeLayout({
        preset: "side-by-side",
        sizes: {
          "side-by-side": { sidebarPx: 9999, conversationRatio: 1 },
          stacked: { sidebarPx: 240, conversationRatio: 0.6 },
        },
      }),
    );

    expect(app.style.getPropertyValue("--den-sidebar-px")).toBe(`${MAX_SIDEBAR_PX}px`);
    expect(app.style.getPropertyValue("--den-conversation-fr")).toBe(`${MAX_RATIO}fr`);
  });
});

describe("clampSidebarPx / clampRatio", () => {
  it("laisse passer une valeur déjà dans les bornes", () => {
    expect(clampSidebarPx(300)).toBe(300);
    expect(clampRatio(0.5)).toBe(0.5);
  });

  it("clamp en-dessous et au-dessus des bornes", () => {
    expect(clampSidebarPx(-100)).toBe(MIN_SIDEBAR_PX);
    expect(clampSidebarPx(10_000)).toBe(MAX_SIDEBAR_PX);
    expect(clampRatio(-1)).toBe(MIN_RATIO);
    expect(clampRatio(2)).toBe(MAX_RATIO);
  });
});

describe("sidebarPxFromDrag", () => {
  it("ajoute le delta à la largeur de départ", () => {
    expect(sidebarPxFromDrag(240, 40)).toBe(280);
    expect(sidebarPxFromDrag(240, -40)).toBe(200);
  });

  it("clampe le résultat", () => {
    expect(sidebarPxFromDrag(240, -1000)).toBe(MIN_SIDEBAR_PX);
    expect(sidebarPxFromDrag(240, 1000)).toBe(MAX_SIDEBAR_PX);
  });

  it("arrondit au pixel entier (sous-pixels de getBoundingClientRect)", () => {
    expect(sidebarPxFromDrag(259.93359375, 0.3)).toBe(260);
    expect(sidebarPxFromDrag(240.4, 0)).toBe(240);
  });
});

describe("ratioFromDrag", () => {
  it("calcule le nouveau ratio depuis la taille du pane primaire et le total", () => {
    // primaire 600px sur un total de 1000px -> ratio 0.6, +100px -> 0.7
    expect(ratioFromDrag(600, 1000, 100)).toBeCloseTo(0.7);
    expect(ratioFromDrag(600, 1000, -100)).toBeCloseTo(0.5);
  });

  it("clampe le résultat", () => {
    expect(ratioFromDrag(600, 1000, -1000)).toBe(MIN_RATIO);
    expect(ratioFromDrag(600, 1000, 1000)).toBe(MAX_RATIO);
  });

  it("arrondit à 3 décimales", () => {
    expect(ratioFromDrag(600, 1000, 33.3333)).toBe(0.633);
    expect(ratioFromDrag(771.6517857, 1000, 0)).toBe(0.772);
  });

  it("replie sur 0.5 (clampé) si le total est nul ou négatif", () => {
    expect(ratioFromDrag(600, 0, 100)).toBe(0.5);
    expect(ratioFromDrag(600, -10, 100)).toBe(0.5);
  });
});

describe("with* — immuabilité", () => {
  it("withPreset change le preset sans toucher aux sizes ni à l'objet d'origine", () => {
    const layout = makeLayout({ preset: "side-by-side" });
    const next = withPreset(layout, "stacked");

    expect(next.preset).toBe("stacked");
    expect(next.sizes).toBe(layout.sizes);
    expect(layout.preset).toBe("side-by-side");
    expect(next).not.toBe(layout);
  });

  it("withSizes remplace les tailles d'un seul preset, laisse l'autre intact", () => {
    const layout = makeLayout();
    const nextSizes = { sidebarPx: 320, conversationRatio: 0.4 };
    const next = withSizes(layout, "stacked", nextSizes);

    expect(next.sizes.stacked).toEqual(nextSizes);
    expect(next.sizes["side-by-side"]).toBe(layout.sizes["side-by-side"]);
    expect(layout.sizes.stacked).not.toEqual(nextSizes);
    expect(next).not.toBe(layout);
  });

  it("withSidebarHidden remplace le booléen sans mutation", () => {
    const layout = makeLayout({ sidebarHidden: false });
    const next = withSidebarHidden(layout, true);

    expect(next.sidebarHidden).toBe(true);
    expect(layout.sidebarHidden).toBe(false);
    expect(next).not.toBe(layout);
  });

  it("withTerminalHidden remplace le booléen sans mutation", () => {
    const layout = makeLayout({ terminalHidden: false });
    const next = withTerminalHidden(layout, true);

    expect(next.terminalHidden).toBe(true);
    expect(layout.terminalHidden).toBe(false);
    expect(next).not.toBe(layout);
  });
});

describe("colonne pane", () => {
  it("masquée par défaut : data-pane=hidden et --den-right-px à 320px", () => {
    const app = document.createElement("div");
    applyLayout(app, makeLayout());
    expect(app.dataset.pane).toBe("hidden");
    expect(app.style.getPropertyValue("--den-right-px")).toBe(`${DEFAULT_RIGHT_PX}px`);
  });

  it("un ancien état sans les nouveaux champs reste masqué avec la largeur par défaut", () => {
    const layout = makeLayout();
    delete layout.rightPaneHidden;
    delete layout.rightPx;
    const app = document.createElement("div");
    applyLayout(app, layout);
    expect(app.dataset.pane).toBe("hidden");
    expect(app.style.getPropertyValue("--den-right-px")).toBe("320px");
  });

  it("retire data-pane quand la colonne est visible", () => {
    const app = document.createElement("div");
    applyLayout(app, makeLayout({ rightPaneHidden: false, rightPx: 400 }));
    expect(app.dataset.pane).toBeUndefined();
    expect(app.style.getPropertyValue("--den-right-px")).toBe("400px");
  });

  it("clamp rightPx à l'application", () => {
    const app = document.createElement("div");
    applyLayout(app, makeLayout({ rightPx: 0 }));
    expect(app.style.getPropertyValue("--den-right-px")).toBe(`${MIN_RIGHT_PX}px`);
    applyLayout(app, makeLayout({ rightPx: 9999 }));
    expect(app.style.getPropertyValue("--den-right-px")).toBe(`${MAX_RIGHT_PX}px`);
    expect(clampRightPx(300)).toBe(300);
  });

  it("with* helpers sont immuables", () => {
    const layout = makeLayout();
    expect(withRightPaneHidden(layout, false).rightPaneHidden).toBe(false);
    expect(withRightPx(layout, 9999).rightPx).toBe(MAX_RIGHT_PX);
    expect(layout.rightPaneHidden).toBe(true);
    expect(layout.rightPx).toBeUndefined();
  });

  it("rightPxFromDrag : tirer vers la gauche élargit, arrondi et clampé", () => {
    expect(rightPxFromDrag(320, -50.4)).toBe(370);
    expect(rightPxFromDrag(320, 1000)).toBe(MIN_RIGHT_PX);
    expect(rightPxFromDrag(320, -1000)).toBe(MAX_RIGHT_PX);
  });
});
