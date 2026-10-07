// @vitest-environment happy-dom
//
// Nécessite un DOM (document.createElement, appendChild) — cf.
// `../interactive/blocks.test.ts` pour la même annotation par-fichier.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSidebar, type SidebarHandlers } from "./sidebar";
import {
  defaultState,
  LOOSE_WORKSPACE_ID,
  type PersistedState,
  type Project,
  type Workspace,
} from "../workspace/store";

function makeState(overrides: {
  workspaces?: Workspace[];
  projects?: Project[];
}): PersistedState {
  return { ...defaultState(), workspaces: [], projects: [], ...overrides };
}

function makeHandlers(): SidebarHandlers {
  return {
    onAddWorkspace: vi.fn(),
    onRenameWorkspace: vi.fn(),
    onSetWorkspaceRoot: vi.fn(),
    onAddProject: vi.fn(),
    onSelectProject: vi.fn(),
    onRemove: vi.fn(),
  };
}

function launchButtonFactory(): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "den-launch";
  return button;
}

describe("createSidebar", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("aside");
    // Attaché au document : nécessaire pour que `document.activeElement`
    // suive `.focus()` (cf. test de renommage inline ci-dessous).
    document.body.appendChild(root);
  });

  describe("barre racine", () => {
    it("rend le launch en tête, puis + Workspace — et rien d'autre", () => {
      createSidebar(root, makeHandlers(), launchButtonFactory);

      const bar = root.querySelector(".den-root-bar");
      expect(bar).not.toBeNull();
      const children = [...bar!.children];
      expect(children[0].className).toBe("den-launch");
      expect(children[1].className).toBe("den-root-bar__add-workspace");
      expect(children[1].textContent).toBe("+ Workspace");
      expect(children).toHaveLength(2);
    });

    it("la barre de boutons vient après la liste des workspaces", () => {
      createSidebar(root, makeHandlers(), launchButtonFactory);
      expect([...root.children].map((el) => el.className)).toEqual([
        "den-workspace-list",
        "den-root-bar",
      ]);
    });

    it("clic sur + Workspace appelle onAddWorkspace", () => {
      const handlers = makeHandlers();
      createSidebar(root, handlers, launchButtonFactory);
      root.querySelector<HTMLButtonElement>(".den-root-bar__add-workspace")!.click();
      expect(handlers.onAddWorkspace).toHaveBeenCalled();
    });
  });

  describe("arbre 3 niveaux", () => {
    function threeLevelState(): PersistedState {
      return makeState({
        workspaces: [
          { id: "ws-1", name: "Minlay", rootPath: "/Users/vico/Dev/minlay" },
          { id: "ws-2", name: "Sans racine", rootPath: null },
        ],
        projects: [
          { id: "p-1", workspaceId: "ws-1", path: "/Users/vico/Dev/minlay/front" },
          { id: "p-2", workspaceId: "ws-2", path: "/tmp/other" },
        ],
      });
    }

    it("rend data-workspace-id / data-project-id, badges vides, title rootPath vs aucune racine", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(threeLevelState());

      const ws1 = root.querySelector('[data-workspace-id="ws-1"]');
      expect(ws1).not.toBeNull();
      expect(ws1!.querySelector(".den-workspace__name")?.getAttribute("title")).toBe(
        "Minlay — /Users/vico/Dev/minlay",
      );
      expect(ws1!.querySelector(".den-workspace__badge")?.textContent).toBe("");

      const ws2 = root.querySelector('[data-workspace-id="ws-2"]');
      expect(ws2!.querySelector(".den-workspace__name")?.getAttribute("title")).toBe(
        "Sans racine — no root",
      );

      const p1 = ws1!.querySelector('[data-project-id="p-1"]');
      expect(p1).not.toBeNull();
      expect(p1!.querySelector(".den-project__badge")?.textContent).toBe("");
      expect(p1!.querySelector(".den-project__name")?.getAttribute("title")).toBe(
        "/Users/vico/Dev/minlay/front",
      );
    });

    it("place chaque projet sous le bon workspace, dans l'ordre", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(threeLevelState());

      const ws1 = root.querySelector('[data-workspace-id="ws-1"]')!;
      const ws2 = root.querySelector('[data-workspace-id="ws-2"]')!;
      expect(ws1.querySelector('[data-project-id="p-1"]')).not.toBeNull();
      expect(ws1.querySelector('[data-project-id="p-2"]')).toBeNull();
      expect(ws2.querySelector('[data-project-id="p-2"]')).not.toBeNull();

      const workspaceIds = [...root.querySelectorAll(".den-workspace")].map(
        (el) => el.getAttribute("data-workspace-id"),
      );
      expect(workspaceIds).toEqual(["ws-1", "ws-2"]);
    });
  });

  describe("workspace implicite", () => {
    it("est rendu sans ligne d'en-tête, ses projets en liste plate ; un workspace normal garde la sienne", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [
            { id: LOOSE_WORKSPACE_ID, name: "Loose projects", rootPath: null },
            { id: "ws-1", name: "A", rootPath: null },
          ],
          projects: [
            { id: "p-1", workspaceId: LOOSE_WORKSPACE_ID, path: "/tmp/p1" },
            { id: "p-2", workspaceId: "ws-1", path: "/tmp/p2" },
          ],
        }),
      );

      const loose = root.querySelector(`[data-workspace-id="${LOOSE_WORKSPACE_ID}"]`)!;
      expect(loose.querySelector(".den-workspace__row")).toBeNull();
      expect(loose.querySelector(".den-workspace__name")).toBeNull();
      expect(loose.querySelector('[data-project-id="p-1"]')).not.toBeNull();

      const normal = root.querySelector('[data-workspace-id="ws-1"]')!;
      expect(normal.querySelector(".den-workspace__row")).not.toBeNull();
      expect(normal.querySelector(".den-workspace__name")?.textContent).toBe("A");
      expect(normal.querySelector('[data-project-id="p-2"]')).not.toBeNull();
    });

    it("beginRename sur le workspace implicite est un no-op (aucun input)", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [{ id: LOOSE_WORKSPACE_ID, name: "Loose projects", rootPath: null }],
          projects: [],
        }),
      );
      sidebar.beginRename(LOOSE_WORKSPACE_ID);
      expect(root.querySelector(".den-workspace__rename")).toBeNull();
    });

    it("clic sur une ligne projet du workspace implicite appelle onSelectProject", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [{ id: LOOSE_WORKSPACE_ID, name: "Loose projects", rootPath: null }],
          projects: [{ id: "p-1", workspaceId: LOOSE_WORKSPACE_ID, path: "/tmp/p1" }],
        }),
      );
      root.querySelector<HTMLElement>('[data-project-id="p-1"] .den-project__name')!.click();
      expect(handlers.onSelectProject).toHaveBeenCalledWith("p-1");
    });
  });

  describe("displayName par workspace", () => {
    it("deux 'front' dans deux workspaces distincts affichent front/front", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [
            { id: "ws-1", name: "A", rootPath: null },
            { id: "ws-2", name: "B", rootPath: null },
          ],
          projects: [
            { id: "p-1", workspaceId: "ws-1", path: "/a/front" },
            { id: "p-2", workspaceId: "ws-2", path: "/b/front" },
          ],
        }),
      );

      const names = [...root.querySelectorAll(".den-project__name")].map((el) => el.textContent);
      expect(names).toEqual(["front", "front"]);
    });

    it("deux 'front' dans le même workspace se désambiguïsent (a/front, b/front)", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [{ id: "ws-1", name: "A", rootPath: null }],
          projects: [
            { id: "p-1", workspaceId: "ws-1", path: "/a/front" },
            { id: "p-2", workspaceId: "ws-1", path: "/b/front" },
          ],
        }),
      );

      const names = [...root.querySelectorAll(".den-project__name")].map((el) => el.textContent);
      expect(names).toEqual(["a/front", "b/front"]);
    });
  });

  describe("setState conserve les nœuds", () => {

    it("conserve le nœud d'un projet sur un second setState", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      const state = makeState({
        workspaces: [{ id: "ws-1", name: "A", rootPath: null }],
        projects: [{ id: "p-1", workspaceId: "ws-1", path: "/tmp/p1" }],
      });
      sidebar.setState(state);
      const projectNode = root.querySelector('[data-project-id="p-1"]');
      sidebar.setState(state);
      expect(root.querySelector('[data-project-id="p-1"]')).toBe(projectNode);
    });

    it("déplace un projet changé de workspace sans recréer le nœud", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [
            { id: "ws-1", name: "A", rootPath: null },
            { id: "ws-2", name: "B", rootPath: null },
          ],
          projects: [{ id: "p-1", workspaceId: "ws-1", path: "/tmp/p1" }],
        }),
      );

      const projectNode = root.querySelector('[data-project-id="p-1"]');

      sidebar.setState(
        makeState({
          workspaces: [
            { id: "ws-1", name: "A", rootPath: null },
            { id: "ws-2", name: "B", rootPath: null },
          ],
          projects: [{ id: "p-1", workspaceId: "ws-2", path: "/tmp/p1" }],
        }),
      );

      const ws2 = root.querySelector('[data-workspace-id="ws-2"]')!;
      expect(ws2.querySelector('[data-project-id="p-1"]')).toBe(projectNode);
    });

    it("workspace retiré de state -> nœud absent", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [
            { id: "ws-1", name: "A", rootPath: null },
            { id: "ws-2", name: "B", rootPath: null },
          ],
        }),
      );

      sidebar.setState(makeState({ workspaces: [{ id: "ws-2", name: "B", rootPath: null }] }));

      expect(root.querySelector('[data-workspace-id="ws-1"]')).toBeNull();
      expect(root.querySelector('[data-workspace-id="ws-2"]')).not.toBeNull();
    });
  });

  describe("renommage inline", () => {
    function stateWithWorkspace(): PersistedState {
      return makeState({ workspaces: [{ id: "ws-1", name: "Minlay", rootPath: null }] });
    }

    it("beginRename insère un input pré-rempli, sélectionné et focus", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(stateWithWorkspace());

      sidebar.beginRename("ws-1");

      const input = root.querySelector<HTMLInputElement>(".den-workspace__rename");
      expect(input).not.toBeNull();
      expect(input!.value).toBe("Minlay");
      expect(document.activeElement).toBe(input);
    });

    it("beginRename sur un id inconnu ne fait rien", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(stateWithWorkspace());
      expect(() => sidebar.beginRename("ghost")).not.toThrow();
      expect(root.querySelector(".den-workspace__rename")).toBeNull();
    });

    it("Enter avec un nom valide appelle onRenameWorkspace et affiche le nouveau texte", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithWorkspace());
      sidebar.beginRename("ws-1");

      const input = root.querySelector<HTMLInputElement>(".den-workspace__rename")!;
      input.value = "Nouveau nom";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(handlers.onRenameWorkspace).toHaveBeenCalledWith("ws-1", "Nouveau nom");
      const nameEl = root.querySelector(".den-workspace__name");
      expect(nameEl?.textContent).toBe("Nouveau nom");
      expect(nameEl?.querySelector("input")).toBeNull();
    });

    it("Escape annule sans appeler le handler et restaure le nom courant", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithWorkspace());
      sidebar.beginRename("ws-1");

      const input = root.querySelector<HTMLInputElement>(".den-workspace__rename")!;
      input.value = "Ignoré";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(handlers.onRenameWorkspace).not.toHaveBeenCalled();
      expect(root.querySelector(".den-workspace__name")?.textContent).toBe("Minlay");
    });

    it("valeur vide (après trim) restaure le nom courant sans appeler le handler", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithWorkspace());
      sidebar.beginRename("ws-1");

      const input = root.querySelector<HTMLInputElement>(".den-workspace__rename")!;
      input.value = "   ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(handlers.onRenameWorkspace).not.toHaveBeenCalled();
      expect(root.querySelector(".den-workspace__name")?.textContent).toBe("Minlay");
    });

    it("même nom (après trim) n'appelle pas le handler", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithWorkspace());
      sidebar.beginRename("ws-1");

      const input = root.querySelector<HTMLInputElement>(".den-workspace__rename")!;
      input.value = "  Minlay  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(handlers.onRenameWorkspace).not.toHaveBeenCalled();
      expect(root.querySelector(".den-workspace__name")?.textContent).toBe("Minlay");
    });

    it("blur valide comme Enter", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithWorkspace());
      sidebar.beginRename("ws-1");

      const input = root.querySelector<HTMLInputElement>(".den-workspace__rename")!;
      input.value = "Via blur";
      input.dispatchEvent(new Event("blur"));

      expect(handlers.onRenameWorkspace).toHaveBeenCalledWith("ws-1", "Via blur");
    });

    it("Enter puis blur (retrait de l'input) ne déclenche qu'un seul commit", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithWorkspace());
      sidebar.beginRename("ws-1");

      const input = root.querySelector<HTMLInputElement>(".den-workspace__rename")!;
      input.value = "Une fois";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new Event("blur"));

      expect(handlers.onRenameWorkspace).toHaveBeenCalledTimes(1);
    });

    it("dblclick sur .den-workspace__name ouvre le renommage", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(stateWithWorkspace());

      root
        .querySelector(".den-workspace__name")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

      expect(root.querySelector(".den-workspace__rename")).not.toBeNull();
    });

    it("setState pendant un renommage en cours n'écrase pas l'input", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      const state = stateWithWorkspace();
      sidebar.setState(state);
      sidebar.beginRename("ws-1");

      sidebar.setState(state);

      expect(root.querySelector(".den-workspace__rename")).not.toBeNull();
    });
  });

  describe("boutons -> handlers avec le bon Owner", () => {
    function stateWithTree(): PersistedState {
      return makeState({
        workspaces: [{ id: "ws-1", name: "A", rootPath: "/tmp/root" }],
        projects: [{ id: "p-1", workspaceId: "ws-1", path: "/tmp/p1" }],
      });
    }

    it("+ projet -> onAddProject(workspaceId)", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-workspace__add-project")!.click();
      expect(handlers.onAddProject).toHaveBeenCalledWith("ws-1");
    });

    it("racine… -> onSetWorkspaceRoot(workspaceId)", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-workspace__root")!.click();
      expect(handlers.onSetWorkspaceRoot).toHaveBeenCalledWith("ws-1");
    });

    it("× (workspace) -> onRemove({kind: workspace, id})", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-workspace__remove")!.click();
      expect(handlers.onRemove).toHaveBeenCalledWith({ kind: "workspace", id: "ws-1" });
    });

    it("pas de bouton + ni de conteneur de sessions sous un projet", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(stateWithTree());
      expect(root.querySelector(".den-project__new")).toBeNull();
      expect(root.querySelector(".den-project__sessions")).toBeNull();
    });

    it("clic sur la ligne projet -> onSelectProject(id)", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLElement>(".den-project__row")!.click();
      expect(handlers.onSelectProject).toHaveBeenCalledWith("p-1");
    });

    it("clic sur × (project) n'appelle pas onSelectProject", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-project__remove")!.click();
      expect(handlers.onSelectProject).not.toHaveBeenCalled();
    });

    it("× (project) -> onRemove({kind: project, id})", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-project__remove")!.click();
      expect(handlers.onRemove).toHaveBeenCalledWith({ kind: "project", id: "p-1" });
    });
  });

  describe("projet sélectionné", () => {
    function twoProjects(): PersistedState {
      return makeState({
        workspaces: [{ id: "ws-1", name: "A", rootPath: null }],
        projects: [
          { id: "p-1", workspaceId: "ws-1", path: "/tmp/p1" },
          { id: "p-2", workspaceId: "ws-1", path: "/tmp/p2" },
        ],
      });
    }

    it("setSelectedProject marque la ligne ; chaque projet affiche son chemin, sélectionné ou non", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(twoProjects());
      sidebar.setSelectedProject("p-1");

      const p1 = root.querySelector('[data-project-id="p-1"]')!;
      expect(p1.classList.contains("den-project--selected")).toBe(true);
      expect(p1.querySelector(".den-project__path")?.textContent).toBe("/tmp/p1");
      const p2 = root.querySelector('[data-project-id="p-2"]')!;
      expect(p2.classList.contains("den-project--selected")).toBe(false);
      expect(p2.querySelector(".den-project__path")?.textContent).toBe("/tmp/p2");
    });

    it("une ligne projet se sélectionne au clavier (Entrée, Espace) et porte aria-current", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(twoProjects());
      const p1 = root.querySelector('[data-project-id="p-1"]') as HTMLElement;
      expect(p1.tabIndex).toBe(0);
      expect(p1.getAttribute("role")).toBe("button");

      p1.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      p1.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      expect(handlers.onSelectProject).toHaveBeenCalledTimes(2);
      expect(handlers.onSelectProject).toHaveBeenCalledWith("p-1");

      sidebar.setSelectedProject("p-1");
      expect(p1.getAttribute("aria-current")).toBe("true");
      sidebar.setSelectedProject(null);
      expect(p1.hasAttribute("aria-current")).toBe(false);
    });

    it("le chemin passe par formatPath et garde le chemin complet en tooltip", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory, (p) => `~${p}`);
      sidebar.setState(twoProjects());
      const path = root.querySelector('[data-project-id="p-1"] .den-project__path') as HTMLElement;
      expect(path.textContent).toBe("~/tmp/p1");
      expect(path.title).toBe("/tmp/p1");
    });

    it("setSelectedProject(null) retire la marque, les chemins restent", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(twoProjects());
      sidebar.setSelectedProject("p-1");
      sidebar.setSelectedProject(null);

      expect(root.querySelector(".den-project--selected")).toBeNull();
      expect(root.querySelectorAll(".den-project__path")).toHaveLength(2);
    });

    it("la sélection survit à un setState", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setSelectedProject("p-2");
      sidebar.setState(twoProjects());

      expect(
        root.querySelector('[data-project-id="p-2"]')!.classList.contains("den-project--selected"),
      ).toBe(true);
    });

    it("les slots badge restent vides et sans data-status", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(twoProjects());
      sidebar.setSelectedProject("p-1");
      for (const badge of root.querySelectorAll(".den-project__badge, .den-workspace__badge")) {
        expect(badge.textContent).toBe("");
        expect(badge.hasAttribute("data-status")).toBe(false);
      }
    });
  });

  describe("libellés anglais", () => {
    it("boutons de ligne workspace et projet", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [{ id: "ws-1", name: "A", rootPath: null }],
          projects: [{ id: "p-1", workspaceId: "ws-1", path: "/tmp/p1" }],
        }),
      );
      const label = (selector: string) => root.querySelector(selector)!;
      expect(label(".den-workspace__add-project").textContent).toBe("+ project");
      expect(label(".den-workspace__add-project").getAttribute("aria-label")).toBe("New project");
      expect(label(".den-workspace__root").textContent).toBe("root…");
      expect(label(".den-workspace__root").getAttribute("aria-label")).toBe("Choose root");
      expect(label(".den-workspace__remove").getAttribute("aria-label")).toBe("Remove workspace");
      expect(label(".den-project__remove").getAttribute("aria-label")).toBe("Remove project");
      expect(label(".den-root-bar__add-workspace").getAttribute("aria-label")).toBe("New workspace");
    });
  });
});
