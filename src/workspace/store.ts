/**
 * Module `workspace/store` — schéma + (dé)sérialisation + validation du
 * `state.json` persisté côté Rust (`src-tauri/src/state.rs`). Pur : aucun
 * import `@tauri-apps/*` ici — l'IPC vit dans `src/workspace/index.ts`
 * (`StateIO` injecté, cf. `createStore`), ce qui rend ce module testable en
 * environnement `node` sans mock Tauri.
 *
 * Modèle v2 (DEN-04 A2bis-1) : un **workspace** (groupe nommé + racine
 * optionnelle) regroupe des **projets** (dossier rattaché, `workspaceId`).
 * `layout` reste global à l'app, inchangé depuis v1.
 *
 * Migration v1 → v2 : `state_read` (Rust) peut encore rendre un
 * `workspace.json` v1 (`{ version: 1, projects: [{id, path}], layout }`,
 * cf. legacy dans `state.rs`) tant qu'il n'a pas été migré. La migration vit
 * ICI, dans le parser (`tryParsePersistedState`) : un payload v1 valide est
 * relevé en v2 avec un unique workspace « Défaut » auquel tous les projets
 * v1 sont rattachés — aucun projet n'est perdu (map 1:1). C'est à l'appelant
 * (`src/workspace/index.ts`) de persister ce résultat migré puis de signaler
 * la migration terminée côté Rust (`state_migrated`) — ce module ne fait que
 * détecter et produire l'état migré, jamais d'I/O.
 *
 * Contrat de robustesse : ni `tryParsePersistedState` ni `parsePersistedState`
 * ne throw jamais — tout payload malformé (JSON invalide, `version` inconnue,
 * tableau attendu absent, entrée invalide, projet orphelin — `workspaceId`
 * sans workspace correspondant —, `layout` hors schéma) retombe sur `null`
 * (`tryParsePersistedState`) ou l'état par défaut (`parsePersistedState`). Un
 * état par défaut plutôt qu'un crash au démarrage. `tryParsePersistedState`
 * expose cette validation en rendant `null` sur échec, pour que l'appelant
 * puisse **signaler** un fichier illisible avant qu'un `save` ne l'écrase
 * (cf. `createStore`) — le `.bak` côté Rust reste le filet de sécurité.
 */

export interface Workspace {
  id: string;
  name: string;
  /** Racine optionnelle du workspace (dossier commun aux projets, ex. un
   * client multi-repo) — `null` tant qu'aucune racine n'a été choisie. */
  rootPath: string | null;
}

export interface Project {
  id: string;
  /** Workspace auquel ce projet est rattaché — doit référencer un
   * `Workspace.id` du même état (cf. validation v2 ci-dessous). */
  workspaceId: string;
  /** Chemin absolu du dossier projet. */
  path: string;
}

export type LayoutPreset = "side-by-side" | "stacked";

export interface LayoutSizes {
  sidebarPx: number;
  conversationRatio: number;
}

export interface LayoutState {
  preset: LayoutPreset;
  sizes: Record<LayoutPreset, LayoutSizes>;
}

export interface PersistedState {
  version: 2;
  workspaces: Workspace[];
  projects: Project[];
  layout: LayoutState;
}

/** Résultat de parse : l'état (toujours v2) et, si le payload lu était du
 * v1, `migratedFrom: 1` — sinon `null`. Distinct de `PersistedState` pour
 * que l'appelant (`src/workspace/index.ts`) sache quand déclencher la suite
 * de la migration (écriture v2 puis `state_migrated`) sans avoir à
 * redétecter une migration après coup. */
export interface ParseResult {
  state: PersistedState;
  migratedFrom: 1 | null;
}

function defaultLayoutSizes(): LayoutSizes {
  return { sidebarPx: 240, conversationRatio: 0.6 };
}

function defaultLayout(): LayoutState {
  return {
    preset: "side-by-side",
    sizes: {
      "side-by-side": defaultLayoutSizes(),
      stacked: defaultLayoutSizes(),
    },
  };
}

/** État par défaut : 0 workspace, 0 projet — `ensureDefaultWorkspace`
 * (`src/workspace/index.ts`) crée le premier workspace « Défaut » à la
 * demande, pas ce module. */
export function defaultState(): PersistedState {
  return {
    version: 2,
    workspaces: [],
    projects: [],
    layout: defaultLayout(),
  };
}

