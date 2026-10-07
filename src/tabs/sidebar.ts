/**
 * Module `tabs/sidebar` — rendu DOM pur de l'arbre workspace → projet (les
 * sessions vivent dans les onglets, hors sidebar). Une liste de workspaces
 * (nom renommable inline, racine, projets) suivie, en bas, de la barre
 * `.den-root-bar` (bouton launch + « + Workspace »). Le workspace implicite
 * (`LOOSE_WORKSPACE_ID`) est rendu sans en-tête : ses projets en liste plate.
 *
 * Ancrages DEN-05 : `.den-workspace__badge`, `.den-project__badge` (slots
 * vides, stylés via `data-status`), `data-workspace-id`, `data-project-id`.
 *
 * Pur : aucun import `@tauri-apps/*`, testable en happy-dom sans mock Tauri.
 */
import {
  displayName,
  isLooseWorkspace,
  projectsOfWorkspace,
  type PersistedState,
} from "../workspace/store";
import type { NodeRef } from "./owner";

export interface SidebarHandlers {
  onAddWorkspace(): void;
  /** `name` déjà `trim()`, non vide — appelé par `beginRename` seulement
   * quand la saisie diffère du nom courant. */
  onRenameWorkspace(workspaceId: string, name: string): void;
  onSetWorkspaceRoot(workspaceId: string): void;
  onAddProject(workspaceId: string): void;
  onSelectProject(projectId: string): void;
  onRemove(target: NodeRef): void;
}

export interface Sidebar {
  /**
   * Re-rend l'arbre à partir de `state` : conserve les nœuds `.den-workspace`
   * et `.den-project` existants
   * pour chaque id toujours présent dans `state` — recalcule seulement
   * nom/title —, crée les nœuds manquants, retire ceux qui ont disparu, et
   * respecte l'ordre de `state.workspaces` / `projectsOfWorkspace` dans le
   * DOM. Un projet dont le `workspaceId` a changé est déplacé sous son
   * nouveau parent (`appendChild` déplace sans recréer). Si un renommage inline est en cours sur un workspace (cf.
   * `beginRename`), son `nameEl` n'est PAS écrasé — l'input reste en place.
   */
  setState(state: PersistedState): void;
  /** Marque la ligne du projet `projectId` comme sélectionnée ; `null` retire
   * la marque. La sélection survit aux `setState`. */
  setSelectedProject(projectId: string | null): void;
  /** Bascule le nom du workspace `workspaceId` en édition inline (input
   * pré-rempli, sélectionné, focus). `Enter`/`blur` valident, `Escape`
   * annule — cf. docstring de `createSidebar`. `workspaceId` inconnu ->
   * no-op. */
  beginRename(workspaceId: string): void;
}

interface WorkspaceRow {
  root: HTMLElement;
  nameEl: HTMLSpanElement;
  projectsEl: HTMLElement;
  /** Dernier nom connu (posé par `setState`, ou optimiste après un commit de
   * renommage) — sert de valeur de départ et de repli à `beginRename`. */
  name: string;
  /** Input de renommage en cours, ou `null` — tant qu'il existe, `setState`
   * ne touche pas à `nameEl.textContent`. */
  renameInput: HTMLInputElement | null;
}

interface ProjectRow {
  root: HTMLElement;
  nameEl: HTMLSpanElement;
  pathEl: HTMLSpanElement;
}

/** Rend la sidebar dans `root` (vidé au préalable) :
 * - `.den-workspace-list` : un `.den-workspace[data-workspace-id]` par
 *   workspace, chacun avec sa row (nom renommable par double-clic, racine,
 *   retrait) et ses projets — sauf le workspace implicite, sans row ;
 * - `.den-root-bar` (en bas) : bouton launch (`launchButtonFactory` — porte
 *   déjà son propre listener, ce module ne câble rien dessus), « + Workspace ».
 *
 * Renommage inline (`beginRename`) : double-clic sur `.den-workspace__name`
 * (ou appel direct depuis `tabs/index.ts` après `onAddWorkspace`) vide le
 * nom et y insère un `<input class="den-workspace__rename">` pré-rempli
 * (valeur = nom courant, texte sélectionné, focus). `Enter` ou `blur`
 * valident : `trim()` non vide et différent du nom courant -> affichage
 * immédiat de la valeur saisie + `handlers.onRenameWorkspace` (le `setState`
 * qui suit confirme depuis l'état persisté) ; vide ou identique -> restaure
 * le nom courant sans appeler le handler. `Escape` annule toujours sans
 * handler. Un flag `finished` local à chaque édition garde une seule issue
 * (le retrait de l'input déclenche lui-même un `blur`, qui ne doit pas
 * re-déclencher un commit après un `Enter` déjà traité). */
