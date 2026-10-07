import "./sessionTabs.css";
import type { SessionStatus } from "./status";

export interface SessionTabsHandlers {
  onNew(): void;
}

export interface SessionTabs {
  setProject(projectId: string | null, pathText: string | null): void;
  addTab(projectId: string, buttonEl: HTMLElement): void;
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
    addTab(projectId, buttonEl) {
      tabs.set(buttonEl, projectId);
      buttonEl.hidden = projectId !== currentProject;
      scroller.appendChild(buttonEl);
    },
    removeTab(buttonEl) {
      if (!tabs.delete(buttonEl)) return;
      buttonEl.remove();
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
