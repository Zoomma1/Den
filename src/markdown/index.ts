/**
 * Module `markdown` — rendu du flux de conversation (assistant_delta,
 * tool_use/tool_result, custom blocks) dans #den-conversation.
 *
 * Contrainte de résultat (CLAUDE.md racine) : replay d'un transcript réel à
 * vitesse réelle sans freeze perceptible. Stratégie libre côté lot dédié
 * (marked + highlight.js sont déjà en dépendance racine).
 *
 * Stub lot 0 : placeholder visible, aucune logique de rendu.
 */
import type { DenContext } from "../core/registry";

export function init(ctx: DenContext): void {
  ctx.mounts.conversation.textContent =
    "markdown: en attente d'implémentation (lot dédié)";
}
