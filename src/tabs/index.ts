/**
 * Module `tabs` — barre d'onglets, un onglet par session/sidecar.
 *
 * Stub lot 0 : placeholder visible, aucune logique de gestion d'onglets.
 */
import type { DenContext } from "../core/registry";

export function init(ctx: DenContext): void {
  ctx.mounts.tabs.textContent = "tabs: en attente d'implémentation (lot dédié)";
}
