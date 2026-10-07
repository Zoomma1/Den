/**
 * Module `terminal/group` — fonctions pures autour du groupe de terminaux
 * par nœud propriétaire (DEN-04 A4-2). Même patron que `src/tabs/owner.ts` :
 * aucun import `@tauri-apps/*` ici, tout calcul testable isolément (cf.
 * `group.test.ts`) est délégué par `src/terminal/index.ts`.
 */
import { ownerKey, type Owner } from "../tabs/owner";

/** Clé de groupe de terminaux : celle de l'owner (un projet = un cwd unique). */
export function groupKey(owner: Owner): string {
  return ownerKey(owner);
}

/** Libellé d'un onglet shell à partir de son index 0-based dans le groupe
 * (ex. `0` -> `"shell 1"`). */
export function shellLabel(index: number): string {
  return `shell ${index + 1}`;
}

/** Index qui doit devenir actif après le retrait de l'onglet à
 * `removedIndex` dans un groupe qui comptait `count` onglets AVANT retrait
 * — `null` si le groupe est vide après retrait. Choisit un voisin
 * raisonnable : le même index si un onglet existe encore à cette position
 * après le décalage des index suivants, sinon le dernier restant (l'onglet
 * retiré était le dernier de la liste). */
export function nextActiveIndex(count: number, removedIndex: number): number | null {
  const remaining = count - 1;
  if (remaining <= 0) return null;
  return removedIndex < remaining ? removedIndex : remaining - 1;
}
