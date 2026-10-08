import "./sessionsPanel.css";
import { STATUS_META, type SessionStatus } from "./status";

export interface SessionCard {
  tabId: string;
  projectName: string;
  sessionId: string | null;
  status: SessionStatus | null;
  activity: string;
  active: boolean;
}

export interface SessionsPanelHandlers {
  onJump(tabId: string): void;
}

export interface SessionsPanel {
  triggerEl: HTMLButtonElement;
  setCards(cards: SessionCard[]): void;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

interface CardEls {
  el: HTMLButtonElement;
  name: HTMLSpanElement;
  sid: HTMLSpanElement;
  status: HTMLSpanElement;
  activity: HTMLSpanElement;
}

export function createSessionsPanel(host: HTMLElement, handlers: SessionsPanelHandlers): SessionsPanel {
  const triggerEl = document.createElement("button");
  triggerEl.type = "button";
  triggerEl.className = "den-sessions-trigger";
  const triggerLabel = document.createElement("span");
  triggerLabel.textContent = "Sessions";
  const badgeEl = document.createElement("span");
  badgeEl.className = "den-sessions-trigger__badge";
  badgeEl.hidden = true;
  triggerEl.append(triggerLabel, badgeEl);

  const backdrop = document.createElement("div");
  backdrop.className = "den-sessions-backdrop";
  backdrop.hidden = true;
  const dialog = document.createElement("div");
  dialog.className = "den-sessions-panel";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Sessions");
  const listEl = document.createElement("div");
  listEl.className = "den-sessions-panel__list";
  const emptyEl = document.createElement("p");
  emptyEl.className = "den-sessions-panel__empty";
  emptyEl.textContent = "No sessions";
  dialog.append(listEl, emptyEl);
  backdrop.append(dialog);
  host.append(backdrop);

  const cards = new Map<string, CardEls>();
  let opened = false;
  let previousFocus: HTMLElement | null = null;

  function open(): void {
    if (opened) return;
    opened = true;
    previousFocus = document.activeElement as HTMLElement | null;
    backdrop.hidden = false;
    (listEl.querySelector("button") as HTMLElement | null)?.focus();
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    backdrop.hidden = true;
    previousFocus?.focus?.();
    previousFocus = null;
  }

  function makeCard(tabId: string): CardEls {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "den-sessions-card";
    const head = document.createElement("span");
    head.className = "den-sessions-card__head";
    const dot = document.createElement("span");
    dot.className = "den-sessions-card__dot";
    const name = document.createElement("span");
    name.className = "den-sessions-card__name";
    const sid = document.createElement("span");
    sid.className = "den-sessions-card__sid";
    const status = document.createElement("span");
    status.className = "den-sessions-card__status";
    head.append(dot, name, sid, status);
    const activity = document.createElement("span");
    activity.className = "den-sessions-card__activity";
    el.append(head, activity);
    el.addEventListener("click", () => handlers.onJump(tabId));
    return { el, name, sid, status, activity };
  }

  // Écrire seulement si la valeur change : préserve une sélection de texte en cours.
  function setText(node: HTMLElement, value: string): void {
    if (node.textContent !== value) node.textContent = value;
  }

  function setAttr(node: HTMLElement, name: string, value: string | null): void {
    if (value === null) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function setCards(next: SessionCard[]): void {
    const seen = new Set<string>();
    let needsInput = 0;
    for (const card of next) {
      seen.add(card.tabId);
      let els = cards.get(card.tabId);
      if (!els) {
        els = makeCard(card.tabId);
        cards.set(card.tabId, els);
      }
      setAttr(els.el, "data-status", card.status);
      setText(els.name, card.projectName);
      setText(els.sid, card.sessionId ? card.sessionId.slice(0, 8) : "");
      setText(els.status, card.status ? STATUS_META[card.status].label : "Idle");
      setText(els.activity, card.activity);
      if (els.el.classList.contains("den-sessions-card--active") !== card.active) {
        els.el.classList.toggle("den-sessions-card--active", card.active);
      }
      setAttr(els.el, "aria-current", card.active ? "true" : null);
      if (card.status === "needs_input") needsInput++;
    }
    for (const [tabId, els] of cards) {
      if (seen.has(tabId)) continue;
      els.el.remove();
      cards.delete(tabId);
    }
    // appendChild déplace un nœud déjà présent : l'ordre suit `next` sans recréer les cards.
    next.forEach((card, i) => {
      const el = cards.get(card.tabId)!.el;
      if (listEl.children[i] !== el) listEl.appendChild(el);
    });
    const showEmpty = next.length === 0;
    if (emptyEl.hidden === showEmpty) emptyEl.hidden = !showEmpty;
    setText(badgeEl, String(needsInput));
    const hideBadge = needsInput === 0;
    if (badgeEl.hidden !== hideBadge) badgeEl.hidden = hideBadge;
  }

  triggerEl.addEventListener("click", () => (opened ? close() : open()));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", (e) => {
    if (opened && e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  const isMac = /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);
  window.addEventListener(
    "keydown",
    (e) => {
      const modifierMatches = isMac ? e.metaKey : e.ctrlKey;
      if (!modifierMatches || !e.shiftKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (opened) close();
      else open();
    },
    { capture: true },
  );

  return {
    triggerEl,
    setCards,
    open,
    close,
    toggle: () => (opened ? close() : open()),
    isOpen: () => opened,
  };
}
