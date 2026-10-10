/**
 * Pane host : affiche dans `#den-pane` les panes poussés par les mods du moteur
 * (roster par tab, un seul pane montré à la fois) et les rend via
 * `renderTree`. Le roster fait foi : les actions (show/focus/close) ne
 * modifient rien ici, c'est le push `den:mod-panes` suivant qui re-rend.
 * La visibilité de la colonne passe par `den:pane-visibility-request`
 * (écouté par `layout`), pour ne pas importer `layout` d'ici.
 */
import {
  MOD_EVENTS,
  type CreatePaneHost,
  type ModInvalidateEventDetail,
  type ModPanesEventDetail,
  type PaneRoster,
} from "./contracts";
import { replaceKeepingFocus } from "./render";

const INVALIDATE_DEBOUNCE_MS = 100;
// Estimation grossière d'une cellule de grille de texte, le moteur ne rend pas en pixels.
const CELL_WIDTH_PX = 8;
const CELL_HEIGHT_PX = 18;
const FALLBACK_COLUMNS = 40;
const FALLBACK_ROWS = 24;

export const VISIBILITY_EVENT = "den:pane-visibility-request";

export const createPaneHost: CreatePaneHost = ({ mount, client, renderTree, options }) => {
  const rosters = new Map<string, PaneRoster>();
  // Dernier focusRequestedId honoré par tab : le moteur le répète sur plusieurs pushes.
  const honoredFocus = new Map<string, string>();
  // Focus accordé par le moteur à cette demande : un push suivant qui répète la demande ne doit pas l'effacer.
  const grantedFocus = new Map<string, string>();
  let activeTabId: string | null = null;
  // null = jamais émis : le 1er état réel est toujours appliqué (une colonne persistée ouverte ne doit pas rester vide au démarrage).
  let lastVisible: boolean | null = null;
  let bodyKey: string | null = null;
  let renderToken = 0;
  let invalidateTimer: ReturnType<typeof setTimeout> | null = null;

  mount.classList.add("den-pane");
  const tabsEl = document.createElement("div");
  tabsEl.className = "den-pane__tabs";
  tabsEl.setAttribute("role", "tablist");
  const bodyEl = document.createElement("div");
  bodyEl.className = "den-pane__body";
  bodyEl.tabIndex = 0;
  mount.replaceChildren(tabsEl, bodyEl);

  function activeRoster(): PaneRoster | null {
    return activeTabId ? (rosters.get(activeTabId) ?? null) : null;
  }

  function emptyBody(): void {
    const el = document.createElement("div");
    el.className = "den-pane__empty";
    bodyEl.replaceChildren(el);
  }

  function renderTabs(roster: PaneRoster | null): void {
    tabsEl.replaceChildren();
    for (const pane of roster?.panes ?? []) {
      const item = document.createElement("div");
      item.className = "den-pane__tabitem";

      const selected = pane.id === roster?.shownId;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "den-pane__tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("den-pane__tab--active", selected);
      tab.classList.toggle("den-pane__tab--focused", pane.id === roster?.focusedId);
      // Le titre vient d'un mod : nœud texte, jamais de HTML.
      tab.append(document.createTextNode(pane.title));
      tab.addEventListener("click", () => act("show", pane.id));

      const close = document.createElement("button");
      close.type = "button";
      close.className = "den-pane__tab-close";
      close.setAttribute("aria-label", `Close ${pane.title}`);
      close.append(document.createTextNode("×"));
      close.addEventListener("click", () => act("close", pane.id));

      item.append(tab, close);
      tabsEl.append(item);
    }
  }

  function act(action: "show" | "focus" | "close", id: string): void {
    const tabId = activeTabId;
    if (!tabId) return;
    void client.paneAction(tabId, { action, id }).catch(() => undefined);
  }

  async function renderBody(roster: PaneRoster | null, force = false): Promise<void> {
    const tabId = activeTabId;
    const pane = roster?.panes.find((p) => p.id === roster.shownId);
    if (!tabId || !roster || !pane) {
      bodyKey = null;
      renderToken++;
      bodyEl.replaceChildren();
      return;
    }
    const isFocused = roster.focusedId === pane.id;
    const paneKey = `${tabId}|${pane.id}`;
    const key = `${paneKey}|${isFocused}`;
    if (!force && key === bodyKey) return;
    // Autre pane ou autre tab : ne pas laisser l'ancien contenu le temps du rendu.
    if (!bodyKey?.startsWith(`${paneKey}|`)) emptyBody();
    bodyKey = key;
    bodyEl.classList.toggle("den-pane__body--focused", isFocused);

    const token = ++renderToken;
    const columns = bodyEl.clientWidth
      ? Math.floor(bodyEl.clientWidth / CELL_WIDTH_PX)
      : (pane.columns ?? FALLBACK_COLUMNS);
    const bodyRows = pane.rows ?? (bodyEl.clientHeight ? Math.floor(bodyEl.clientHeight / CELL_HEIGHT_PX) : FALLBACK_ROWS);
    let tree = null;
    try {
      const res = await client.requestRender(tabId, {
        component: "Pane",
        instanceId: pane.id,
        props: {
          title: pane.title,
          isFocused,
          bodyColumns: columns,
          placement: "dock",
          scroll: { offset: 0, bodyRows },
          view: {},
        },
      });
      tree = res.tree;
    } catch {
      tree = null;
    }
    if (token !== renderToken) return;
    if (tree === null || (typeof tree === "object" && tree.type === "engine")) {
      emptyBody();
      return;
    }
    replaceKeepingFocus(bodyEl, renderTree(tree, options?.(tabId)));
  }

  function syncVisibility(roster: PaneRoster | null): void {
    const visible = (roster?.panes.length ?? 0) > 0;
    if (visible === lastVisible) return;
    lastVisible = visible;
    window.dispatchEvent(new CustomEvent(VISIBILITY_EVENT, { detail: { visible } }));
  }

  function refresh(): void {
    const roster = activeRoster();
    syncVisibility(roster);
    renderTabs(roster);
    void renderBody(roster);
  }

  function onPanes(e: Event): void {
    const { tabId, ...roster } = (e as CustomEvent<ModPanesEventDetail>).detail;
    const requested = roster.focusRequestedId ?? null;
    if (requested && !roster.focusedId && grantedFocus.get(tabId) === requested) {
      roster.focusedId = requested;
    }
    rosters.set(tabId, roster);
    if (!requested) {
      honoredFocus.delete(tabId);
      grantedFocus.delete(tabId);
    } else if (honoredFocus.get(tabId) !== requested) {
      honoredFocus.set(tabId, requested);
      void client.paneAction(tabId, { action: "focus", id: requested }).then(
        (res) => {
          const current = rosters.get(tabId);
          if (!res.handled || !current) return;
          grantedFocus.set(tabId, requested);
          rosters.set(tabId, { ...current, focusedId: res.value ?? requested });
          if (tabId === activeTabId) {
            refresh();
            if (bodyEl.isConnected) bodyEl.focus({ preventScroll: true });
          }
        },
        () => undefined,
      );
    }
    if (tabId === activeTabId) refresh();
  }

  function onActiveTab(e: Event): void {
    activeTabId = (e as CustomEvent<{ tabId: string | null }>).detail?.tabId ?? null;
    refresh();
  }

  function onInvalidate(e: Event): void {
    const { tabId, instances } = (e as CustomEvent<ModInvalidateEventDetail>).detail;
    const shownId = activeRoster()?.shownId;
    if (tabId !== activeTabId || !shownId) return;
    if (!instances.some((i) => i.component === "Pane" && i.instanceId === shownId)) return;
    if (invalidateTimer) clearTimeout(invalidateTimer);
    invalidateTimer = setTimeout(() => {
      invalidateTimer = null;
      void renderBody(activeRoster(), true);
    }, INVALIDATE_DEBOUNCE_MS);
  }

  function onSessionClosed(e: Event): void {
    const tabId = (e as CustomEvent<{ tabId: string }>).detail?.tabId;
    rosters.delete(tabId);
    honoredFocus.delete(tabId);
    grantedFocus.delete(tabId);
    if (tabId === activeTabId) refresh();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    const roster = activeRoster();
    const pane = roster?.panes.find((p) => p.id === roster.focusedId);
    if (!pane?.closeOnEscape) return;
    e.preventDefault();
    act("close", pane.id);
  }

  window.addEventListener(MOD_EVENTS.panes, onPanes);
  window.addEventListener("den:active-tab-changed", onActiveTab);
  window.addEventListener(MOD_EVENTS.invalidate, onInvalidate);
  window.addEventListener("den:session-closed", onSessionClosed);
  mount.addEventListener("keydown", onKeydown);

  return {
    dispose() {
      window.removeEventListener(MOD_EVENTS.panes, onPanes);
      window.removeEventListener("den:active-tab-changed", onActiveTab);
      window.removeEventListener(MOD_EVENTS.invalidate, onInvalidate);
      window.removeEventListener("den:session-closed", onSessionClosed);
      mount.removeEventListener("keydown", onKeydown);
      if (invalidateTimer) clearTimeout(invalidateTimer);
      renderToken++;
      mount.replaceChildren();
    },
  };
};
