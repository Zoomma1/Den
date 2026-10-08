import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRenderNode, isSupportedElement, SUPPORTED_ELEMENTS } from "./tree";

function treesOf(file: string): unknown[] {
  const path = new URL(`./fixtures/${file}`, import.meta.url);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l)?.response?.response?.tree)
    .filter((t) => t !== undefined && t !== null);
}

describe("isRenderNode sur les captures réelles", () => {
  it.each(["responses-render.ndjson", "responses-pane-handoff.ndjson"])(
    "tous les arbres de %s sont valides",
    (file) => {
      const trees = treesOf(file);
      expect(trees.length).toBeGreaterThan(0);
      for (const tree of trees) expect(isRenderNode(tree)).toBe(true);
    },
  );

  it("rejette les formes invalides", () => {
    expect(isRenderNode(null)).toBe(false);
    expect(isRenderNode({})).toBe(false);
    expect(isRenderNode({ type: "engine" })).toBe(false);
    expect(isRenderNode({ type: "Box", children: "x" })).toBe(false);
    expect(isRenderNode({ type: "Box", children: [{ nope: 1 }] })).toBe(false);
    expect(isRenderNode({ type: "Button", press: { plugin: "p" } })).toBe(false);
  });

  it("représente les types non supportés", () => {
    expect(isRenderNode({ type: "Svg", props: { a: 1 } })).toBe(true);
  });
});

describe("isSupportedElement", () => {
  it("accepte la liste supportée et rejette le reste", () => {
    for (const t of SUPPORTED_ELEMENTS) expect(isSupportedElement(t)).toBe(true);
    for (const t of ["Svg", "Image", "Raster", "Client", "Inconnu", "box"]) {
      expect(isSupportedElement(t)).toBe(false);
    }
  });
});
