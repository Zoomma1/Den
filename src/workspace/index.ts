/**
 * Module `workspace` — charge/persiste l'état v2 (workspaces + projets +
 * layout, `state.json`, cf. `src-tauri/src/state.rs`) et expose le picker
 * natif de dossier au module `tabs`.
 *
 * IPC : `state_read` / `state_write` (commands Rust), branchées à
 * `createStore` (`src/workspace/store.ts`, pur/testé) via un `StateIO` qui
 * fait le pont vers `invoke`. En cas d'échec IPC au chargement → état par
 * défaut + `console.warn` (même posture que `theme/index.ts`) : jamais de
 * crash au démarrage.
 *
 * Migration v1 → v2 : `state_read` peut encore rendre un `workspace.json`
 * legacy (v1, pas de `state.json` écrit) — `store.load()` la détecte et migre
 * l'état déjà (cf. `store.ts::tryParsePersistedState`). Quand `migratedFrom`
 * vaut `1`, `init` termine la migration via `finishMigration` : **écrit
 * d'abord** `state.json` (le nouvel état v2) et, **seulement si cette
 * écriture a réussi**, renomme le legacy (`state_migrated`, côté Rust). Cet
 * ordre est le contrat : ne jamais renommer `workspace.json` avant d'avoir un
 * `state.json` v2 sur disque, sous peine de perdre les deux à la fois sur un
 * crash entre les deux étapes. Un échec de l'une ou l'autre étape reste un
 * simple `console.warn` — l'état en mémoire reste utilisable, `workspace.json`
 * sera relu en repli tant que `state.json` est absent.
 *
 * `addProject` canonicalise le path via `path_canonicalize` (Rust,
 * `fs::canonicalize`) avant dédup/insert — deux paths qui désignent le même
 * dossier doivent fusionner. Échec IPC (permission, path déjà disparu) :
 * `console.warn` + repli sur le path brut, même posture que le reste du
 * module (jamais de crash sur un échec de canonicalisation).
 *
 * API workspaces (`getWorkspaces`, `addWorkspace`, `renameWorkspace`,
 * `setWorkspaceRoot`, `removeWorkspace`) : posée par A2bis-1, consommée par
 * la sidebar 3 niveaux depuis A2bis-2 (`src/tabs/index.ts` et `sidebar.ts`).
 * Seule la logique pure est testée (`store.ts`) ; ces wrappers IPC ne le
 * sont pas.
 *
 * Pas de mount point dédié — ce module n'a pas de DOM propre, `tabs` le
 * consomme via son API exportée. Enregistré dans `main.ts` **entre `theme`
 * et `markdown`** : les projets doivent être chargés avant que `tabs` (qui
 * s'init après `markdown`) ne puisse créer un premier tab.
 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { DenContext } from "../core/registry";
import {
  createStore,
  defaultState,
  withoutProject,
  withoutWorkspace,
  type LayoutState,
  type PersistedState,
  type Project,
  type StateIO,
  type Workspace,
} from "./store";

const io: StateIO = {
  read: () => invoke<string>("state_read"),
  write: (raw) => invoke("state_write", { json: raw }),
};

const store = createStore(io, (raw) => {
  console.warn(
    "den: state.json illisible — état par défaut chargé. Le prochain " +
      "enregistrement l'écrasera (copie de la version courante dans state.json.bak).",
    raw.slice(0, 200),
  );
});
let state: PersistedState = defaultState();

/** Termine la migration v1 → v2 amorcée par `store.load()` : écrit l'état
 * migré puis, seulement si l'écriture a réussi, renomme le legacy côté Rust
 * (cf. docstring de tête pour l'ordre et sa raison d'être). */
async function finishMigration(): Promise<void> {
  try {
    await store.save(state);
  } catch (err) {
    console.warn(
      "den: écriture de state.json après migration v1 → v2 échouée — workspace.json conservé tel quel.",
      err,
    );
    return;
  }
  try {
    await invoke("state_migrated");
  } catch (err) {
    console.warn(
      "den: state_migrated a échoué, workspace.json non renommé (sera relu en repli tant que " +
        "state.json est absent, sans effet : state.json existe désormais).",
      err,
    );
  }
}

export async function init(_ctx: DenContext): Promise<void> {
  try {
    const { state: loaded, migratedFrom } = await store.load();
    state = loaded;
    if (migratedFrom === 1) await finishMigration();
  } catch (err) {
    console.warn("den: state_read a échoué, état par défaut conservé.", err);
    state = defaultState();
  }
}

export function getState(): PersistedState {
  return state;
}

export function getWorkspaces(): Workspace[] {
  return state.workspaces;
}

/** Ouvre le picker natif de dossier. `title` personnalise le titre de la
 * fenêtre (ex. « Choisis la racine du workspace », ou une variante
 * « Racine introuvable… » quand le picker rouvre après une racine disparue
 * — cf. `onNewSession` dans `src/tabs/index.ts`) ; absent, le picker garde
 * son titre par défaut. `null` = annulé — rien n'est créé/modifié. */
