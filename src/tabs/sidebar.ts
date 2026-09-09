/**
 * Module `tabs/sidebar` — rendu DOM pur de la sidebar projets/sessions
 * (DEN-04 A2). Remplace l'ancienne barre d'onglets horizontale (`#den-tabs`
 * -> `#den-sidebar`) : une row par projet persisté (nom, slot `.den-project__badge`
 * vide — ancrage DEN-05 — boutons `+` / `×`) et, sous chaque projet, un
 * conteneur `role="tablist"` qui reçoit les rows session.
 *
 * Pur : aucun import `@tauri-apps/*` ici, testable en happy-dom sans mock
 * Tauri (cf. `sidebar.test.ts`, même patron que `../interactive/blocks.ts`).
 * `tabs/index.ts` garde toute la logique sidecar/router (spawn, chips de
 * lifecycle...) et fournit les handlers + les rows session elles-mêmes (les
 * `.den-tab` existants, ajoutés via `appendSessionRow`).
 */
import { displayName, type Project } from "../workspace/store";

export interface SidebarHandlers {
  onNewSession(projectId: string): void;
  onRemoveProject(projectId: string): void;
}

export interface Sidebar {
  /**
   * Re-rend les rows projet à partir de `projects` : conserve le nœud
   * `.den-project` existant (et donc ses rows session déjà présentes) pour
   * chaque id toujours dans la liste — recalcule seulement nom/title — crée
   * les projets manquants, retire ceux qui ont disparu, et respecte l'ordre
   * de `projects` dans le DOM.
   */
  setProjects(projects: Project[]): void;
  /** Ajoute `el` sous le projet `projectId` (`.den-project__sessions`).
   * No-op + `console.warn` si `projectId` est inconnu (aucune row projet
   * pour cet id — ne devrait pas arriver, `tabs/index.ts` crée toujours le
   * tab après avoir résolu le projet). */
  appendSessionRow(projectId: string, el: HTMLElement): void;
}

interface ProjectRow {
  root: HTMLElement;
  nameEl: HTMLSpanElement;
  sessionsEl: HTMLElement;
}

/** Rend la sidebar dans `root` (vidé au préalable) : bouton launch en tête
 * (fourni par `launchButtonFactory` — un second nœud avec le même câblage
 * que le bouton de l'état vide côté conversation ; la factory porte déjà le
 * listener de clic, ce module ne câble rien dessus), puis la liste des
 * projets. */
export function createSidebar(
  root: HTMLElement,
  handlers: SidebarHandlers,
  launchButtonFactory: () => HTMLButtonElement,
): Sidebar {
  const rows = new Map<string, ProjectRow>();

  root.textContent = "";
  root.append(launchButtonFactory());
  const list = document.createElement("div");
  list.className = "den-project-list";
  root.append(list);

  function createProjectRow(projectId: string): ProjectRow {
    const projectEl = document.createElement("div");
    projectEl.className = "den-project";
    projectEl.dataset.projectId = projectId;

    const rowEl = document.createElement("div");
    rowEl.className = "den-project__row";

    const nameEl = document.createElement("span");
    nameEl.className = "den-project__name";

    // Slot vide — ancrage DEN-05, qui y rendra un indicateur d'état
    // (running/idle/erreur au niveau projet).
    const badgeEl = document.createElement("span");
    badgeEl.className = "den-project__badge";

    const newEl = document.createElement("button");
    newEl.type = "button";
    newEl.className = "den-project__new";
    newEl.textContent = "+";
    newEl.setAttribute("aria-label", "Nouvelle session");
    newEl.addEventListener("click", () => handlers.onNewSession(projectId));

    const removeEl = document.createElement("button");
    removeEl.type = "button";
    removeEl.className = "den-project__remove";
    removeEl.textContent = "×";
    removeEl.setAttribute("aria-label", "Retirer le projet");
    removeEl.addEventListener("click", () => handlers.onRemoveProject(projectId));

    rowEl.append(nameEl, badgeEl, newEl, removeEl);

    const sessionsEl = document.createElement("div");
    sessionsEl.className = "den-project__sessions";
    sessionsEl.setAttribute("role", "tablist");

    projectEl.append(rowEl, sessionsEl);
    return { root: projectEl, nameEl, sessionsEl };
  }

  function setProjects(projects: Project[]): void {
    const seen = new Set<string>();
    for (const project of projects) {
      seen.add(project.id);
      let row = rows.get(project.id);
      if (!row) {
        row = createProjectRow(project.id);
        rows.set(project.id, row);
      }
      row.nameEl.textContent = displayName(project, projects);
      row.nameEl.title = project.path;
      // `appendChild` sur un nœud déjà enfant le déplace en fin sans le
      // recréer (ses rows session survivent) — itérer `projects` dans
      // l'ordre suffit donc à faire respecter cet ordre au DOM.
      list.appendChild(row.root);
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.root.remove();
        rows.delete(id);
      }
    }
  }

  function appendSessionRow(projectId: string, el: HTMLElement): void {
    const row = rows.get(projectId);
    if (!row) {
      console.warn(`den: appendSessionRow — projet inconnu (${projectId})`);
      return;
    }
    row.sessionsEl.appendChild(el);
  }

  return { setProjects, appendSessionRow };
}
