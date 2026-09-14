/**
 * Module `tabs/owner` — types et fonctions pures autour du nœud de rangement
 * d'une session (DEN-04 A2bis-2). L'arbre de la sidebar organise
 * **l'attention de l'utilisateur**, pas le disque : le `cwd` d'un tab est
 * figé au spawn (jamais recalculé après coup), tandis que son `owner` (le
 * nœud — racine, workspace ou projet — sous lequel la row session est
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

export type OwnerKind = "root" | "workspace" | "project";

/** Nœud de rangement d'une session. `id` vaut `null` pour `root` (pas
 * d'identifiant — la racine n'est pas une entité persistée), et l'id de
 * l'entité pour `workspace`/`project`. */
export interface Owner {
  kind: OwnerKind;
  id: string | null;
}

/** Clé stable pour indexer un `Owner` dans une `Map`/`Set` (ex. le suivi des
 * retraits en cours dans `tabs/index.ts`) : `"root"` pour la racine,
 * `"workspace:<id>"` / `"project:<id>"` sinon. */
export function ownerKey(owner: Owner): string {
  return owner.kind === "root" ? "root" : `${owner.kind}:${owner.id}`;
}

/** `cwd` à utiliser pour une nouvelle session de cet `owner`, ou `null`
 * quand il ne peut être résolu (l'appelant doit alors renoncer au spawn, pas
 * retomber sur un dossier implicite) :
 * - `project` -> le `path` du projet (`null` si le projet a disparu entre le
 *   clic et l'exécution) ;
 * - `workspace` -> `rootPath` du workspace (`null` tant qu'aucune racine
 *   n'a été choisie — c'est à l'appelant d'ouvrir le picker AVANT
 *   `resolveCwd`, jamais de branche implicite ici) ;
 * - `root` -> `pickedPath` tel quel (toujours issu d'un picker, jamais de
 *   repli sur `$HOME`).
 *
 * AUCUNE branche « home » : le dossier est toujours choisi explicitement,
 * en amont de cet appel. */
export function resolveCwd(
  owner: Owner,
  state: PersistedState,
  pickedPath: string | null,
): string | null {
  if (owner.kind === "project") {
    return state.projects.find((p) => p.id === owner.id)?.path ?? null;
  }
  if (owner.kind === "workspace") {
    return state.workspaces.find((w) => w.id === owner.id)?.rootPath ?? null;
  }
  return pickedPath;
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
