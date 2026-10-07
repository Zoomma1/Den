/**
 * Module `tabs/owner` — types et fonctions pures autour du nœud de rangement
 * d'une session (DEN-04 A2bis-2, DEN-17 : le projet est le seul owner).
 * L'arbre de la sidebar organise **l'attention de l'utilisateur**, pas le
 * disque : le `cwd` d'un tab est figé au spawn (jamais recalculé après
 * coup), tandis que son `owner` (le projet sous lequel la row session est
 * rangée) reste indépendant. Les deux ne se synchronisent jamais après
 * création : déplacer un projet ou changer la racine d'un workspace ne
 * bouge aucune session déjà ouverte.
 *
 * Pur : aucun import `@tauri-apps/*` ici — `tabs/index.ts` (qui, lui,
 * importe Tauri et n'est pas testable en happy-dom) délègue à ce module tout
 * calcul qui doit être testé isolément (cf. `owner.test.ts`, même patron que
 * `./lifecycle.ts`).
 */
import type { PersistedState } from "../workspace/store";

/** Nœud de rangement d'une session : toujours un projet. */
export interface Owner {
  kind: "project";
  id: string;
}

/** Cible de suppression dans l'arbre (workspace ou projet) — distincte de
 * `Owner` : seul un projet range des sessions. */
export interface NodeRef {
  kind: "workspace" | "project";
  id: string;
}

/** Clé stable pour indexer un `Owner` dans une `Map`/`Set` : `"project:<id>"`. */
export function ownerKey(owner: Owner): string {
  return `project:${owner.id}`;
}

/** Clé d'anti-réentrance d'un workspace (ownerKey ne couvre que les projets). */
export function workspaceKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

/** `path` du projet de l'`owner`, ou `null` s'il a disparu entre le clic et
 * l'exécution (l'appelant renonce alors au spawn, jamais de repli sur
 * `$HOME`). */
export function resolveCwd(owner: Owner, state: PersistedState): string | null {
  return state.projects.find((p) => p.id === owner.id)?.path ?? null;
}

/** Dernier segment non vide de `path` (ex. `/Users/vico/Dev/Den` ->
 * `"Den"`) ; `path` sans segment (`"/"`, `""`) -> `"/"`. Contrairement à
 * `displayName` (`workspace/store.ts`), ne désambiguïse rien : c'est le
 * libellé brut du header de session, pas un nom de row sidebar. */
export function basename(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : "/";
}

/** `path` avec `home` replié en `~` (ex. header de session) : `path ===
 * home` -> `"~"` ; `path` commence par `home + "/"` -> `"~" + reste` ;
 * sinon `path` inchangé. `home === null` (indisponible, cf. `homeDir()`
 * dans `tabs/index.ts`) -> `path` inchangé, jamais de crash. Un `home` avec
 * un slash final n'est PAS géré ici — c'est à l'appelant de le retirer avant
 * (cf. `owner.test.ts`). */
export function shortPath(path: string, home: string | null): string {
  if (home === null) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