const LAYOUT_PRESETS: readonly LayoutPreset[] = ["side-by-side", "stacked"];

function isLayoutSizes(value: unknown): value is LayoutSizes {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { sidebarPx?: unknown; conversationRatio?: unknown };
  return (
    typeof candidate.sidebarPx === "number" &&
    typeof candidate.conversationRatio === "number"
  );
}

function isLayout(value: unknown): value is LayoutState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { preset?: unknown; sizes?: unknown };
  if (!LAYOUT_PRESETS.includes(candidate.preset as LayoutPreset)) return false;
  if (typeof candidate.sizes !== "object" || candidate.sizes === null) return false;
  const sizes = candidate.sizes as Record<string, unknown>;
  return LAYOUT_PRESETS.every((preset) => isLayoutSizes(sizes[preset]));
}

/** Forme d'un projet v1 (legacy, `workspace.json` — pas de `workspaceId`). */
interface ProjectV1 {
  id: string;
  path: string;
}

function isProjectV1(value: unknown): value is ProjectV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; path?: unknown };
  return typeof candidate.id === "string" && typeof candidate.path === "string";
}

function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; name?: unknown; rootPath?: unknown };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    (typeof candidate.rootPath === "string" || candidate.rootPath === null)
  );
}

function isProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; workspaceId?: unknown; path?: unknown };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.path === "string"
  );
}

/** Migre un payload v1 valide en état v2 : un unique workspace « Défaut »
 * (id produit par `newId`) auquel tous les projets v1 sont rattachés — map
 * 1:1, aucun projet perdu par construction. `layout` repris tel quel. */
function migrateV1(
  projects: ProjectV1[],
  layout: LayoutState,
  newId: () => string,
): PersistedState {
  const workspaceId = newId();
  return {
    version: 2,
    workspaces: [{ id: workspaceId, name: "Défaut", rootPath: null }],
    projects: projects.map((p) => ({ id: p.id, workspaceId, path: p.path })),
    layout,
  };
}

/**
 * Parse et valide un `state.json` (ou legacy `workspace.json`) brut. Jamais
 * de throw : `null` sur tout écart au schéma v1 ou v2. `newId` (défaut
 * `crypto.randomUUID`) fabrique l'id du workspace créé par une migration v1
 * — injectable pour un test déterministe.
 *
 * - `version === 1` : validé avec le schéma v1 legacy (`projects` = tableau
 *   de `{id, path}` strings, `layout` valide) ; invalide -> `null` ; valide
 *   -> migration v2 (`migratedFrom: 1`).
 * - `version === 2` : `workspaces` = tableau de `Workspace` valides,
 *   `projects` = tableau de `Project` valides **dont chaque `workspaceId`
 *   référence un workspace du payload** (un projet orphelin invalide tout le
 *   payload — pas de perte silencieuse), `layout` valide -> `migratedFrom: null`.
 * - toute autre version -> `null`.
 */
export function tryParsePersistedState(
  raw: string,
  newId: () => string = () => crypto.randomUUID(),
): ParseResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as {
    version?: unknown;
    projects?: unknown;
    workspaces?: unknown;
    layout?: unknown;
  };

  if (candidate.version === 1) {
    if (!Array.isArray(candidate.projects) || !candidate.projects.every(isProjectV1)) {
      return null;
    }
    if (!isLayout(candidate.layout)) return null;
    return { state: migrateV1(candidate.projects, candidate.layout, newId), migratedFrom: 1 };
  }

  if (candidate.version === 2) {
    if (!Array.isArray(candidate.workspaces) || !candidate.workspaces.every(isWorkspace)) {
      return null;
    }
    if (!Array.isArray(candidate.projects) || !candidate.projects.every(isProject)) {
      return null;
    }
    if (!isLayout(candidate.layout)) return null;
    const workspaceIds = new Set(candidate.workspaces.map((w) => w.id));
    if (!candidate.projects.every((p) => workspaceIds.has(p.workspaceId))) return null;
    return {
      state: {
        version: 2,
        workspaces: candidate.workspaces,
        projects: candidate.projects,
        layout: candidate.layout,
      },
      migratedFrom: null,
    };
  }

  return null;
}

/** `tryParsePersistedState` avec repli sur `defaultState()`. */
export function parsePersistedState(raw: string): PersistedState {
  return tryParsePersistedState(raw)?.state ?? defaultState();
}

