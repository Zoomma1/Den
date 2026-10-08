import type { ModComponent } from "../types/protocol";
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
