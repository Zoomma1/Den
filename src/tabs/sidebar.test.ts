// @vitest-environment happy-dom
//
// Nécessite un DOM (document.createElement, appendChild) — cf.
// `../interactive/blocks.test.ts` pour la même annotation par-fichier.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSidebar, type SidebarHandlers } from "./sidebar";
import { defaultState, type PersistedState, type Project, type Workspace } from "../workspace/store";

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
    onNewSession: vi.fn(),
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
      // Pas de « + Session » : la session racine naît du bouton launch
      // (décision grill A2bis-2).
      expect(children).toHaveLength(2);
    });

    it("clic sur + Workspace appelle onAddWorkspace", () => {
      const handlers = makeHandlers();
      createSidebar(root, handlers, launchButtonFactory);
      root.querySelector<HTMLButtonElement>(".den-root-bar__add-workspace")!.click();
      expect(handlers.onAddWorkspace).toHaveBeenCalled();
    });

    it("expose .den-root__sessions[role=tablist]", () => {
      createSidebar(root, makeHandlers(), launchButtonFactory);
      const sessions = root.querySelector(".den-root__sessions");
      expect(sessions?.getAttribute("role")).toBe("tablist");
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
        "/Users/vico/Dev/minlay",
      );
      expect(ws1!.querySelector(".den-workspace__badge")?.textContent).toBe("");

      const ws2 = root.querySelector('[data-workspace-id="ws-2"]');
      expect(ws2!.querySelector(".den-workspace__name")?.getAttribute("title")).toBe(
        "aucune racine",
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
    it("conserve la row session root sur un second setState", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(makeState({}));

      const sessionEl = document.createElement("button");
      sidebar.appendSessionRow({ kind: "root", id: null }, sessionEl);
      sidebar.setState(makeState({}));

      expect(root.querySelector(".den-root__sessions")?.firstElementChild).toBe(sessionEl);
    });

    it("conserve la row session d'un workspace sur un second setState", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      const state = makeState({ workspaces: [{ id: "ws-1", name: "A", rootPath: null }] });
      sidebar.setState(state);

      const sessionEl = document.createElement("button");
      sidebar.appendSessionRow({ kind: "workspace", id: "ws-1" }, sessionEl);
      sidebar.setState(state);

      const sessionsEl = root.querySelector('[data-workspace-id="ws-1"] .den-workspace__sessions');
      expect(sessionsEl?.firstElementChild).toBe(sessionEl);
    });

    it("conserve la row session d'un projet sur un second setState", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      const state = makeState({
        workspaces: [{ id: "ws-1", name: "A", rootPath: null }],
        projects: [{ id: "p-1", workspaceId: "ws-1", path: "/tmp/p1" }],
      });
      sidebar.setState(state);

      const sessionEl = document.createElement("button");
      sidebar.appendSessionRow({ kind: "project", id: "p-1" }, sessionEl);
      sidebar.setState(state);

      const sessionsEl = root.querySelector('[data-project-id="p-1"] .den-project__sessions');
      expect(sessionsEl?.firstElementChild).toBe(sessionEl);
    });

    it("déplace un projet changé de workspace sans recréer le nœud (ses rows session suivent)", () => {
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
      const sessionEl = document.createElement("button");
      sidebar.appendSessionRow({ kind: "project", id: "p-1" }, sessionEl);

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
      expect(projectNode?.querySelector(".den-project__sessions")?.contains(sessionEl)).toBe(true);
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

  describe("appendSessionRow", () => {
    it("owner root -> .den-root__sessions", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(makeState({}));
      const el = document.createElement("button");
      sidebar.appendSessionRow({ kind: "root", id: null }, el);
      expect(root.querySelector(".den-root__sessions")?.contains(el)).toBe(true);
    });

    it("owner workspace -> .den-workspace__sessions du bon workspace", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(makeState({ workspaces: [{ id: "ws-1", name: "A", rootPath: null }] }));
      const el = document.createElement("button");
      sidebar.appendSessionRow({ kind: "workspace", id: "ws-1" }, el);
      expect(
        root.querySelector('[data-workspace-id="ws-1"] .den-workspace__sessions')?.contains(el),
      ).toBe(true);
    });

    it("owner project -> .den-project__sessions du bon projet", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(
        makeState({
          workspaces: [{ id: "ws-1", name: "A", rootPath: null }],
          projects: [{ id: "p-1", workspaceId: "ws-1", path: "/tmp/p1" }],
        }),
      );
      const el = document.createElement("button");
      sidebar.appendSessionRow({ kind: "project", id: "p-1" }, el);
      expect(
        root.querySelector('[data-project-id="p-1"] .den-project__sessions')?.contains(el),
      ).toBe(true);
    });

    it("owner workspace inconnu -> warn + no-op", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(makeState({}));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const el = document.createElement("button");
      expect(() => sidebar.appendSessionRow({ kind: "workspace", id: "ghost" }, el)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("owner project inconnu -> warn + no-op", () => {
      const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
      sidebar.setState(makeState({}));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const el = document.createElement("button");
      expect(() => sidebar.appendSessionRow({ kind: "project", id: "ghost" }, el)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
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

    it("+ (workspace) -> onNewSession({kind: workspace, id})", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-workspace__new")!.click();
      expect(handlers.onNewSession).toHaveBeenCalledWith({ kind: "workspace", id: "ws-1" });
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

    it("+ (project) -> onNewSession({kind: project, id})", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-project__new")!.click();
      expect(handlers.onNewSession).toHaveBeenCalledWith({ kind: "project", id: "p-1" });
    });

    it("× (project) -> onRemove({kind: project, id})", () => {
      const handlers = makeHandlers();
      const sidebar = createSidebar(root, handlers, launchButtonFactory);
      sidebar.setState(stateWithTree());
      root.querySelector<HTMLButtonElement>(".den-project__remove")!.click();
      expect(handlers.onRemove).toHaveBeenCalledWith({ kind: "project", id: "p-1" });
    });
  });
});
