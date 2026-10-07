// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSessionTabButton,
  createSessionTabs,
  setSessionTabStatus,
  type SessionTabs,
} from "./sessionTabs";

function setup() {
  document.body.replaceChildren();
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const onNew = vi.fn();
  const tabs = createSessionTabs(mount, { onNew });
  return { mount, tabs, onNew };
}

function addNamedTab(tabs: SessionTabs, projectId: string, title: string) {
  const t = createSessionTabButton();
  t.titleEl.textContent = title;
  tabs.addTab(projectId, t.buttonEl);
  return t;
}

describe("createSessionTabButton / setSessionTabStatus", () => {
  it("construit la structure du contrat sans data-status", () => {
    const { buttonEl, titleEl, closeEl } = createSessionTabButton();
    expect(buttonEl.getAttribute("role")).toBe("tab");
    expect(buttonEl.querySelector(".den-session-tab__status")).not.toBeNull();
    expect(buttonEl.hasAttribute("data-status")).toBe(false);
    expect(titleEl.className).toBe("den-session-tab__title");
    expect(closeEl.textContent).toBe("×");
    expect(closeEl.getAttribute("aria-label")).toBe("Close session");
  });

  it("pose et retire data-status", () => {
    const { buttonEl } = createSessionTabButton();
    setSessionTabStatus(buttonEl, "needs_input");
    expect(buttonEl.getAttribute("data-status")).toBe("needs_input");
    setSessionTabStatus(buttonEl, null);
    expect(buttonEl.hasAttribute("data-status")).toBe(false);
  });
});

describe("createSessionTabs", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("setProject n'affiche que les onglets du projet", () => {
    const a = addNamedTab(ctx.tabs, "p1", "A");
    const b = addNamedTab(ctx.tabs, "p2", "B");
    ctx.tabs.setProject("p1", "/x");
    expect(a.buttonEl.hidden).toBe(false);
    expect(b.buttonEl.hidden).toBe(true);
    ctx.tabs.setProject("p2", "/y");
    expect(a.buttonEl.hidden).toBe(true);
    expect(b.buttonEl.hidden).toBe(false);
  });

  it("désactive + sans projet et appelle onNew sinon", () => {
    const add = ctx.mount.querySelector<HTMLButtonElement>(".den-session-tabs__add")!;
    expect(add.disabled).toBe(true);
    ctx.tabs.setProject("p1", null);
    expect(add.disabled).toBe(false);
    add.click();
    expect(ctx.onNew).toHaveBeenCalledTimes(1);
    ctx.tabs.setProject(null, null);
    expect(add.disabled).toBe(true);
  });

  it("affiche pathText en texte avec title", () => {
    ctx.tabs.setProject("p1", "<b>/a/b</b>");
    const path = ctx.mount.querySelector<HTMLElement>(".den-session-tabs__path")!;
    expect(path.textContent).toBe("<b>/a/b</b>");
    expect(path.children.length).toBe(0);
    expect(path.title).toBe("<b>/a/b</b>");
    ctx.tabs.setProject(null, null);
    expect(path.textContent).toBe("");
    expect(path.hasAttribute("title")).toBe(false);
  });

  it("setActive gère classe et aria-selected", () => {
    const a = addNamedTab(ctx.tabs, "p1", "A");
    const b = addNamedTab(ctx.tabs, "p1", "B");
    ctx.tabs.setActive(a.buttonEl);
    expect(a.buttonEl.classList.contains("den-session-tab--active")).toBe(true);
    expect(a.buttonEl.getAttribute("aria-selected")).toBe("true");
    expect(b.buttonEl.getAttribute("aria-selected")).toBe("false");
    ctx.tabs.setActive(null);
    expect(a.buttonEl.classList.contains("den-session-tab--active")).toBe(false);
  });

  it("removeTab retire l'onglet du DOM", () => {
    const a = addNamedTab(ctx.tabs, "p1", "A");
    ctx.tabs.removeTab(a.buttonEl);
    expect(ctx.mount.contains(a.buttonEl)).toBe(false);
  });
});
