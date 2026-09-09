/**
 * Module `workspace` — charge/persiste la liste des projets connus et le
 * layout (`workspace.json`, cf. `src-tauri/src/workspace.rs`) et expose le
 * picker natif de dossier au module `tabs`.
 *
 * IPC : `workspace_read` / `workspace_write` (commands Rust), branchées à
 * `createStore` (`src/workspace/store.ts`, pur/testé) via un `WorkspaceIO`
 * qui fait le pont vers `invoke`. En cas d'échec IPC au chargement → workspace
 * par défaut + `console.warn` (même posture que `theme/index.ts`) : jamais de
 * crash au démarrage.
 *
 * `addProject` canonicalise le path via `workspace_canonicalize` (Rust,
 * `fs::canonicalize`) avant dédup/insert — deux paths qui désignent le même
 * dossier doivent fusionner. Échec IPC (permission, path déjà disparu) :
 * `console.warn` + repli sur le path brut, même posture que le reste du
 * module (jamais de crash sur un échec de canonicalisation).
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
  defaultWorkspace,
  withoutProject,
  type Project,
  type Workspace,
  type WorkspaceIO,
} from "./store";

const io: WorkspaceIO = {
  read: () => invoke<string>("workspace_read"),
  write: (raw) => invoke("workspace_write", { json: raw }),
};

const store = createStore(io, (raw) => {
  console.warn(
    "den: workspace.json illisible — workspace par défaut chargé. Le prochain " +
      "enregistrement l'écrasera (copie de la version courante dans workspace.json.bak).",
    raw.slice(0, 200),
  );
});
let workspace: Workspace = defaultWorkspace();

export async function init(_ctx: DenContext): Promise<void> {
  try {
    workspace = await store.load();
  } catch (err) {
    console.warn("den: workspace_read a échoué, workspace par défaut conservé.", err);
    workspace = defaultWorkspace();
  }
}

export function getProjects(): Project[] {
  return workspace.projects;
}

/** Ouvre le picker natif de dossier. `null` = annulé — aucun projet ajouté. */
export async function pickProjectDirectory(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

/** Canonicalise `path` via la command Rust `workspace_canonicalize`. Échec
 * IPC (permission, dossier déjà disparu) → `console.warn` + repli sur `path`
 * brut, jamais de throw : un path non canonicalisé reste un path valide pour
 * `addProject`, juste potentiellement dédupliqué en moins de cas. */
async function canonicalizePath(path: string): Promise<string> {
  try {
    return await invoke<string>("workspace_canonicalize", { path });
  } catch (err) {
    console.warn("den: workspace_canonicalize a échoué, path brut conservé.", err);
    return path;
  }
}

/** Retrouve le projet de ce path canonique, sinon en crée un et sauvegarde. */
export async function addProject(path: string): Promise<Project> {
  const canonical = await canonicalizePath(path);
  const existing = workspace.projects.find((p) => p.path === canonical);
  if (existing) return existing;

  const project: Project = { id: crypto.randomUUID(), path: canonical };
  workspace.projects.push(project);
  await saveWorkspace();
  return project;
}

/** Retire le projet `id` (filtre pur `withoutProject` + persistance) — ne
 * touche à aucune session : c'est `tabs/index.ts` qui ferme les tabs du
 * projet AVANT d'appeler cette fonction (cf. docstring de `onRemoveProject`). */
export async function removeProject(id: string): Promise<void> {
  workspace = withoutProject(workspace, id);
  await saveWorkspace();
}

export async function saveWorkspace(): Promise<void> {
  try {
    await store.save(workspace);
  } catch (err) {
    console.warn("den: workspace_write a échoué, changement non persisté.", err);
  }
}
