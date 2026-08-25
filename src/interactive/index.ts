/**
 * Module `interactive` — surface interactive capable d'injecter des
 * `CustomBlock` (cf. src/types/protocol.ts) dans le flux de conversation
 * rendu par le module `markdown`.
 *
 * Stub lot 0 : aucun rendu (pas de mount point dédié — s'appuiera sur
 * #den-conversation via le module markdown).
 */
import type { DenContext } from "../core/registry";

export function init(_ctx: DenContext): void {
  // Lot dédié : enregistrer des CustomBlock et les pousser vers le renderer markdown.
}
