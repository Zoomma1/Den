import type {
  ClientAddress,
  ClientModuleBundle,
  ModClientPress,
  ModComponent,
  ModPanes,
} from "../types/protocol";
import type { ElementNode, RenderNode } from "./tree";

/** Origine d'un rendu (équivalent de ModOrigin de conversationView.ts) ; fournie par le pane host et la bande. */
export interface ModOrigin {
  component: ModComponent;
  instanceId: string;
}

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
  /** Fourni par l'intégration (index.ts), consommé par render.ts pour {type:"Client"} ; absent = repli « non supporté ». */
  renderClient?(node: ElementNode): HTMLElement;
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

/** Implémenté par l'intégration (src/mods/index.ts), consommé par l'hôte Client. */
export interface ClientBridge {
  loadModule(tabId: string, plugin: string): Promise<ClientModuleBundle>;
  press(
    tabId: string,
    address: ClientAddress,
    element: string,
    event: ModClientPress["event"],
  ): Promise<{ handled: boolean; reached?: unknown; error?: string }>;
  message(
    tabId: string,
    address: ClientAddress,
    data: unknown,
  ): Promise<{ handled: boolean; props?: unknown; error?: string }>;
  fault(
    tabId: string,
    address: ClientAddress,
    phase: "load" | "render" | "run",
    reason: string,
  ): Promise<void>;
}

/** Implémenté par l'intégration (src/mods/index.ts), consommé par le pane host et l'hôte Client. */
export interface ModClient extends ModPaneClient, ClientBridge {}

/** Implémenté par l'hôte Client (src/mods/client/host.ts), consommé par l'intégration. */
export type CreateClientHost = (deps: {
  bridge: ClientBridge;
  clientModules?: () => Record<string, string>;
}) => {
  renderClient(tabId: string, origin: ModOrigin, node: ElementNode): HTMLElement;
  dispose(): void;
};

/** Miroir camelCase de `ModPanes` sans `type` ; produit par l'intégration, consommé par le pane host. */
export type PaneRoster = Omit<ModPanes, "type">;

/** Implémenté par le lot "colonne pane" (src/mods/pane.ts), consommé par l'intégration. */
export type CreatePaneHost = (deps: {
  mount: HTMLElement;
  client: ModPaneClient;
  renderTree: RenderTreeFn;
  options?: (tabId: string, origin?: ModOrigin) => RenderOptions;
}) => { dispose(): void };

/** Implémenté par le lot "bande" (src/mods/band.ts), consommé par l'intégration. */
export type CreateAboveBand = (deps: {
  client: ModRenderClient;
  renderTree: RenderTreeFn;
  options?: (tabId: string, origin?: ModOrigin) => RenderOptions;
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
