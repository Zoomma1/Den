/**
 * Module `theme` — charge un fichier de thème (cf. den-theme.json à la
 * racine : clés de tokens -> valeurs CSS) et réécrit les custom properties
 * `--den-*` sur `:root`. N'a pas de mount point dédié : il agit sur le
 * document entier, avant tout autre module (cf. ordre dans main.ts).
 *
 * Stub lot 0 : no-op, les valeurs par défaut de src/styles.css s'appliquent.
 */
import type { DenContext } from "../core/registry";

export function init(_ctx: DenContext): void {
  // Lot dédié : lire den-theme.json et appliquer document.documentElement.style.setProperty.
}
