// @vitest-environment happy-dom
//
// Nécessite un DOM (document.createElement, appendChild) — cf.
// `../interactive/blocks.test.ts` pour la même annotation par-fichier.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSidebar } from "./sidebar";
import type { Project } from "../workspace/store";

function makeHandlers() {
  return {
    onNewSession: vi.fn(),
    onRemoveProject: vi.fn(),
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
  });

  it("rend le bouton launch en tête, puis une row par projet avec data-project-id, badge vide et title=path", () => {
    const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
    const projects: Project[] = [{ id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" }];
    sidebar.setProjects(projects);

    expect(root.firstElementChild?.className).toBe("den-launch");

    const projectEl = root.querySelector(".den-project");
    expect(projectEl).not.toBeNull();
    expect(projectEl?.getAttribute("data-project-id")).toBe("a");

    const nameEl = projectEl?.querySelector(".den-project__name");
    expect(nameEl?.textContent).toBe("Den");
    expect(nameEl?.getAttribute("title")).toBe("/Users/vico/Dev/Den");

    const badgeEl = projectEl?.querySelector(".den-project__badge");
    expect(badgeEl).not.toBeNull();
    expect(badgeEl?.textContent).toBe("");

    const sessionsEl = projectEl?.querySelector(".den-project__sessions");
    expect(sessionsEl?.getAttribute("role")).toBe("tablist");
  });

  it("sur collision de basename, affiche parent/basename pour les deux projets", () => {
    const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
    const projects: Project[] = [
      { id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" },
      { id: "b", workspaceId: "ws-1", path: "/Users/vico/04 - Projects/Den" },
    ];
    sidebar.setProjects(projects);

    const names = [...root.querySelectorAll(".den-project__name")].map((el) => el.textContent);
    expect(names).toEqual(["Dev/Den", "04 - Projects/Den"]);
  });

  it("clic sur + appelle onNewSession(projectId)", () => {
    const handlers = makeHandlers();
    const sidebar = createSidebar(root, handlers, launchButtonFactory);
    sidebar.setProjects([{ id: "a", workspaceId: "ws-1", path: "/tmp/proj-a" }]);

    root.querySelector<HTMLButtonElement>(".den-project__new")!.click();

    expect(handlers.onNewSession).toHaveBeenCalledWith("a");
  });

  it("clic sur × appelle onRemoveProject(projectId)", () => {
    const handlers = makeHandlers();
    const sidebar = createSidebar(root, handlers, launchButtonFactory);
    sidebar.setProjects([{ id: "a", workspaceId: "ws-1", path: "/tmp/proj-a" }]);

    root.querySelector<HTMLButtonElement>(".den-project__remove")!.click();

    expect(handlers.onRemoveProject).toHaveBeenCalledWith("a");
  });

  it("appendSessionRow place la row sous le bon projet", () => {
    const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
    sidebar.setProjects([
      { id: "a", workspaceId: "ws-1", path: "/tmp/proj-a" },
      { id: "b", workspaceId: "ws-1", path: "/tmp/proj-b" },
    ]);

    const sessionEl = document.createElement("button");
    sessionEl.className = "den-tab";
    sidebar.appendSessionRow("b", sessionEl);

    const projectB = root.querySelector('[data-project-id="b"]');
    expect(projectB?.querySelector(".den-project__sessions")?.contains(sessionEl)).toBe(true);
    const projectA = root.querySelector('[data-project-id="a"]');
    expect(projectA?.querySelector(".den-project__sessions")?.contains(sessionEl)).toBe(false);
  });

  it("appendSessionRow sur un projet inconnu ne plante pas et logue un warning", () => {
    const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
    sidebar.setProjects([{ id: "a", workspaceId: "ws-1", path: "/tmp/proj-a" }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sessionEl = document.createElement("button");
    expect(() => sidebar.appendSessionRow("unknown", sessionEl)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("setProjects avec la même liste conserve la row session existante (même nœud DOM)", () => {
    const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
    const projects: Project[] = [{ id: "a", workspaceId: "ws-1", path: "/tmp/proj-a" }];
    sidebar.setProjects(projects);

    const sessionEl = document.createElement("button");
    sessionEl.className = "den-tab";
    sidebar.appendSessionRow("a", sessionEl);

    sidebar.setProjects(projects);

    const sessionsEl = root.querySelector(".den-project__sessions");
    expect(sessionsEl?.firstElementChild).toBe(sessionEl);
  });

  it("setProjects sans un projet retire sa row (et ses rows session)", () => {
    const sidebar = createSidebar(root, makeHandlers(), launchButtonFactory);
    sidebar.setProjects([
      { id: "a", workspaceId: "ws-1", path: "/tmp/proj-a" },
      { id: "b", workspaceId: "ws-1", path: "/tmp/proj-b" },
    ]);

    sidebar.setProjects([{ id: "b", workspaceId: "ws-1", path: "/tmp/proj-b" }]);

    expect(root.querySelector('[data-project-id="a"]')).toBeNull();
    expect(root.querySelector('[data-project-id="b"]')).not.toBeNull();
  });


});
