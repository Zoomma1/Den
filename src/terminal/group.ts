/**
 * Module `terminal/group` — fonctions pures autour du groupe de terminaux
 * par nœud propriétaire (DEN-04 A4-2). Même patron que `src/tabs/owner.ts` :
 * aucun import `@tauri-apps/*` ici, tout calcul testable isolément (cf.
 * `group.test.ts`) est délégué par `src/terminal/index.ts`.
 *
 * Un groupe de terminaux ne suit pas exactement l'`Owner` d'une session :
 * pour `workspace`/`project`, un `Owner` a un `cwd` unique (le nœud EST le
 * cwd — `ownerKey` suffit). Pour `root`, en revanche, plusieurs sessions
 * "Launch Claude in…" partagent `owner: { kind: "root", id: null }` avec des
 * `cwd` différents (chacune son propre dossier choisi au picker) — `"root"`
 * seul collapserait tous ces dossiers dans le même groupe de shells. D'où
 * `"root:" + cwd` : chaque dossier lancé à la racine obtient son propre
 * groupe, dans le bon dossier.
 */
import { ownerKey, type Owner } from "../tabs/owner";

/** Clé de groupe de terminaux pour une session au `cwd` donné : `ownerKey`
 * pour `workspace`/`project` (un owner = un cwd unique), `"root:" + cwd`
 * pour `root` (cf. docstring de tête). */
export function groupKey(owner: Owner, cwd: string): string {
  return owner.kind === "root" ? `root:${cwd}` : ownerKey(owner);
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
