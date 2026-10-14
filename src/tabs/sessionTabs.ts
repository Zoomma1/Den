import "./sessionTabs.css";
import type { SessionStatus } from "./status";

export interface SessionTabsHandlers {
  onNew(): void;
}

export interface SessionTabs {
  setProject(projectId: string | null, pathText: string | null): void;
  addTab(projectId: string, buttonEl: HTMLElement, tabId?: string): void;
  orderedTabIds(projectId: string): string[];
  removeTab(buttonEl: HTMLElement): void;
  setActive(buttonEl: HTMLElement | null): void;
}

export interface SessionTabButton {
  buttonEl: HTMLButtonElement;
  titleEl: HTMLSpanElement;
  closeEl: HTMLSpanElement;
}

export function createSessionTabButton(): SessionTabButton {
  const buttonEl = document.createElement("button");
  buttonEl.type = "button";
  buttonEl.className = "den-session-tab";
  buttonEl.setAttribute("role", "tab");
  buttonEl.setAttribute("aria-selected", "false");

  const status = document.createElement("span");
  status.className = "den-session-tab__status";
  const titleEl = document.createElement("span");
  titleEl.className = "den-session-tab__title";
  const closeEl = document.createElement("span");
  closeEl.className = "den-session-tab__close";
  closeEl.textContent = "×";
  closeEl.setAttribute("role", "button");
  closeEl.setAttribute("aria-label", "Close session");

  buttonEl.append(status, titleEl, closeEl);
  return { buttonEl, titleEl, closeEl };
}

export function setSessionTabStatus(buttonEl: HTMLElement, status: SessionStatus | null): void {
  if (status === null) buttonEl.removeAttribute("data-status");
  else buttonEl.setAttribute("data-status", status);
}

export function createSessionTabs(mount: HTMLElement, handlers: SessionTabsHandlers): SessionTabs {
  const container = document.createElement("div");
  container.className = "den-session-tabs";

  const scroller = document.createElement("div");
  scroller.className = "den-session-tabs__scroller";
  scroller.setAttribute("role", "tablist");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "den-session-tabs__add";
  addBtn.textContent = "+";
  addBtn.setAttribute("aria-label", "New session");
  addBtn.disabled = true;

  const pathEl = document.createElement("span");
  pathEl.className = "den-session-tabs__path";

  container.append(scroller, addBtn, pathEl);
  mount.prepend(container);

  const tabs = new Map<HTMLElement, string>();
  const ids = new Map<HTMLElement, string>();
  let dragged: HTMLElement | null = null;
  let dropTarget: HTMLElement | null = null;
  let suppressClick = false;

  function tabOf(target: EventTarget | null): HTMLElement | null {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>(".den-session-tab") ?? null;
    return el && tabs.has(el) ? el : null;
  }

  function clearIndicator(): void {
    dropTarget?.classList.remove("den-session-tab--drop-before", "den-session-tab--drop-after");
    dropTarget = null;
  }

  function isAfter(target: HTMLElement, e: DragEvent): boolean {
    const r = target.getBoundingClientRect();
    return e.clientX >= r.left + r.width / 2;
  }

  scroller.addEventListener("dragstart", (e) => {
    const tab = tabOf(e.target);
    if (!tab) return;
    dragged = tab;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // WebKit n'amorce pas un drag sans donnée associée.
      e.dataTransfer.setData("text/plain", ids.get(tab) ?? "");
    }
  });
  scroller.addEventListener("dragover", (e) => {
    const target = tabOf(e.target);
    if (!dragged || !target || target === dragged || tabs.get(target) !== tabs.get(dragged)) {
      clearIndicator();
      return;
    }
    e.preventDefault();
    clearIndicator();
    dropTarget = target;
    target.classList.add(isAfter(target, e) ? "den-session-tab--drop-after" : "den-session-tab--drop-before");
  });
  scroller.addEventListener("dragleave", (e) => {
    if (!scroller.contains(e.relatedTarget as Node | null)) clearIndicator();
  });
  scroller.addEventListener("drop", (e) => {
    const target = tabOf(e.target);
    if (!dragged || !target || target === dragged || tabs.get(target) !== tabs.get(dragged)) return;
    e.preventDefault();
    target.insertAdjacentElement(isAfter(target, e) ? "afterend" : "beforebegin", dragged);
    clearIndicator();
  });
  scroller.addEventListener("dragend", () => {
    dragged = null;
    clearIndicator();
    // Certains navigateurs émettent un click après le drag : on l'avale une fois.
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
  });
  scroller.addEventListener(
    "click",
    (e) => {
      if (!suppressClick) return;
      e.stopPropagation();
      e.preventDefault();
    },
    { capture: true },
  );
  let currentProject: string | null = null;

  addBtn.addEventListener("click", () => handlers.onNew());

  return {
    setProject(projectId, pathText) {
      currentProject = projectId;
      addBtn.disabled = projectId === null;
      pathEl.textContent = pathText ?? "";
      if (pathText) pathEl.title = pathText;
      else pathEl.removeAttribute("title");
      for (const [tab, pid] of tabs) tab.hidden = pid !== currentProject;
    },
    addTab(projectId, buttonEl, tabId) {
      tabs.set(buttonEl, projectId);
      const id = tabId ?? buttonEl.dataset.tabId;
      if (id !== undefined) ids.set(buttonEl, id);
      buttonEl.draggable = true;
      buttonEl.hidden = projectId !== currentProject;
      scroller.appendChild(buttonEl);
    },
    removeTab(buttonEl) {
      if (!tabs.delete(buttonEl)) return;
      ids.delete(buttonEl);
      buttonEl.remove();
    },
    orderedTabIds(projectId) {
      const out: string[] = [];
      for (const el of scroller.children) {
        const id = ids.get(el as HTMLElement);
        if (tabs.get(el as HTMLElement) === projectId && id !== undefined) out.push(id);
      }
      return out;
    },
    setActive(buttonEl) {
      for (const tab of tabs.keys()) {
        const on = tab === buttonEl;
        tab.classList.toggle("den-session-tab--active", on);
        tab.setAttribute("aria-selected", String(on));
      }
      buttonEl?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    },
  };
}