export function createSidebar(
  root: HTMLElement,
  handlers: SidebarHandlers,
  launchButtonFactory: () => HTMLButtonElement,
  formatPath: (path: string) => string = (path) => path,
): Sidebar {
  const workspaceRows = new Map<string, WorkspaceRow>();
  const projectRows = new Map<string, ProjectRow>();

  root.textContent = "";

  const workspaceListEl = document.createElement("div");
  workspaceListEl.className = "den-workspace-list";

  const rootBarEl = document.createElement("div");
  rootBarEl.className = "den-root-bar";
  rootBarEl.append(launchButtonFactory());

  const addWorkspaceEl = document.createElement("button");
  addWorkspaceEl.type = "button";
  addWorkspaceEl.className = "den-root-bar__add-workspace";
  addWorkspaceEl.textContent = "+ Workspace";
  addWorkspaceEl.setAttribute("aria-label", "New workspace");
  addWorkspaceEl.addEventListener("click", () => handlers.onAddWorkspace());

  rootBarEl.append(addWorkspaceEl);
  root.append(workspaceListEl, rootBarEl);

  let selectedProjectId: string | null = null;

  function beginRename(workspaceId: string): void {
    const row = workspaceRows.get(workspaceId);
    if (!row || isLooseWorkspace(workspaceId)) return;
    // Un renommage déjà en cours sur ce workspace : pas de second input.
    if (row.renameInput) return;

    const currentName = row.name;
    row.nameEl.textContent = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "den-workspace__rename";
    input.value = currentName;
    row.nameEl.appendChild(input);
    row.renameInput = input;
    input.focus();
    input.select();

    let finished = false;
    function commit(): void {
      if (finished) return;
      finished = true;
      row!.renameInput = null;
      const trimmed = input.value.trim();
      if (trimmed.length === 0 || trimmed === currentName) {
        row!.nameEl.textContent = currentName;
        return;
      }
      row!.nameEl.textContent = trimmed;
      row!.name = trimmed;
      handlers.onRenameWorkspace(workspaceId, trimmed);
    }
    function cancel(): void {
      if (finished) return;
      finished = true;
      row!.renameInput = null;
      row!.nameEl.textContent = currentName;
    }
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", () => commit());
  }

  function createWorkspaceRow(workspaceId: string): WorkspaceRow {
    const workspaceEl = document.createElement("div");
    workspaceEl.className = "den-workspace";
    workspaceEl.dataset.workspaceId = workspaceId;
    const loose = isLooseWorkspace(workspaceId);
    if (loose) workspaceEl.classList.add("den-workspace--loose");

    // Workspace implicite : pas de ligne d'en-tête ; nameEl reste un nœud détaché pour que setState n'ait pas de cas particulier.
    if (loose) {
      const projectsEl = document.createElement("div");
      projectsEl.className = "den-workspace__projects";
      workspaceEl.append(projectsEl);
      return {
        root: workspaceEl,
        nameEl: document.createElement("span"),
        projectsEl,
        name: "",
        renameInput: null,
      };
    }

    const rowEl = document.createElement("div");
    rowEl.className = "den-workspace__row";

    const nameEl = document.createElement("span");
    nameEl.className = "den-workspace__name";
    nameEl.addEventListener("dblclick", () => beginRename(workspaceId));

    // Slot vide — ancrage DEN-05, indicateur d'état au niveau workspace.
    const badgeEl = document.createElement("span");
    badgeEl.className = "den-workspace__badge";

    const addProjectEl = document.createElement("button");
    addProjectEl.type = "button";
    addProjectEl.className = "den-workspace__add-project";
    addProjectEl.textContent = "+ project";
    addProjectEl.setAttribute("aria-label", "New project");
    addProjectEl.addEventListener("click", () => handlers.onAddProject(workspaceId));

    const rootBtnEl = document.createElement("button");
    rootBtnEl.type = "button";
    rootBtnEl.className = "den-workspace__root";
    rootBtnEl.textContent = "root…";
    rootBtnEl.setAttribute("aria-label", "Choose root");
    rootBtnEl.addEventListener("click", () => handlers.onSetWorkspaceRoot(workspaceId));

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "den-workspace__remove";
    removeEl.textContent = "×";
    removeEl.setAttribute("aria-label", "Remove workspace");
    removeEl.addEventListener("click", () =>
      handlers.onRemove({ kind: "workspace", id: workspaceId }),
    );

    rowEl.append(nameEl, badgeEl, addProjectEl, rootBtnEl, removeEl);

    const projectsEl = document.createElement("div");
    projectsEl.className = "den-workspace__projects";

    workspaceEl.append(rowEl, projectsEl);
    return { root: workspaceEl, nameEl, projectsEl, name: "", renameInput: null };
  }

  function createProjectRow(projectId: string): ProjectRow {
    const projectEl = document.createElement("div");
    projectEl.className = "den-project";
    projectEl.dataset.projectId = projectId;

    const rowEl = document.createElement("div");
    rowEl.className = "den-project__row";

    const nameEl = document.createElement("span");
    nameEl.className = "den-project__name";

    // Slot vide — ancrage DEN-05, indicateur d'état au niveau projet.
    const badgeEl = document.createElement("span");
    badgeEl.className = "den-project__badge";

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "den-project__remove";
    removeEl.textContent = "×";
    removeEl.setAttribute("aria-label", "Remove project");
    removeEl.addEventListener("click", () =>
      handlers.onRemove({ kind: "project", id: projectId }),
    );

    rowEl.append(nameEl, badgeEl, removeEl);
    projectEl.append(rowEl);

    // Les boutons de la ligne gardent leur propre action.
    projectEl.addEventListener("click", (event) => {
      if ((event.target as Element).closest("button")) return;
      handlers.onSelectProject(projectId);
    });
    // Sans ça la sélection d'un projet n'est possible qu'à la souris (les sessions étaient des boutons avant L3).
    projectEl.tabIndex = 0;
    projectEl.setAttribute("role", "button");
    projectEl.addEventListener("keydown", (event) => {
      if (event.target !== projectEl || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      handlers.onSelectProject(projectId);
    });

    const pathEl = document.createElement("span");
    pathEl.className = "den-project__path";
    // Toujours présent : une hauteur de ligne identique, sélectionnée ou non, évite que la liste saute.
    projectEl.append(pathEl);
    return { root: projectEl, nameEl, pathEl };
  }

  function setState(state: PersistedState): void {
    const seenWorkspaces = new Set<string>();
    const seenProjects = new Set<string>();

    for (const workspace of state.workspaces) {
      seenWorkspaces.add(workspace.id);
      let row = workspaceRows.get(workspace.id);
      if (!row) {
        row = createWorkspaceRow(workspace.id);
        workspaceRows.set(workspace.id, row);
      }
      row.name = workspace.name;
      // Renommage en cours : ne pas écraser l'input (cf. docstring de tête).
      if (!row.renameInput) row.nameEl.textContent = workspace.name;
      // Le nom complet en tooltip : le texte est clampé à 3 lignes.
      row.nameEl.title = `${workspace.name} — ${workspace.rootPath ?? "no root"}`;
      // `appendChild` sur un nœud déjà enfant le déplace en fin sans le
      // recréer (ses projets survivent) — itérer dans l'ordre
      // suffit donc à faire respecter cet ordre au DOM.
      workspaceListEl.appendChild(row.root);

      const siblings = projectsOfWorkspace(state, workspace.id);
      for (const project of siblings) {
        seenProjects.add(project.id);
        let prow = projectRows.get(project.id);
        if (!prow) {
          prow = createProjectRow(project.id);
          projectRows.set(project.id, prow);
        }
        prow.nameEl.textContent = displayName(project, siblings);
        prow.nameEl.title = project.path;
        prow.pathEl.textContent = formatPath(project.path);
        prow.pathEl.title = project.path;
        // Un projet déplacé vers un autre workspace est réappendu ici, sous son nouveau parent.
        row.projectsEl.appendChild(prow.root);
      }
    }

    for (const [id, row] of workspaceRows) {
      if (!seenWorkspaces.has(id)) {
        row.root.remove();
        workspaceRows.delete(id);
      }
    }
    for (const [id, row] of projectRows) {
      if (!seenProjects.has(id)) {
        row.root.remove();
        projectRows.delete(id);
      }
    }
    applySelection();
  }

  function applySelection(): void {
    for (const [id, row] of projectRows) {
      const selected = id === selectedProjectId;
      row.root.classList.toggle("den-project--selected", selected);
      if (selected) row.root.setAttribute("aria-current", "true");
      else row.root.removeAttribute("aria-current");
    }
  }

  function setSelectedProject(projectId: string | null): void {
    selectedProjectId = projectId;
    applySelection();
  }

  return { setState, setSelectedProject, beginRename };
}
