/**
 * API publique du plugin system Den (ADR-002).
 *
 * Point d'entrée MINIMAL et volontairement restreint — pas un écosystème
 * au MVP. Un plugin ne reçoit qu'un `PluginContext` limité (contribution à
 * la barre de statut + accès en lecture aux points de montage de l'app),
 * jamais un accès libre au DOM entier ni à l'état interne (registry, autres
 * modules). Toute extension de cette surface doit être justifiée : ce
 * fichier EST la documentation publique pour qui écrit un plugin externe.
 *
 * Limite assumée (MVP) : les plugins sont découverts et compilés avec
 * l'app via `import.meta.glob` (voir `index.ts`), pas chargés dynamiquement
 * à l'exécution depuis un chemin arbitraire du disque. Le chargement
 * runtime d'un plugin non compilé avec Den est reporté post-MVP.
 */

import type { DenMounts } from "../core/registry";

/**
 * API de contribution à la barre de statut de l'app (`#den-status`).
 *
 * Un plugin y ajoute un élément DOM pour afficher une info persistante
 * (badge, indicateur, lien...). Le plugin garde la responsabilité totale
 * du contenu et du style de l'élément qu'il fournit.
 */
export interface StatusBarApi {
  /** Ajoute `el` à la barre de statut, à la suite des éléments existants. */
  addItem(el: HTMLElement): void;
}

/**
 * Contexte passé à `DenPlugin.onMount`.
 *
 * Volontairement minimal : un plugin ne peut agir sur l'app qu'à travers
 * les API explicitement exposées ici (aujourd'hui : `statusBar`), et ne
 * peut lire les points de montage internes qu'en lecture seule — il ne
 * doit ni les remplacer, ni les vider ; pour ajouter du contenu visible,
 * passer par `statusBar` ou par ses propres éléments DOM.
 */
export interface PluginContext {
  /** API pour contribuer à la barre de statut (`#den-status`). */
  statusBar: StatusBarApi;
  /** Points de montage DOM de l'app, exposés en lecture seule. */
  readonly mounts: Readonly<DenMounts>;
}

/**
 * Contrat qu'un plugin Den doit implémenter.
 *
 * Un module sous `plugins/<nom-du-plugin>/index.ts` exporte une instance
 * de `DenPlugin` en export par défaut — c'est la seule convention requise
 * pour qu'un plugin soit découvert par le loader (`src/plugins/index.ts`).
 *
 * @example
 * ```ts
 * // plugins/mon-plugin/index.ts
 * import type { DenPlugin } from "../../src/plugins/api";
 *
 * const monPlugin: DenPlugin = {
 *   name: "mon-plugin",
 *   onMount(ctx) {
 *     const el = document.createElement("span");
 *     el.textContent = "Salut !";
 *     ctx.statusBar.addItem(el);
 *   },
 * };
 *
 * export default monPlugin;
 * ```
 */
export interface DenPlugin {
  /** Nom du plugin — utilisé dans les logs/erreurs pour l'identifier. */
  name: string;
  /**
   * Appelé une fois au démarrage de l'app, après le montage des modules
   * feature internes. Une exception levée ici est interceptée par le
   * loader : elle est loguée mais n'empêche ni les autres plugins ni
   * l'app de démarrer.
   */
  onMount(ctx: PluginContext): void;
}
