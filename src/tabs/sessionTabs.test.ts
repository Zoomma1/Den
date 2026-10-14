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

  describe("drag & drop", () => {
    function addId(projectId: string, id: string) {
      const t = createSessionTabButton();
      ctx.tabs.addTab(projectId, t.buttonEl, id);
      return t.buttonEl;
    }
    function fire(el: HTMLElement, type: string, clientX = 0) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clientX", { value: clientX });
      el.dispatchEvent(e);
      return e;
    }
    function drag(from: HTMLElement, to: HTMLElement, clientX: number) {
      fire(from, "dragstart");
      fire(to, "dragover", clientX);
      fire(to, "drop", clientX);
      fire(from, "dragend");
    }

    it("l'indicateur de drop disparaît quand le pointeur quitte la barre", () => {
      const a = addId("p1", "a");
      const b = addId("p1", "b");
      fire(a, "dragstart");
      fire(b, "dragover", 1);
      expect(b.className).toMatch(/drop-(before|after)/);
      fire(b, "dragleave");
      expect(b.className).not.toMatch(/drop-/);
    });

    it("orderedTabIds suit l'ordre d'ajout et filtre par projet", () => {
      addId("p1", "a");
      addId("p2", "x");
      addId("p1", "b");
      expect(ctx.tabs.orderedTabIds("p1")).toEqual(["a", "b"]);
      expect(ctx.tabs.orderedTabIds("p2")).toEqual(["x"]);
    });

    it("réordonne : déposer après la cible", () => {
      const a = addId("p1", "a");
      const b = addId("p1", "b");
      addId("p1", "c");
      drag(a, b, 1);
      expect(ctx.tabs.orderedTabIds("p1")).toEqual(["b", "a", "c"]);
    });

    it("réordonne : déposer avant la cible", () => {
      addId("p1", "a");
      addId("p1", "b");
      const c = addId("p1", "c");
      drag(c, ctx.mount.querySelector<HTMLElement>(".den-session-tab")!, -1);
      expect(ctx.tabs.orderedTabIds("p1")).toEqual(["c", "a", "b"]);
    });

    it("refuse le drop inter-projets", () => {
      const a = addId("p1", "a");
      const x = addId("p2", "x");
      const over = (fire(a, "dragstart"), fire(x, "dragover", 1));
      expect(over.defaultPrevented).toBe(false);
      fire(x, "drop", 1);
      fire(a, "dragend");
      expect(ctx.tabs.orderedTabIds("p1")).toEqual(["a"]);
      expect(ctx.tabs.orderedTabIds("p2")).toEqual(["x"]);
      expect(ctx.mount.querySelector(".den-session-tabs__scroller")!.children[0]).toBe(a);
    });

    it("un drag n'émet pas de click vers l'onglet", () => {
      const a = addId("p1", "a");
      const b = addId("p1", "b");
      const onClick = vi.fn();
      a.addEventListener("click", onClick);
      drag(a, b, 1);
      a.click();
      expect(onClick).not.toHaveBeenCalled();
    });

    it("un click normal passe", () => {
      const a = addId("p1", "a");
      const onClick = vi.fn();
      a.addEventListener("click", onClick);
      a.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
