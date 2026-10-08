/** Arbre de rendu des mods (JSON du moteur claude) — forme mesurée sur src/mods/fixtures. */

/** Le moteur dessine l'original (`ref: 0` dans les captures). */
export interface EngineNode {
  type: "engine";
  ref: number;
}

export const SUPPORTED_ELEMENTS = [
  "Box",
  "Text",
  "Markdown",
  "Link",
  "Code",
  "Button",
  "Input",
  "Select",
] as const;

export type ElementType = (typeof SUPPORTED_ELEMENTS)[number];

export interface ElementNode {
  // string large : Svg, Image, Raster, Client et types inconnus restent représentables.
  type: string;
  props?: Record<string, unknown>;
  children?: RenderNode[];
  press?: { plugin: string; handle: number };
}

export type RenderNode = string | number | EngineNode | ElementNode;

export function isSupportedElement(type: string): type is ElementType {
  return (SUPPORTED_ELEMENTS as readonly string[]).includes(type);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isRenderNode(value: unknown): value is RenderNode {
  if (typeof value === "string" || typeof value === "number") return true;
  if (!isPlainObject(value) || typeof value.type !== "string") return false;
  if (value.type === "engine") return typeof value.ref === "number";
  if (value.props !== undefined && !isPlainObject(value.props)) return false;
  if (value.press !== undefined) {
    const p = value.press;
    if (
      !isPlainObject(p) ||
      typeof p.plugin !== "string" ||
      typeof p.handle !== "number"
    ) {
      return false;
    }
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return false;
    return value.children.every(isRenderNode);
  }
  return true;
}
