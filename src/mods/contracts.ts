import type { ModComponent, ModPanes } from "../types/protocol";
import type { RenderNode } from "./tree";

type Press = { plugin: string; handle: number };

/** Callbacks passés par l'intégration (index.ts) au rendu (render.ts). */
export interface RenderOptions {
  onPress?(press: Press, key?: string, href?: string): void;
  onInput?(
    press: Press,
    kind: "change" | "submit",
    value: string,
    key?: string,
  ): void;
  onSelect?(press: Press, value: string, key?: string): void;
  renderEngineDefault?(ref: number): Node | null;
  onUnsupported?(elementType: string): void;
  openTerminal?(): void;
}

/** Implémenté par le lot "rendu" (src/mods/render.ts), consommé par l'intégration. */
export type RenderTreeFn = (
  node: RenderNode,
  opts?: RenderOptions,
) => HTMLElement;

/** Implémenté par le lot "intégration" (src/mods/index.ts), consommé par l'UI conversation. */
export interface ModRenderClient {
  requestRender(
    tabId: string,
    req: {
      component: ModComponent;
      instanceId: string;
      props: Record<string, unknown>;
    },
  ): Promise<{ tree: RenderNode | null; hooked: boolean; rewritten: boolean }>;
}

/** Implémenté par le lot "intégration" (src/mods/index.ts), consommé par le pane host. */
export interface ModPaneClient extends ModRenderClient {
  paneAction(
    tabId: string,
    req: { action: "show" | "focus" | "close" | "roster"; id?: string | null },
  ): Promise<{ handled: boolean; value?: string; error?: string }>;
}

/** Miroir camelCase de `ModPanes` sans `type` ; produit par l'intégration, consommé par le pane host. */
export type PaneRoster = Omit<ModPanes, "type">;

/** Implémenté par le lot "colonne pane" (src/mods/pane.ts), consommé par l'intégration. */
export type CreatePaneHost = (deps: {
  mount: HTMLElement;
  client: ModPaneClient;
  renderTree: RenderTreeFn;
  options?: (tabId: string) => RenderOptions;
}) => { dispose(): void };

/** Implémenté par le lot "bande" (src/mods/band.ts), consommé par l'intégration. */
export type CreateAboveBand = (deps: {
  client: ModRenderClient;
  renderTree: RenderTreeFn;
  options?: (tabId: string) => RenderOptions;
}) => { dispose(): void };

/** Implémenté par le lot "terminal" (src/terminal/index.ts), injecté dans createModsModule. */
export type OpenClaudeShell = (target: {
  owner: string | null;
  cwd: string | null;
}) => Promise<void>;

/** Événements window émis par l'intégration ; `den:active-tab-changed` existe déjà côté src/tabs/index.ts. */
export const MOD_EVENTS = {
  panes: "den:mod-panes",
  invalidate: "den:mod-invalidate",
} as const;

export type ModPanesEventDetail = { tabId: string } & PaneRoster;

export interface ModInvalidateEventDetail {
  tabId: string;
  instances: { component: string; instanceId: string }[];
}
