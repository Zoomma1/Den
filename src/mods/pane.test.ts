// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOD_EVENTS, type ModPaneClient, type ModPanesEventDetail } from "./contracts";
import { createPaneHost } from "./pane";
import type { RenderNode } from "./tree";

const flush = () => new Promise((r) => setTimeout(r, 0));

function pushPanes(detail: Partial<ModPanesEventDetail> & { tabId: string }): void {
  window.dispatchEvent(
    new CustomEvent(MOD_EVENTS.panes, {
      detail: { panes: [], shownId: null, focusedId: null, ...detail },
    }),
  );
}

function activate(tabId: string | null): void {
  window.dispatchEvent(new CustomEvent("den:active-tab-changed", { detail: { tabId } }));
}

const A = { id: "a", title: "Files", plugin: "files" };
const B = { id: "b", title: "Plan", plugin: "plan", closeOnEscape: true };

describe("createPaneHost", () => {
  let mount: HTMLElement;
  let client: ModPaneClient & {
    requestRender: ReturnType<typeof vi.fn>;
    paneAction: ReturnType<typeof vi.fn>;
  };
  let host: { dispose(): void };
  let visibility: boolean[];
  const onVisibility = (e: Event) => visibility.push((e as CustomEvent<{ visible: boolean }>).detail.visible);
  const renderTree = vi.fn((node: RenderNode) => {
    const el = document.createElement("div");
    el.className = "rendered";
    el.textContent = JSON.stringify(node);
    return el;
  });

  beforeEach(() => {
    mount = document.createElement("aside");
    document.body.append(mount);
    visibility = [];
    window.addEventListener("den:pane-visibility-request", onVisibility);
    client = {
      requestRender: vi.fn(async () => ({ tree: { type: "Text", children: ["hi"] }, hooked: true, rewritten: false })),
      paneAction: vi.fn(async (_t: string, req: { id?: string | null }) => ({ handled: true, value: req.id ?? undefined })),
    } as never;
    renderTree.mockClear();
    host = createPaneHost({ mount, client, renderTree });
  });

  afterEach(() => {
    host.dispose();
    window.removeEventListener("den:pane-visibility-request", onVisibility);
    mount.remove();
    vi.useRealTimers();
  });

  const tabs = () => [...mount.querySelectorAll<HTMLElement>('[role="tab"]')];

  it("affiche le roster du tab actif seulement, et bascule avec le tab", () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A], shownId: "a" });
    pushPanes({ tabId: "t2", panes: [B], shownId: "b" });
    expect(tabs().map((t) => t.textContent)).toEqual(["Files"]);
    activate("t2");
    expect(tabs().map((t) => t.textContent)).toEqual(["Plan"]);
    activate("t3");
    expect(tabs()).toHaveLength(0);
  });

  it("rend le titre en texte, jamais en HTML", () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [{ ...A, title: '<img src=x onerror="alert(1)">' }], shownId: "a" });
    expect(mount.querySelector("img")).toBeNull();
    expect(tabs()[0].textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("marque l'onglet affiché et demande l'arbre avec les bons props", async () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "b", focusedId: null });
    await flush();
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(client.requestRender).toHaveBeenCalledWith("t1", {
      component: "Pane",
      instanceId: "b",
      props: expect.objectContaining({
        title: "Plan",
        isFocused: false,
        placement: "dock",
        view: {},
        scroll: { offset: 0, bodyRows: expect.any(Number) },
        bodyColumns: expect.any(Number),
      }),
    });
    expect(mount.querySelector(".rendered")).not.toBeNull();
  });

  it("arbre null, moteur ou erreur -> corps vide", async () => {
    activate("t1");
    client.requestRender.mockResolvedValueOnce({ tree: null, hooked: false, rewritten: false });
    pushPanes({ tabId: "t1", panes: [A], shownId: "a" });
    await flush();
    expect(mount.querySelector(".rendered")).toBeNull();
    expect(mount.querySelector(".den-pane__empty")).not.toBeNull();

    client.requestRender.mockResolvedValueOnce({ tree: { type: "engine", ref: 0 }, hooked: true, rewritten: false });
    pushPanes({ tabId: "t1", panes: [B], shownId: "b" });
    await flush();
    expect(renderTree).not.toHaveBeenCalled();

    client.requestRender.mockRejectedValueOnce(new Error("boom"));
    pushPanes({ tabId: "t1", panes: [A], shownId: "a" });
    await flush();
    expect(mount.querySelector(".den-pane__empty")).not.toBeNull();
  });

  it("clic sur un onglet -> show ; fermer -> close, sans retirer l'onglet soi-même", () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "a" });
    tabs()[1].click();
    expect(client.paneAction).toHaveBeenCalledWith("t1", { action: "show", id: "b" });
    mount.querySelectorAll<HTMLElement>(".den-pane__tab-close")[0].click();
    expect(client.paneAction).toHaveBeenCalledWith("t1", { action: "close", id: "a" });
    expect(tabs()).toHaveLength(2);
  });

  it("focusRequestedId -> focus une seule fois, marque visuelle", async () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "b", focusRequestedId: "b" });
    await flush();
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "b", focusRequestedId: "b" });
    await flush();
    const focusCalls = client.paneAction.mock.calls.filter(([, r]) => r.action === "focus");
    expect(focusCalls).toEqual([["t1", { action: "focus", id: "b" }]]);
    expect(tabs()[1].classList.contains("den-pane__tab--focused")).toBe(true);
    expect(client.requestRender).toHaveBeenLastCalledWith(
      "t1",
      expect.objectContaining({ props: expect.objectContaining({ isFocused: true }) }),
    );
  });

  it("Echap dans un pane focus avec closeOnEscape -> close ; sans le flag, rien", () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "a", focusedId: "a" });
    mount.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(client.paneAction).not.toHaveBeenCalled();
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "b", focusedId: "b" });
    mount.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(client.paneAction).toHaveBeenCalledWith("t1", { action: "close", id: "b" });
  });

  it("invalidate d'un Pane affiche -> re-rendu anti-rebond ; autre instance ignoree", async () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "a" });
    await flush();
    client.requestRender.mockClear();
    vi.useFakeTimers();
    const inv = (instanceId: string, component = "Pane") =>
      window.dispatchEvent(
        new CustomEvent(MOD_EVENTS.invalidate, { detail: { tabId: "t1", instances: [{ component, instanceId }] } }),
      );
    inv("b");
    inv("a", "AbovePrompt");
    vi.advanceTimersByTime(200);
    expect(client.requestRender).not.toHaveBeenCalled();
    inv("a");
    inv("a");
    vi.advanceTimersByTime(99);
    expect(client.requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(client.requestRender).toHaveBeenCalledTimes(1);
  });

  it("session-closed purge le tab", () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A], shownId: "a" });
    window.dispatchEvent(new CustomEvent("den:session-closed", { detail: { tabId: "t1" } }));
    expect(tabs()).toHaveLength(0);
  });

  it("evenement de visibilite : true au 1er pane, false quand le roster se vide", () => {
    activate("t1");
    pushPanes({ tabId: "t1", panes: [A], shownId: "a" });
    pushPanes({ tabId: "t1", panes: [A, B], shownId: "b" });
    pushPanes({ tabId: "t1", panes: [], shownId: null });
    // Le tout premier état (aucun pane) est émis aussi : une colonne persistée ouverte se referme au démarrage.
    expect(visibility).toEqual([false, true, false]);
  });

  it("au démarrage sans aucun pane, demande de masquer la colonne", () => {
    activate("t1");
    expect(visibility).toEqual([false]);
  });

  it("dispose retire les listeners", async () => {
    activate("t1");
    host.dispose();
    pushPanes({ tabId: "t1", panes: [A], shownId: "a" });
    await flush();
    expect(client.requestRender).not.toHaveBeenCalled();
    expect(visibility).toEqual([false]);
    expect(mount.children).toHaveLength(0);
  });
});