/** JSON.stringify indenté — `state.json` reste lisible/éditable à la main. */
export function serializePersistedState(state: PersistedState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * Nom affichable d'un projet : basename du path (profondeur k=1) ; tant
 * qu'un autre projet de `siblings` partage les k derniers segments (et qu'il
 * reste des segments à remonter dans `project.path`), k augmente — jusqu'à
 * unicité ou à épuiser le path. `siblings` = les projets dans lesquels
 * chercher les collisions — typiquement les projets du même workspace (cf.
 * `projectsOfWorkspace`), pas tous les projets de l'état. Ex.
 * `/Users/vico/Dev/Den` vs `/Volumes/x/Dev/Den` : basename ET parent
 * ("Dev/Den") identiques pour les deux -> k monte à 3, `vico/Dev/Den` vs
 * `x/Dev/Den`.
 */
export function displayName(project: Project, siblings: Project[]): string {
  const segments = segmentsOf(project.path);
  let k = 1;
  while (k < segments.length && hasSuffixCollision(project, siblings, segments, k)) {
    k++;
  }
  // Path sans segment (`/`) : repli sur le path brut plutôt qu'un libellé vide.
  if (segments.length === 0) return project.path;
  return segments.slice(-k).join("/");
}

/** Vrai si un autre projet de `siblings` a les mêmes k derniers segments de
 * path que `project` (comparaison de tableaux de segments, pas de string
 * brute — un path plus court dont le path entier est un suffixe complet
 * compte). */
function hasSuffixCollision(
  project: Project,
  siblings: Project[],
  segments: string[],
  k: number,
): boolean {
  const suffix = segments.slice(-k);
  return siblings.some(
    (other) => other.id !== project.id && sameSuffix(segmentsOf(other.path), suffix),
  );
}

function sameSuffix(segments: string[], suffix: string[]): boolean {
  if (segments.length < suffix.length) return false;
  const otherSuffix = segments.slice(-suffix.length);
  return otherSuffix.every((segment, i) => segment === suffix[i]);
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** Projets rattachés à `workspaceId` — les « siblings » à passer à
 * `displayName` pour que les collisions de basename se calculent par
 * workspace, pas sur l'ensemble de l'état. Pur, aucune mutation. */
export function projectsOfWorkspace(state: PersistedState, workspaceId: string): Project[] {
  return state.projects.filter((p) => p.workspaceId === workspaceId);
}

/** Retire le projet `id` de `state` — pur, nouvel objet (`projects` filtré),
 * jamais de mutation. Id inconnu : retourne un état au même contenu
 * (nouvelle référence de `projects`, mêmes éléments). */
export function withoutProject(state: PersistedState, id: string): PersistedState {
  return { ...state, projects: state.projects.filter((p) => p.id !== id) };
}

/** Retire le workspace `id` **et ses projets** (cascade) — pur, nouvel objet
 * (`workspaces` et `projects` filtrés), jamais de mutation. Id inconnu :
 * retourne un état au même contenu (nouvelles références, mêmes éléments). */
export function withoutWorkspace(state: PersistedState, id: string): PersistedState {
  return {
    ...state,
    workspaces: state.workspaces.filter((w) => w.id !== id),
    projects: state.projects.filter((p) => p.workspaceId !== id),
  };
}

/** Accès I/O injecté — l'implémentation `invoke` vit dans `workspace/index.ts`. */
export interface StateIO {
  read(): Promise<string>;
  write(raw: string): Promise<void>;
}

/**
 * `onInvalid` est appelé quand le fichier lu est **non vide mais illisible**
 * (l'état par défaut est alors chargé) — l'appelant peut avertir que le
 * prochain `save` écrasera ce contenu. Un fichier vide/absent est le cas
 * normal du premier lancement et ne le déclenche pas.
 */
export function createStore(
  io: StateIO,
  onInvalid?: (raw: string) => void,
): {
  load(): Promise<ParseResult>;
  save(state: PersistedState): Promise<void>;
} {
  return {
    async load(): Promise<ParseResult> {
      const raw = await io.read();
      const result = tryParsePersistedState(raw);
      if (result) return result;
      if (raw.trim().length > 0) onInvalid?.(raw);
      return { state: defaultState(), migratedFrom: null };
    },
    async save(state: PersistedState): Promise<void> {
      await io.write(serializePersistedState(state));
    },
  };
}
