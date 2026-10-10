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

const termInstances = vi.hoisted(() => [] as Array<{ options: Record<string, unknown> }>);
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
      termInstances.push(this);
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

const layoutState = vi.hoisted(() => ({
  layout: {
    preset: "stacked",
    sizes: {
      "side-by-side": { sidebarPx: 240, conversationRatio: 0.6 },
      stacked: { sidebarPx: 240, conversationRatio: 0.6 },
    },
    sidebarHidden: false,
    terminalHidden: false,
  } as Record<string, unknown>,
}));
vi.mock("../workspace", () => ({
  getState: () => ({ layout: layoutState.layout }),
  setLayout: (layout: Record<string, unknown>) => {
    layoutState.layout = layout;
  },
  saveState: () => Promise.resolve(),
}));

import type { DenContext } from "../core/registry";
import { init, openClaudeShell } from "./index";

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
  owner: { kind: "project"; id: string } | null,
): void {
  window.dispatchEvent(
    new CustomEvent("den:active-tab-changed", { detail: { tabId, cwd, owner } }),
  );
}

function dispatchOwnerRemoved(kind: "workspace" | "project", id: string): void {
  window.dispatchEvent(new CustomEvent("den:owner-removed", { detail: { kind, id } }));
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
    dispatchActiveTabChanged("tab-1", "/test/root-a", { kind: "project", id: "p-1" });

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
    dispatchActiveTabChanged("tab-1", "/test/switch-a", { kind: "project", id: "p-2" });
    dispatchActiveTabChanged("tab-2", "/test/switch-b", { kind: "project", id: "p-switch" });

    const groups = root.querySelectorAll(".den-terminal__group");
    expect(groups).toHaveLength(2);
    expect(groups[0].hasAttribute("hidden")).toBe(true);
    expect(groups[1].hasAttribute("hidden")).toBe(false);
  });

  it("revenir sur un groupe déjà créé le remontre sans re-spawner", () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/return-a", { kind: "project", id: "p-3" });
    dispatchActiveTabChanged("tab-2", "/test/return-b", { kind: "project", id: "p-return" });
    dispatchActiveTabChanged("tab-1", "/test/return-a", { kind: "project", id: "p-3" });

    expect(spawnCallsFor("/test/return-a")).toHaveLength(1);
    const groups = root.querySelectorAll(".den-terminal__group");
    expect(groups[0].hasAttribute("hidden")).toBe(false);
    expect(groups[1].hasAttribute("hidden")).toBe(true);
  });

  it("le bouton + crée un nouvel onglet shell dans le groupe visible, spawné dans le cwd du groupe", () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/plus-a", { kind: "project", id: "p-5" });

    const addButton = root.querySelector<HTMLButtonElement>(".den-terminal__add");
    expect(addButton).not.toBeNull();
    addButton!.click();

    expect(spawnCallsFor("/test/plus-a")).toHaveLength(2);
    expect(root.querySelectorAll(".den-terminal__tab")).toHaveLength(2);
    expect(root.querySelectorAll(".den-terminal__viewport")).toHaveLength(2);
  });

  it("la croix d'un onglet le ferme (pty_kill) et active un onglet voisin", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/close-a", { kind: "project", id: "p-6" });
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

  it("den:owner-removed d'un projet tue tous les onglets du groupe correspondant et le retire", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/owner-removed-p", { kind: "project", id: "p-remove" });
    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);
    await flushMicrotasks();

    invokeMock.mockClear();
    dispatchOwnerRemoved("project", "p-remove");

    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(0);
    expect(root.querySelectorAll(".den-terminal__tabs")).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { id: expect.any(Number) });
  });

  it("den:owner-removed de kind workspace est ignoré sans effet", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/owner-removed-ignored", { kind: "project", id: "p-ignored" });
    await flushMicrotasks();

    invokeMock.mockClear();
    dispatchOwnerRemoved("workspace", "p-ignored");

    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalledWith("pty_kill", expect.anything());
  });

  it("den:session-closed n'est plus écouté : le groupe du projet survit", () => {
    initIsolated(root);
    const owner = { kind: "project" as const, id: "p-survive" };
    dispatchActiveTabChanged("tab-1", "/test/session-closed-p", owner);

    window.dispatchEvent(
      new CustomEvent("den:session-closed", {
        detail: { tabId: "tab-1", owner, cwd: "/test/session-closed-p" },
      }),
    );

    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);
  });

  it("beforeunload tue les PTY de tous les onglets de tous les groupes", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/unload-a", { kind: "project", id: "p-7" });
    dispatchActiveTabChanged("tab-2", "/test/unload-b", { kind: "project", id: "p-unload" });
    await flushMicrotasks();

    invokeMock.mockClear();
    window.dispatchEvent(new Event("beforeunload"));

    const killCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "pty_kill");
    expect(killCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("terminal/index — fond opaque et attente des polices", () => {
  let root: HTMLElement;
  const docEl = document.documentElement;

  beforeEach(() => {
    invokeMock.mockClear();
    root = document.createElement("section");
  });

  afterEach(() => {
    for (const [target, type, listener] of trackedListeners) {
      target.removeEventListener(type, listener);
    }
    trackedListeners.length = 0;
    docEl.style.removeProperty("--den-terminal-bg");
    docEl.style.removeProperty("--den-bg-surface");
    delete (document as unknown as { fonts?: unknown }).fonts;
  });

  function lastBackground(): unknown {
    return (termInstances[termInstances.length - 1].options.theme as { background: string }).background;
  }

  it("fond : --den-terminal-bg prime sur --den-bg-surface", () => {
    docEl.style.setProperty("--den-terminal-bg", "#0a0916");
    docEl.style.setProperty("--den-bg-surface", "#111111");
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/bg-a", { kind: "project", id: "p-8" });
    expect(lastBackground()).toBe("#0a0916");
  });

  it("fond : repli sur --den-bg-surface puis #000000", () => {
    docEl.style.setProperty("--den-bg-surface", "#111111");
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/bg-b", { kind: "project", id: "p-9" });
    expect(lastBackground()).toBe("#111111");

    docEl.style.removeProperty("--den-bg-surface");
    dispatchActiveTabChanged("tab-2", "/test/bg-c", { kind: "project", id: "p-bg" });
    expect(lastBackground()).toBe("#000000");
  });

  it("sans document.fonts : spawn synchrone, comportement inchangé", () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/nofonts", { kind: "project", id: "p-10" });
    expect(spawnCallsFor("/test/nofonts")).toHaveLength(1);
  });

  it("avec document.fonts : aucun spawn avant la résolution de load(), puis ordre conservé", async () => {
    let resolveLoad!: () => void;
    const load = vi.fn(() => new Promise<void>((r) => (resolveLoad = r)));
    (document as unknown as { fonts: unknown }).fonts = { load };
    initIsolated(root);

    dispatchActiveTabChanged("tab-1", "/test/fonts-a", { kind: "project", id: "p-11" });
    dispatchActiveTabChanged("tab-2", "/test/fonts-b", { kind: "project", id: "p-fonts" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]).toEqual([expect.stringMatching(/^\d+px /)]);
    expect(spawnCallsFor("/test/fonts-a")).toHaveLength(0);

    resolveLoad();
    await flushMicrotasks();
    await flushMicrotasks();

    const order = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "pty_spawn")
      .map(([, args]) => (args as { cwd: string }).cwd);
    expect(order).toEqual(["/test/fonts-a", "/test/fonts-b"]);

    // Une fois la gate ouverte, les événements suivants sont synchrones.
    dispatchActiveTabChanged("tab-3", "/test/fonts-c", { kind: "project", id: "p-12" });
    expect(spawnCallsFor("/test/fonts-c")).toHaveLength(1);
  });

  it("load() qui rejette : la gate s'ouvre quand même (catch silencieux)", async () => {
    (document as unknown as { fonts: unknown }).fonts = {
      load: vi.fn(() => Promise.reject(new Error("boom"))),
    };
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/fonts-err", { kind: "project", id: "p-13" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(spawnCallsFor("/test/fonts-err")).toHaveLength(1);
  });

  it("load() qui ne se résout jamais : la gate s'ouvre au bout du délai", async () => {
    vi.useFakeTimers();
    try {
      (document as unknown as { fonts: unknown }).fonts = { load: vi.fn(() => new Promise<void>(() => {})) };
      initIsolated(root);
      dispatchActiveTabChanged("tab-1", "/test/fonts-hang", { kind: "project", id: "p-14" });
      expect(spawnCallsFor("/test/fonts-hang")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnCallsFor("/test/fonts-hang")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminal/index — openClaudeShell", () => {
  let root: HTMLElement;
  const claudeWrites = () =>
    invokeMock.mock.calls.filter(([cmd, args]) => cmd === "pty_write" && (args as { data?: string }).data === "claude\n");

  beforeEach(() => {
    invokeMock.mockClear();
    layoutState.layout = { ...layoutState.layout, terminalHidden: false };
    root = document.createElement("section");
  });

  afterEach(() => {
    for (const [target, type, listener] of trackedListeners) {
      target.removeEventListener(type, listener);
    }
    trackedListeners.length = 0;
    document.getElementById("den-app")?.remove();
  });

  it("rejette si le module n'est pas initialisé", async () => {
    vi.resetModules();
    const fresh = await import("./index");
    await expect(fresh.openClaudeShell({ owner: "x", cwd: "/x" })).rejects.toThrow(/non initialisé/);
  });

  it("crée un onglet actif et écrit claude\\n seulement après la résolution de ptyId", async () => {
    initIsolated(root);
    dispatchActiveTabChanged("tab-1", "/test/claude-a", { kind: "project", id: "pc-1" });
    await flushMicrotasks();
    invokeMock.mockClear();

    let resolveSpawn!: (id: number) => void;
    invokeMock.mockImplementationOnce(() => new Promise<number>((r) => (resolveSpawn = r)));
    const done = openClaudeShell({ owner: "pc-1", cwd: "/test/claude-a" });

    const tabs = root.querySelectorAll(".den-terminal__tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1].classList.contains("den-terminal__tab--active")).toBe(true);
    expect(claudeWrites()).toHaveLength(0);

    resolveSpawn(42);
    await done;
    expect(invokeMock).toHaveBeenCalledWith("pty_write", { id: 42, data: "claude\n" });
  });

  it("réaffiche le terminal masqué", async () => {
    const app = document.createElement("div");
    app.id = "den-app";
    document.body.appendChild(app);
    layoutState.layout = { ...layoutState.layout, terminalHidden: true };
    app.dataset.terminal = "hidden";

    initIsolated(root);
    await openClaudeShell({ owner: "pc-2", cwd: "/test/claude-b" });

    expect((layoutState.layout as { terminalHidden: boolean }).terminalHidden).toBe(false);
    expect(app.dataset.terminal).toBeUndefined();
  });

  it("réutilise le groupe d'un même owner", async () => {
    initIsolated(root);
    await openClaudeShell({ owner: "pc-3", cwd: "/test/claude-c" });
    await openClaudeShell({ owner: "pc-3", cwd: "/test/claude-c" });

    expect(root.querySelectorAll(".den-terminal__group")).toHaveLength(1);
    expect(root.querySelectorAll(".den-terminal__tab")).toHaveLength(3);
    expect(claudeWrites()).toHaveLength(2);
  });

  it("n'écrit rien et rejette si pty_spawn échoue", async () => {
    initIsolated(root);
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "pty_spawn" ? Promise.reject(new Error("nope")) : Promise.resolve(1),
    );
    try {
      await expect(openClaudeShell({ owner: "pc-4", cwd: "/test/claude-d" })).rejects.toThrow(/claude non lancé/);
      expect(claudeWrites()).toHaveLength(0);
    } finally {
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(1);
    }
  });
});
