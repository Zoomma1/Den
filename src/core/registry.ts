/**
 * Registre d'initialisation des modules feature de Den.
 *
 * Contrat : chaque module feature (theme, workspace, markdown, tabs,
 * terminal, interactive, plugins) exporte une fonction `init(ctx)`. `main.ts` les
 * enregistre ici dans un ordre fixe et appelle `initAll` une seule fois au
 * démarrage. Aucun lot futur ne doit avoir besoin de retoucher `main.ts` :
 * un nouveau module s'ajoute en l'enregistrant via `registry.register(...)`.
 */

/** Points de montage DOM exposés à tous les modules. `sidebar` (DEN-04 A2,
 * `<aside id="den-sidebar">`) remplace l'ancienne barre d'onglets `tabs` —
 * projets persistés + leurs sessions, rendu par `src/tabs/sidebar.ts`. */
export interface DenMounts {
  sidebar: HTMLElement;
  conversation: HTMLElement;
  terminal: HTMLElement;
  status: HTMLElement;
}

/** Contexte passé à chaque `init(ctx)` de module. */
export interface DenContext {
  mounts: DenMounts;
}

/** Un module feature enregistrable dans le registre. */
export interface DenModule {
  name: string;
  init(ctx: DenContext): void | Promise<void>;
}

export class Registry {
  private readonly modules: DenModule[] = [];

  register(module: DenModule): void {
    this.modules.push(module);
  }

  /** Initialise tous les modules enregistrés, dans l'ordre d'enregistrement. */
  async initAll(ctx: DenContext): Promise<void> {
    for (const mod of this.modules) {
      await mod.init(ctx);
    }
  }
}
