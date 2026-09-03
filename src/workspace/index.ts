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

/** Retrouve le projet de ce `path` exact, sinon en crée un et sauvegarde. */
export async function addProject(path: string): Promise<Project> {
  const existing = workspace.projects.find((p) => p.path === path);
  if (existing) return existing;

  const project: Project = { id: crypto.randomUUID(), path };
  workspace.projects.push(project);
  await saveWorkspace();
  return project;
}

export async function saveWorkspace(): Promise<void> {
  try {
    await store.save(workspace);
  } catch (err) {
    console.warn("den: workspace_write a échoué, changement non persisté.", err);
  }
}
