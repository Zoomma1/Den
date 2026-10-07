/**
 * Module `tabs/sidebar` — rendu DOM pur de l'arbre workspace → projet →
 * sessions (DEN-04 A2bis-2). Seul le projet porte des sessions : une barre
 * racine (`.den-root-bar`, bouton launch + « + Workspace ») suivie de la
 * liste des workspaces — chacun avec son nom (renommable inline), sa racine
 * et ses projets (structure `.den-project` inchangée depuis A2). Le workspace
 * implicite (`LOOSE_WORKSPACE_ID`) est rendu sans en-tête : ses projets
 * apparaissent en liste plate.
 *
 * Ancrages DEN-05 (classes conservées à la lettre pour le lot notifications
 * à venir) : `.den-workspace__badge`, `.den-project__badge` (slots vides —
 * indicateur d'état par nœud), `.den-tab__status` (déjà porté par les rows
 * session elles-mêmes, fournies par `tabs/index.ts`), `data-workspace-id`,
 * `data-project-id`.
 *
 * Pur : aucun import `@tauri-apps/*` ici, testable en happy-dom sans mock
 * Tauri (cf. `sidebar.test.ts`, même patron que `../interactive/blocks.ts`).
 * `tabs/index.ts` garde toute la logique sidecar/router (spawn, chips de
 * lifecycle...) et fournit les handlers + les rows session elles-mêmes (les
 * `.den-tab` existants, ajoutés via `appendSessionRow`).
 */
import {
  displayName,
  isLooseWorkspace,
  projectsOfWorkspace,
  type PersistedState,
} from "../workspace/store";
import type { NodeRef, Owner } from "./owner";

export interface SidebarHandlers {
  onAddWorkspace(): void;
  /** `name` déjà `trim()`, non vide — appelé par `beginRename` seulement
   * quand la saisie diffère du nom courant. */
  onRenameWorkspace(workspaceId: string, name: string): void;
  onSetWorkspaceRoot(workspaceId: string): void;
  onAddProject(workspaceId: string): void;
  onNewSession(owner: Owner): void;
  onRemove(target: NodeRef): void;
}

export interface Sidebar {
  /**
   * Re-rend l'arbre à partir de `state` : conserve les nœuds `.den-workspace`
   * et `.den-project` existants (et donc leurs rows session déjà présentes)
   * pour chaque id toujours présent dans `state` — recalcule seulement
   * nom/title —, crée les nœuds manquants, retire ceux qui ont disparu, et
   * respecte l'ordre de `state.workspaces` / `projectsOfWorkspace` dans le
   * DOM. Un projet dont le `workspaceId` a changé est déplacé sous son
   * nouveau parent (ses rows session le suivent, `appendChild` déplace sans
   * recréer). Si un renommage inline est en cours sur un workspace (cf.
   * `beginRename`), son `nameEl` n'est PAS écrasé — l'input reste en place.
   */
  setState(state: PersistedState): void;
  /** Ajoute `el` sous `.den-project__sessions` du projet `owner`. Projet
   * disparu -> `console.warn` + no-op. */
  appendSessionRow(owner: Owner, el: HTMLElement): void;
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
  sessionsEl: HTMLElement;
}

/** Rend la sidebar dans `root` (vidé au préalable) :
 * - `.den-root-bar` : bouton launch (`launchButtonFactory` — porte déjà son
 *   propre listener, ce module ne câble rien dessus), « + Workspace » ;
 * - `.den-workspace-list` : un `.den-workspace[data-workspace-id]` par
 *   workspace, chacun avec sa row (nom renommable par double-clic, racine,
 *   retrait) et ses projets — sauf le workspace implicite, sans row.
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
): Sidebar {
  const workspaceRows = new Map<string, WorkspaceRow>();
  const projectRows = new Map<string, ProjectRow>();

  root.textContent = "";

  const rootBarEl = document.createElement("div");
  rootBarEl.className = "den-root-bar";
  rootBarEl.append(launchButtonFactory());

  const addWorkspaceEl = document.createElement("button");
  addWorkspaceEl.type = "button";
  addWorkspaceEl.className = "den-root-bar__add-workspace";
  addWorkspaceEl.textContent = "+ Workspace";
  addWorkspaceEl.setAttribute("aria-label", "Nouveau workspace");
  addWorkspaceEl.addEventListener("click", () => handlers.onAddWorkspace());

  rootBarEl.append(addWorkspaceEl);
  root.append(rootBarEl);

  const workspaceListEl = document.createElement("div");
  workspaceListEl.className = "den-workspace-list";
  root.append(workspaceListEl);

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
    addProjectEl.textContent = "+ projet";
    addProjectEl.setAttribute("aria-label", "Nouveau projet");
    addProjectEl.addEventListener("click", () => handlers.onAddProject(workspaceId));

    const rootBtnEl = document.createElement("button");
    rootBtnEl.type = "button";
    rootBtnEl.className = "den-workspace__root";
    rootBtnEl.textContent = "racine…";
    rootBtnEl.setAttribute("aria-label", "Choisir la racine");
    rootBtnEl.addEventListener("click", () => handlers.onSetWorkspaceRoot(workspaceId));

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "den-workspace__remove";
    removeEl.textContent = "×";
    removeEl.setAttribute("aria-label", "Retirer le workspace");
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

    const newEl = document.createElement("button");
    newEl.type = "button";
    newEl.className = "den-project__new";
    newEl.textContent = "+";
    newEl.setAttribute("aria-label", "Nouvelle session");
    newEl.addEventListener("click", () =>
      handlers.onNewSession({ kind: "project", id: projectId }),
    );

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "den-project__remove";
    removeEl.textContent = "×";
    removeEl.setAttribute("aria-label", "Retirer le projet");
    removeEl.addEventListener("click", () =>
      handlers.onRemove({ kind: "project", id: projectId }),
    );

    rowEl.append(nameEl, badgeEl, newEl, removeEl);

    const sessionsEl = document.createElement("div");
    sessionsEl.className = "den-project__sessions";
    sessionsEl.setAttribute("role", "tablist");

    projectEl.append(rowEl, sessionsEl);
    return { root: projectEl, nameEl, sessionsEl };
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
      row.nameEl.title = workspace.rootPath ?? "aucune racine";
      // `appendChild` sur un nœud déjà enfant le déplace en fin sans le
      // recréer (ses rows session/projets survivent) — itérer dans l'ordre
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
        // Un projet déplacé vers un autre workspace est réappendu ici, sous
        // son nouveau parent — ses rows session le suivent (même nœud DOM).
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
  }

  function appendSessionRow(owner: Owner, el: HTMLElement): void {
    const row = projectRows.get(owner.id);
    if (!row) {
      console.warn(`den: appendSessionRow — projet inconnu (${owner.id})`);
      return;
    }
    row.sessionsEl.appendChild(el);
  }

  return { setState, appendSessionRow, beginRename };
}
