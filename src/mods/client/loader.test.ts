import { describe, expect, it } from "vitest";
import type { ClientModuleBundle } from "../../types/protocol";
import { loadBundle, specifiersOf } from "./loader";

const bundleOf = (files: { key: string; source: string }[]): ClientModuleBundle => ({
  plugin: "p",
  hash: "h",
  modules: [],
  runtime: "claude:surface-runtime",
  limits: { nodes: 1, depth: 1, chars: 1, values: 1, dataDepth: 1 },
  files,
});

function recorder() {
  const created: { url: string; source: string }[] = [];
  return {
    created,
    create: (source: string) => {
      const url = `blob:fake/${created.length}`;
      created.push({ url, source });
      return url;
    },
  };
}

describe("loadBundle", () => {
  it("crée les dépendances d'abord et réécrit les clés par leurs URL", () => {
    const r = recorder();
    const urls = loadBundle(
      bundleOf([
        { key: "surface:///a.js", source: "import { h } from 'claude:surface-runtime'\nimport b from \"surface:///b.js\"\nexport default 1" },
        { key: "surface:///b.js", source: "export * from 'claude:hooks-types'\nconst x = import('claude:surface-runtime')" },
        { key: "claude:surface-runtime", source: "export const h = 1" },
        { key: "claude:hooks-types", source: "export const t = 1" },
      ]),
      r.create,
    );
    expect(Object.keys(urls)).toHaveLength(4);
    const order = r.created.map((c) => c.source.slice(0, 12));
    expect(order.indexOf("export const")).toBeLessThan(order.indexOf("import { h }"));
    expect(r.created.find((c) => c.source.startsWith("import { h }"))!.source).toBe(
      `import { h } from '${urls["claude:surface-runtime"]}'\nimport b from "${urls["surface:///b.js"]}"\nexport default 1`,
    );
    expect(r.created.find((c) => c.source.startsWith("export *"))!.source).toBe(
      `export * from '${urls["claude:hooks-types"]}'\nconst x = import('${urls["claude:surface-runtime"]}')`,
    );
  });

  it("laisse intacts les fichiers sans import", () => {
    const r = recorder();
    loadBundle(bundleOf([{ key: "claude:surface-runtime", source: "export const h = 1" }]), r.create);
    expect(r.created[0].source).toBe("export const h = 1");
  });

  it("refuse un cycle", () => {
    expect(() =>
      loadBundle(
        bundleOf([
          { key: "surface:///a.js", source: "import 'surface:///b.js'" },
          { key: "surface:///b.js", source: "import 'surface:///a.js'" },
        ]),
        recorder().create,
      ),
    ).toThrow(/cycle d'imports/);
  });

  it("refuse un import non résolu ou absent du bundle", () => {
    expect(() =>
      loadBundle(bundleOf([{ key: "surface:///a.js", source: "import x from 'surface-unlinked:///x.js'" }]), recorder().create),
    ).toThrow(/non résolu/);
    expect(() =>
      loadBundle(bundleOf([{ key: "surface:///a.js", source: "import x from 'surface:///manquant.js'" }]), recorder().create),
    ).toThrow(/absent du bundle/);
  });

  it("applique les plafonds", () => {
    const r = recorder();
    expect(() => loadBundle(bundleOf([{ key: "a", source: "x".repeat(1024 * 1024 + 1) }]), r.create)).toThrow(/1 Mio/);
    const big = "x".repeat(1024 * 1024);
    const nine = Array.from({ length: 9 }, (_, i) => ({ key: `f${i}`, source: big }));
    expect(() => loadBundle(bundleOf(nine), r.create)).toThrow(/8 Mio/);
    const many = Array.from({ length: 513 }, (_, i) => ({ key: `f${i}`, source: "" }));
    expect(() => loadBundle(bundleOf(many), r.create)).toThrow(/513 fichiers/);
    expect(r.created).toHaveLength(0);
  });

  it("balayage linéaire : une source pathologique 4× plus grande coûte ~4× (jamais ~16×), quelle que soit la machine", () => {
    const run = (repeats: number) => {
      const src = "import ".repeat(repeats) + "export from ".repeat(Math.floor((repeats * 4) / 7));
      const t0 = performance.now();
      specifiersOf(src);
      return performance.now() - t0;
    };
    const best = (repeats: number) => Math.min(run(repeats), run(repeats), run(repeats));
    run(20_000); // chauffe du JIT
    const small = best(140_000); // ~1 Mio
    const large = best(560_000); // ~4 Mio
    // Linéaire ≈ 4× ; quadratique ≥ 16× ; la marge absorbe le bruit d'une machine chargée.
    expect(large / Math.max(small, 2)).toBeLessThan(10);
  });

  it("un spécificateur nommé constructor ou __proto__ ne casse rien", () => {
    const r = recorder();
    const urls = loadBundle(
      bundleOf([
        { key: "surface:///a.js", source: "import 'constructor'\nimport '__proto__'\nimport x from 'surface:///b.js'" },
        { key: "surface:///b.js", source: "export const b = 1" },
      ]),
      r.create,
    );
    expect(r.created.find((c) => c.source.startsWith("import 'constructor'"))!.source).toBe(
      `import 'constructor'\nimport '__proto__'\nimport x from '${urls["surface:///b.js"]}'`,
    );
  });

  it("révoque les URL déjà créées si une exception survient en cours de route", () => {
    const r = recorder();
    const revoked: string[] = [];
    expect(() =>
      loadBundle(
        bundleOf([
          { key: "claude:surface-runtime", source: "export const h = 1" },
          { key: "surface:///a.js", source: "import 'surface-unlinked:///x'" },
        ]),
        r.create,
        (u) => revoked.push(u),
      ),
    ).toThrow(/non résolu/);
    expect(revoked).toEqual(["blob:fake/0"]);
  });
});
