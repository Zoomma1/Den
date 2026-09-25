// @vitest-environment happy-dom
/**
 * Tests du module `terminal` (DEN-04 A4-2, groupes de terminaux par owner).
 * `@tauri-apps/api/core` (invoke + Channel) et xterm.js (+ addons) sont
 * mockés — happy-dom n'a ni canvas ni WebGL2 (cf. `src/interactive/index.test.ts`
 * pour le patron de mock `invoke`, `src/markdown/conversationView.test.ts`
 * pour le patron de dimensions simulées à la main).
 *
 * `init(ctx)` enregistre des listeners sur `window`/`document` qui ne sont
 * jamais retirés par le module lui-même (même patron que `markdown/index.ts`,
 * `tabs/index.ts`) — pour garder chaque test isolé, `initIsolated` capture
 * les listeners ajoutés pendant l'appel et `afterEach` les retire, sans quoi
 * les instances de tests précédents réagiraient aussi aux événements dispatchés
 * par les tests suivants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(1);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class FakeChannel<T> {
    onmessage: ((data: T) => void) | undefined;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    disposed = false;
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
    }
    loadAddon(): void {}
    open(): void {}
    onData(): void {}
    write(): void {}
    writeln(): void {}
    dispose(): void {
      this.disposed = true;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FakeFitAddon {
    fit(): void {}
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class FakeWebglAddon {
    disposed = false;
    onContextLoss(): void {}
    dispose(): void {
      this.disposed = true;
    }
  },
}));

import type { DenContext } from "../core/registry";
import { init } from "./index";

const fakeCtx = (root: HTMLElement): DenContext =>
  ({ mounts: { terminal: root } }) as unknown as DenContext;

/** Capture les listeners `window`/`document` ajoutés par `init(ctx)` pour
 * pouvoir les retirer en `afterEach` — cf. docstring de tête. */
const trackedListeners: Array<[EventTarget, string, EventListener]> = [];
function initIsolated(root: HTMLElement): void {
  const originalWindowAdd = window.addEventListener.bind(window);
  const originalDocAdd = document.addEventListener.bind(document);
  const windowSpy = vi
    .spyOn(window, "addEventListener")
    .mockImplementation((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      trackedListeners.push([window, type, listener as EventListener]);
      originalWindowAdd(type, listener, opts);
    });
  const docSpy = vi
    .spyOn(document, "addEventListener")
    .mockImplementation((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      trackedListeners.push([document, type, listener as EventListener]);
      originalDocAdd(type, listener, opts);
    });
  init(fakeCtx(root));
  windowSpy.mockRestore();
  docSpy.mockRestore();
}

function dispatchActiveTabChanged(
  tabId: string | null,
  cwd: string | null,
  owner: { kind: "root" | "workspace" | "project"; id: string | null } | null,
): void {
  window.dispatchEvent(
    new CustomEvent("den:active-tab-changed", { detail: { tabId, cwd, owner } }),
  );
}

function dispatchOwnerRemoved(kind: "workspace" | "project", id: string): void {
  window.dispatchEvent(new CustomEvent("den:owner-removed", { detail: { kind, id } }));
}

function dispatchSessionClosed(
  tabId: string,
  owner: { kind: "root" | "workspace" | "project"; id: string | null },
  cwd: string,
): void {
  window.dispatchEvent(
    new CustomEvent("den:session-closed", { detail: { tabId, owner, cwd } }),
  );
}

/** Nombre d'appels `invoke(command, {...cwd})` avec CE cwd précis — chaque
 * test utilise un cwd unique pour rester isolé des instances de tests
 * précédents encore vivantes (cf. `trackedListeners`/`afterEach`). */
