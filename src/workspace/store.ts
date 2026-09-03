/**
 * Module `workspace/store` — schéma + (dé)sérialisation + validation du
 * `workspace.json` persisté côté Rust (`src-tauri/src/workspace.rs`). Pur :
 * aucun import `@tauri-apps/*` ici — l'IPC vit dans `src/workspace/index.ts`
 * (`WorkspaceIO` injecté, cf. `createStore`), ce qui rend ce module testable
 * en environnement `node` sans mock Tauri.
 *
 * Contrat de robustesse : `parseWorkspace` ne throw jamais — tout payload
 * malformé (JSON invalide, `version` inconnue, `projects` non-tableau,
 * entrée sans `id`/`path` string, `layout` hors schéma) retombe sur
 * `defaultWorkspace()`. Un workspace par défaut plutôt qu'un crash au
 * démarrage. `tryParseWorkspace` expose la même validation en rendant
 * `null` sur échec, pour que l'appelant puisse **signaler** un fichier
 * illisible avant qu'un `save` ne l'écrase (cf. `createStore`).
 */

export interface Project {
  id: string;
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

export interface Workspace {
  version: 1;
  projects: Project[];
  layout: LayoutState;
}

function defaultLayoutSizes(): LayoutSizes {
  return { sidebarPx: 240, conversationRatio: 0.6 };
}

export function defaultWorkspace(): Workspace {
  return {
    version: 1,
    projects: [],
    layout: {
      preset: "side-by-side",
      sizes: {
        "side-by-side": defaultLayoutSizes(),
        stacked: defaultLayoutSizes(),
      },
    },
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

function isProject(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; path?: unknown };
  return typeof candidate.id === "string" && typeof candidate.path === "string";
}

/**
 * Parse et valide un `workspace.json` brut. Jamais de throw : `null` sur
 * tout écart au schéma (JSON invalide, version ≠ 1, `projects` non-tableau,
 * entrée de `projects` invalide, `layout` hors schéma).
 */
export function tryParseWorkspace(raw: string): Workspace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { version?: unknown; projects?: unknown; layout?: unknown };

  if (candidate.version !== 1) return null;
  if (!Array.isArray(candidate.projects) || !candidate.projects.every(isProject)) {
    return null;
  }
  if (!isLayout(candidate.layout)) return null;

  return { version: 1, projects: candidate.projects, layout: candidate.layout };
}

/** `tryParseWorkspace` avec repli sur `defaultWorkspace()`. */
export function parseWorkspace(raw: string): Workspace {
  return tryParseWorkspace(raw) ?? defaultWorkspace();
}

/** JSON.stringify indenté — `workspace.json` reste lisible/éditable à la main. */
export function serializeWorkspace(ws: Workspace): string {
  return JSON.stringify(ws, null, 2);
}

/**
 * Nom affichable d'un projet : basename du path ; sur collision de basename
 * avec un autre projet de `all`, `parent/basename` pour lever l'ambiguïté.
 */
export function displayName(project: Project, all: Project[]): string {
  const segments = project.path.split("/").filter((s) => s.length > 0);
  const base = basenameOf(project.path);

  const hasCollision = all.some(
    (other) => other.id !== project.id && basenameOf(other.path) === base,
  );
  if (!hasCollision) return base;

  const parent = segments[segments.length - 2];
  return parent ? `${parent}/${base}` : base;
}

function basenameOf(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** Accès I/O injecté — l'implémentation `invoke` vit dans `workspace/index.ts`. */
export interface WorkspaceIO {
  read(): Promise<string>;
  write(raw: string): Promise<void>;
}

/**
 * `onInvalid` est appelé quand le fichier lu est **non vide mais illisible**
 * (le défaut est alors chargé) — l'appelant peut avertir que le prochain
 * `save` écrasera ce contenu. Un fichier vide/absent est le cas normal du
 * premier lancement et ne le déclenche pas.
 */
export function createStore(
  io: WorkspaceIO,
  onInvalid?: (raw: string) => void,
): {
  load(): Promise<Workspace>;
  save(ws: Workspace): Promise<void>;
} {
  return {
    async load(): Promise<Workspace> {
      const raw = await io.read();
      const parsed = tryParseWorkspace(raw);
      if (parsed) return parsed;
      if (raw.trim().length > 0) onInvalid?.(raw);
      return defaultWorkspace();
    },
    async save(ws: Workspace): Promise<void> {
      await io.write(serializeWorkspace(ws));
    },
  };
}
