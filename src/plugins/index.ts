/**
 * Module `plugins` — loader du plugin system (ADR-002).
 *
 * Découvre les plugins du dossier racine `plugins/` via `import.meta.glob`
 * de Vite (chargement EAGER, résolu à la compilation — pas de dynamic
 * import), construit le `PluginContext` (cf. `api.ts`) et appelle
 * `onMount` pour chacun d'eux. Les erreurs d'un plugin sont isolées
 * (try/catch + `console.error`) : un plugin cassé n'empêche ni les autres
 * plugins ni le reste de l'app de démarrer.
 *
 * Limite assumée (MVP, cf. `api.ts`) : uniquement les plugins présents
 * dans `plugins/` au moment du build — le chargement runtime d'un plugin
 * externe non compilé avec Den est reporté post-MVP.
 */
import type { DenContext } from "../core/registry";
import type { DenPlugin, PluginContext } from "./api";

/** Forme d'un module `plugins/<nom>/index.ts` : un `DenPlugin` en export par défaut. */
export interface PluginModule {
  default?: DenPlugin;
}

/**
 * Modules découverts au build par Vite — glob statique résolu à la
 * compilation (`eager: true` : les modules sont importés immédiatement,
 * pas via des imports dynamiques paresseux).
 */
const modules = import.meta.glob<PluginModule>("/plugins/*/index.ts", {
  eager: true,
});

/** Construit le `PluginContext` minimal à partir du `DenContext` interne. */
export function buildPluginContext(ctx: DenContext): PluginContext {
  const statusEl = ctx.mounts.status;
  return {
    statusBar: {
      addItem(el: HTMLElement): void {
        statusEl.appendChild(el);
      },
    },
    mounts: ctx.mounts,
  };
}

/**
 * Monte chaque plugin découvert dans `modules` sur `ctx`.
 *
 * Extrait de `init` pour être testable indépendamment de la résolution du
 * glob par Vite (les tests passent des modules synthétiques). Une erreur
 * dans un plugin — export par défaut manquant ou exception dans
 * `onMount` — est loguée et isolée, sans interrompre le montage des
 * plugins suivants.
 */
export function mountPlugins(
  modules: Record<string, PluginModule>,
  ctx: PluginContext,
): void {
  for (const [path, mod] of Object.entries(modules)) {
    const plugin = mod.default;
    if (!plugin) {
      console.error(`Den: plugin sans export par défaut ignoré (${path})`);
      continue;
    }
    try {
      plugin.onMount(ctx);
    } catch (err) {
      console.error(
        `Den: erreur dans le plugin "${plugin.name}" (${path})`,
        err,
      );
    }
  }
}

export function init(ctx: DenContext): void {
  const pluginCtx = buildPluginContext(ctx);
  mountPlugins(modules, pluginCtx);
}