/** Laisse le microtask queue se vider — le mock `invoke` résout `pty_spawn`
 * de façon asynchrone (`.then((id) => shell.ptyId = id)`) ; sans ce flush,
 * `shell.ptyId` resterait `undefined` au moment d'un `pty_kill` synchrone
 * juste après le spawn. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function spawnCallsFor(cwd: string): unknown[] {
  return invokeMock.mock.calls.filter(
    ([cmd, args]) => cmd === "pty_spawn" && (args as { cwd?: string })?.cwd === cwd,
  );
}

describe("terminal/index — groupes par owner", () => {
  let root: HTMLElement;

  beforeEach(() => {
    invokeMock.mockClear();
    root = document.createElement("section");
  });

  afterEach(() => {
    for (const [target, type, listener] of trackedListeners) {
      target.removeEventListener(type, listener);
    }
    trackedListeners.length = 0;
  });

  it("aucune session active : label visible, aucun groupe, aucun spawn", () => {
    initIsolated(root);
    dispatchActiveTabChanged(null, null, null);

    expect(root.querySelector(".den-terminal__label")?.hasAttribute("hidden")).toBe(false);
    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(0);
  });

  it("premier den:active-tab-changed crée un groupe et spawn un premier shell dans le cwd de la session", () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/root-a", { kind: "root", id: null });

    expect(spawnCallsFor("/test/root-a")).toHaveLength(1);
    const group = root.querySelector(".den-terminal__group");
    expect(group).not.toBeNull();
    expect(group?.hasAttribute("hidden")).toBe(false);
    expect(root.querySelectorAll(".den-terminal__viewport")).toHaveLength(1);
    expect(root.querySelectorAll(".den-terminal__tab")).toHaveLength(1);
    expect(root.querySelector(".den-terminal__label")?.hasAttribute("hidden")).toBe(true);
  });

  it("bascule vers un autre owner : masque le premier groupe, en montre/crée un second", () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/switch-a", { kind: "root", id: null });
    dispatchActiveTabChanged("tab-2", "/test/switch-b", { kind: "workspace", id: "ws-switch" });

    const groups = root.querySelectorAll(".den-terminal__group");
    expect(groups).toHaveLength(2);
    expect(groups[0].hasAttribute("hidden")).toBe(true);
    expect(groups[1].hasAttribute("hidden")).toBe(false);
  });

  it("revenir sur un groupe déjà créé le remontre sans re-spawner", () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/return-a", { kind: "root", id: null });
    dispatchActiveTabChanged("tab-2", "/test/return-b", { kind: "workspace", id: "ws-return" });
    dispatchActiveTabChanged("tab-1", "/test/return-a", { kind: "root", id: null });

    expect(spawnCallsFor("/test/return-a")).toHaveLength(1);
    const groups = root.querySelectorAll(".den-terminal__group");
    expect(groups[0].hasAttribute("hidden")).toBe(false);
    expect(groups[1].hasAttribute("hidden")).toBe(true);
  });

  it("le bouton + crée un nouvel onglet shell dans le groupe visible, spawné dans le cwd du groupe", () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/plus-a", { kind: "root", id: null });

    const addButton = root.querySelector<HTMLButtonElement>(".den-terminal__add");
    expect(addButton).not.toBeNull();
    addButton!.click();

    expect(spawnCallsFor("/test/plus-a")).toHaveLength(2);
    expect(root.querySelectorAll(".den-terminal__tab")).toHaveLength(2);
    expect(root.querySelectorAll(".den-terminal__viewport")).toHaveLength(2);
  });

  it("la croix d'un onglet le ferme (pty_kill) et active un onglet voisin", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/close-a", { kind: "root", id: null });
    root.querySelector<HTMLButtonElement>(".den-terminal__add")!.click();
    expect(root.querySelectorAll(".den-terminal__tab")).toHaveLength(2);
    await flushMicrotasks();

    invokeMock.mockClear();
    const firstClose = root.querySelector<HTMLElement>(".den-terminal__tab-close");
    firstClose!.click();

    expect(root.querySelectorAll(".den-terminal__tab")).toHaveLength(1);
    expect(root.querySelectorAll(".den-terminal__viewport")).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { id: expect.any(Number) });
  });

  it("den:owner-removed tue tous les onglets du groupe workspace/project correspondant et le retire", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/owner-removed-ws", { kind: "workspace", id: "ws-remove" });
    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);
    await flushMicrotasks();

    invokeMock.mockClear();
    dispatchOwnerRemoved("workspace", "ws-remove");

    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(0);
    expect(root.querySelectorAll(".den-terminal__tabs")).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { id: expect.any(Number) });
  });

  it("den:session-closed sur un groupe root sans session restante tue le groupe", () => {
    initIsolated(root);
    const owner = { kind: "root" as const, id: null };
    dispatchActiveTabChanged("tab-1", "/test/session-closed-root", owner);
    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);

    dispatchSessionClosed("tab-1", owner, "/test/session-closed-root");

    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(0);
  });

  it("den:session-closed sur un groupe workspace/project ne tue pas le groupe (il survit)", () => {
    initIsolated(root);
    const owner = { kind: "workspace" as const, id: "ws-survive" };
    dispatchActiveTabChanged("tab-1", "/test/session-closed-ws", owner);
    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);

    dispatchSessionClosed("tab-1", owner, "/test/session-closed-ws");

    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);
  });

  it("beforeunload tue les PTY de tous les onglets de tous les groupes", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/unload-a", { kind: "root", id: null });
    dispatchActiveTabChanged("tab-2", "/test/unload-b", { kind: "workspace", id: "ws-unload" });
    await flushMicrotasks();

    invokeMock.mockClear();
    window.dispatchEvent(new Event("beforeunload"));

    const killCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "pty_kill");
    expect(killCalls.length).toBeGreaterThanOrEqual(2);
  });
});