export async function pickProjectDirectory(title?: string): Promise<string | null> {
  const result = await open({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}

/** Vrai si `path` existe et est résolvable (délègue à `path_canonicalize`
 * côté Rust), faux sinon — jamais de throw. Distinct de `canonicalizePath`
 * ci-dessous, qui replie silencieusement sur le path brut en cas d'échec :
 * `probePath` sert au contraire à DÉTECTER une racine de workspace disparue
 * (dossier déplacé/supprimé) avant de tenter un spawn dessus. */
export async function probePath(path: string): Promise<boolean> {
  try {
    await invoke<string>("path_canonicalize", { path });
    return true;
  } catch {
    return false;
  }
}

/** Canonicalise `path` via la command Rust `path_canonicalize`. Échec IPC
 * (permission, dossier déjà disparu) → `console.warn` + repli sur `path`
 * brut, jamais de throw : un path non canonicalisé reste un path valide pour
 * `addProject`/`setWorkspaceRoot`, juste potentiellement dédupliqué en moins
 * de cas. */
async function canonicalizePath(path: string): Promise<string> {
  try {
    return await invoke<string>("path_canonicalize", { path });
  } catch (err) {
    console.warn("den: path_canonicalize a échoué, path brut conservé.", err);
    return path;
  }
}

export async function addWorkspace(name: string, rootPath: string | null = null): Promise<Workspace> {
  const workspace: Workspace = { id: crypto.randomUUID(), name, rootPath };
  state = { ...state, workspaces: [...state.workspaces, workspace] };
  await saveState();
  return workspace;
}

/** Renomme le workspace `id` — no-op silencieux (pas de `save`) si `name`
 * est vide/blanc ou si `id` est inconnu. */
export async function renameWorkspace(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  const workspace = state.workspaces.find((w) => w.id === id);
  if (!workspace) return;
  state = {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, name: trimmed } : w)),
  };
  await saveState();
}

/** Fixe la racine du workspace `id` (path canonicalisé) — no-op silencieux
 * si `id` est inconnu. */
export async function setWorkspaceRoot(id: string, path: string): Promise<void> {
  const workspace = state.workspaces.find((w) => w.id === id);
  if (!workspace) return;
  const canonical = await canonicalizePath(path);
  state = {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, rootPath: canonical } : w)),
  };
  await saveState();
}

/** Retire le workspace `id` et ses projets (`withoutWorkspace` + persistance)
 * — ne touche à aucune session : même contrat que `removeProject`, l'appelant
 * ferme d'abord les tabs de toutes les sessions du workspace ET de ses projets
 * (sinon leurs sidecars fuient). */
export async function removeWorkspace(id: string): Promise<void> {
  state = withoutWorkspace(state, id);
  await saveState();
}

/** Retrouve le projet de ce path canonique dans `workspaceId`, sinon en crée
 * un et sauvegarde. Dédup par path canonique **dans ce workspace** — le même
 * dossier peut être un projet distinct dans un autre workspace.
 *
 * `null` (aucune écriture) si `workspaceId` ne référence plus aucun workspace
 * au moment de l'insertion — vérifié APRÈS l'`await` de canonicalisation :
 * un retrait de workspace concurrent (review A2bis-2) aurait sinon persisté
 * un projet orphelin, que le parser v2 rejette en bloc au relaunch (perte de
 * tout l'état). L'appelant traite `null` comme un no-op. */
export async function addProject(workspaceId: string, path: string): Promise<Project | null> {
  const canonical = await canonicalizePath(path);
  if (!state.workspaces.some((w) => w.id === workspaceId)) return null;
  const existing = state.projects.find(
    (p) => p.workspaceId === workspaceId && p.path === canonical,
  );
  if (existing) return existing;

  const project: Project = { id: crypto.randomUUID(), workspaceId, path: canonical };
  state = { ...state, projects: [...state.projects, project] };
  await saveState();
  return project;
}

/** Retire le projet `id` (filtre pur `withoutProject` + persistance) — ne
 * touche à aucune session : c'est `tabs/index.ts` qui ferme les tabs du
 * projet AVANT d'appeler cette fonction (cf. docstring de `onRemove`,
 * `src/tabs/index.ts`). */
export async function removeProject(id: string): Promise<void> {
  state = withoutProject(state, id);
  await saveState();
}

/** Remplace `state.layout` (preset, tailles, `sidebarHidden`) **en mémoire
 * seulement**, de façon synchrone — contrairement aux autres setters, pas de
 * `saveState()` ici : c'est l'appelant (`src/layout/index.ts`) qui persiste
 * via `saveState()`, débouncé pendant un drag. Motif (review A3) :
 * `getState().layout` est la source de vérité que chaque geste relit ; si la
 * mise à jour mémoire attendait le tir du debounce, un second geste (autre
 * splitter, changement de preset, ⌘B) dans la fenêtre relirait un layout
 * périmé et écraserait le premier. */
export function setLayout(layout: LayoutState): void {
  state = { ...state, layout };
}

export async function saveState(): Promise<void> {
  try {
    await store.save(state);
  } catch (err) {
    console.warn("den: state_write a échoué, changement non persisté.", err);
  }
}
