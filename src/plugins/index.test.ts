// @vitest-environment happy-dom
//
// Nécessite un DOM (document.createElement, appendChild) — le
// vitest.config.ts racine tourne en environment "node". happy-dom est
// installé en devDependency non persistée (`npm install --no-save
// happy-dom`, cf. notes de lot) et activé ici via l'annotation par-fichier
// pour ne pas toucher au vitest.config.ts partagé (hors périmètre du lot).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DenContext, DenMounts } from "../core/registry";
import type { DenPlugin, PluginContext } from "./api";
import { buildPluginContext, mountPlugins, type PluginModule } from "./index";

function makeMounts(): DenMounts {
  return {
    sidebar: document.createElement("aside"),
    conversation: document.createElement("section"),
    terminal: document.createElement("section"),
    status: document.createElement("footer"),
  };
}

function makeCtx(): { ctx: DenContext; mounts: DenMounts } {
  const mounts = makeMounts();
  return { ctx: { mounts }, mounts };
}

describe("buildPluginContext", () => {
  it("expose une statusBar qui ajoute des éléments dans #den-status", () => {
    const { ctx, mounts } = makeCtx();
    const pluginCtx = buildPluginContext(ctx);

    const el = document.createElement("span");
    el.textContent = "test";
    pluginCtx.statusBar.addItem(el);

    expect(mounts.status.contains(el)).toBe(true);
  });

  it("expose les mounts du DenContext", () => {
    const { ctx, mounts } = makeCtx();
    const pluginCtx = buildPluginContext(ctx);

    expect(pluginCtx.mounts).toBe(mounts);
  });
});

describe("mountPlugins", () => {
  let ctx: PluginContext;
  let statusEl: HTMLElement;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const built = makeCtx();
    ctx = buildPluginContext(built.ctx);
    statusEl = built.mounts.status;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("appelle onMount pour un plugin enregistré via l'API et lui passe le contexte", () => {
    const onMount = vi.fn((pluginCtx: PluginContext) => {
      const el = document.createElement("span");
      el.textContent = "hello";
      pluginCtx.statusBar.addItem(el);
    });
    const plugin: DenPlugin = { name: "test-plugin", onMount };
    const modules: Record<string, PluginModule> = {
      "/plugins/test-plugin/index.ts": { default: plugin },
    };

    mountPlugins(modules, ctx);

    expect(onMount).toHaveBeenCalledWith(ctx);
    expect(statusEl.textContent).toContain("hello");
  });

  it("isole l'erreur d'un plugin cassé : les autres plugins sont montés malgré tout", () => {
    const brokenPlugin: DenPlugin = {
      name: "broken-plugin",
      onMount: () => {
        throw new Error("boom");
      },
    };
    const workingOnMount = vi.fn();
    const workingPlugin: DenPlugin = {
      name: "working-plugin",
      onMount: workingOnMount,
    };
    const modules: Record<string, PluginModule> = {
      "/plugins/broken-plugin/index.ts": { default: brokenPlugin },
      "/plugins/working-plugin/index.ts": { default: workingPlugin },
    };

    expect(() => mountPlugins(modules, ctx)).not.toThrow();

    expect(workingOnMount).toHaveBeenCalledWith(ctx);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("broken-plugin"),
      expect.any(Error),
    );
  });

  it("ignore sans planter un module sans export par défaut", () => {
    const modules: Record<string, PluginModule> = {
      "/plugins/empty-module/index.ts": {},
    };

    expect(() => mountPlugins(modules, ctx)).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty-module"),
    );
  });
});

describe("intégration : plugin hello-world réel", () => {
  it("ajoute son badge visible dans #den-status via init()", async () => {
    const { init } = await import("./index");
    const { ctx, mounts } = makeCtx();

    init(ctx);

    expect(mounts.status.textContent).toContain("hello from plugin");
    expect(mounts.status.querySelector(".den-plugin-badge")).not.toBeNull();
  });
});
