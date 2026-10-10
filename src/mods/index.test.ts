// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Laisse le vrai pont se brancher mais en garde une référence pour piloter le client.
const captured = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("../markdown/conversationView", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../markdown/conversationView")>();
  return {
    ...orig,
    setModBridge: (b: Parameters<typeof orig.setModBridge>[0]) => {
      captured.bridge = b;
      orig.setModBridge(b);
    },
  };
});

import type { DenContext } from "../core/registry";
import { ConversationView, setModBridge } from "../markdown/conversationView";
import type { ConversationMessage } from "../types/protocol";
import type { ModRenderClient, RenderTreeFn } from "./contracts";
import { createModsModule, getModRenderClient } from "./index";
import type { ModPaneClient, RenderOptions } from "./contracts";

const fakeRenderTree: RenderTreeFn = (node) => {
  const el = document.createElement("div");
  el.className = "fake-tree";
  el.textContent = JSON.stringify(node);
  return el;
};

function makeCtx(): DenContext {
  const mk = () => document.createElement("div");
  return { mounts: { sidebar: mk(), conversation: mk(), terminal: mk(), status: mk() } };
}

function dispatch(tabId: string, message: unknown): void {
  window.dispatchEvent(new CustomEvent("den:session-message", { detail: { tabId, message } }));
}

function activate(tabId: string | null): void {
  window.dispatchEvent(
    new CustomEvent("den:active-tab-changed", { detail: { tabId, cwd: null, owner: null } }),
  );
}

function sentRenders(): { tabId: string; msg: Record<string, unknown> }[] {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "sidecar_send")
    .map((c) => {
      const a = c[1] as { tabId: string; message: string };
      return { tabId: a.tabId, msg: JSON.parse(a.message) as Record<string, unknown> };
    })
    .filter((s) => s.msg.type === "mod_render");
}

const lastRender = () => sentRenders().at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

const openShell = vi.fn().mockResolvedValue(undefined);

function sent(type: string): { tabId: string; msg: Record<string, unknown> }[] {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "sidecar_send")
    .map((c) => {
      const a = c[1] as { tabId: string; message: string };
      return { tabId: a.tabId, msg: JSON.parse(a.message) as Record<string, unknown> };
    })
    .filter((x) => x.msg.type === type);
}

const REQ = { component: "AssistantMessage" as const, instanceId: "m1", props: { text: "x" } };
const OK_TREE = { type: "Box", children: ["hi"] };

let ctx: DenContext;
let client: ModRenderClient;

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockClear();
  document.body.replaceChildren();
  ctx = makeCtx();
  openShell.mockClear();
  createModsModule({ renderTree: fakeRenderTree, openClaudeShell: openShell }).init(ctx);
  client = (captured.bridge as { client: ModRenderClient }).client;
});

afterEach(() => {
  setModBridge(null);
  vi.useRealTimers();
});

describe("mods/index — ModRenderClient", () => {
  it("envoie mod_render et résout sur le mod_tree portant le même requestId", async () => {
    const p1 = client.requestRender("t1", REQ);
    const p2 = client.requestRender("t1", { ...REQ, instanceId: "m2" });
    const [r1, r2] = sentRenders();
    expect(r1.msg).toMatchObject({ type: "mod_render", component: "AssistantMessage", instanceId: "m1" });
    expect(r1.msg.requestId).not.toBe(r2.msg.requestId);

    dispatch("t1", { type: "mod_tree", requestId: r2.msg.requestId, tree: "deux", hooked: true, rewritten: true });
    dispatch("t1", { type: "mod_tree", requestId: r1.msg.requestId, tree: OK_TREE, hooked: true, rewritten: false });
    await expect(p1).resolves.toEqual({ tree: OK_TREE, hooked: true, rewritten: false });
    await expect(p2).resolves.toEqual({ tree: "deux", hooked: true, rewritten: true });
  });

  it("rend non-hooké après 5 s sans réponse, et ignore la réponse tardive", async () => {
    const p = client.requestRender("t1", REQ);
    const { msg } = lastRender();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ tree: null, hooked: false, rewritten: false });
    expect(() =>
      dispatch("t1", { type: "mod_tree", requestId: msg.requestId, tree: OK_TREE, hooked: true, rewritten: true }),
    ).not.toThrow();
  });

  it("traite un arbre invalide comme non-hooké", async () => {
    const p = client.requestRender("t1", REQ);
    dispatch("t1", {
      type: "mod_tree",
      requestId: lastRender().msg.requestId,
      tree: { type: "Box", children: "pas-un-tableau" },
      hooked: true,
      rewritten: true,
    });
    await expect(p).resolves.toEqual({ tree: null, hooked: false, rewritten: false });
  });

  it("rend non-hooké si l'envoi au sidecar échoue", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await expect(client.requestRender("t1", REQ)).resolves.toEqual({
      tree: null,
      hooked: false,
      rewritten: false,
    });
  });
});

describe("mods/index — chrome", () => {
  it("affiche le statut par plugin, en place, pour le tab actif seulement", () => {
    activate("t1");
    dispatch("t1", { type: "mod_status", plugin: "a", text: "un" });
    dispatch("t2", { type: "mod_status", plugin: "b", text: "autre tab" });
    const els = () => [...ctx.mounts.status.querySelectorAll<HTMLElement>("[data-mod-plugin]")];
    expect(els().map((e) => e.dataset.modPlugin)).toEqual(["a"]);

    const first = els()[0];
    dispatch("t1", { type: "mod_status", plugin: "a", text: "deux" });
    expect(els()[0]).toBe(first);
    expect(first.textContent).toBe("deux");

    activate("t2");
    expect(els().map((e) => e.dataset.modPlugin)).toEqual(["b"]);
    activate("t1");
    expect(els().map((e) => e.textContent)).toEqual(["deux"]);
  });

  it("retire le statut d'un plugin quand son texte devient vide", () => {
    activate("t1");
    dispatch("t1", { type: "mod_status", plugin: "a", text: "x" });
    dispatch("t1", { type: "mod_status", plugin: "a", text: "" });
    expect(ctx.mounts.status.querySelectorAll("[data-mod-plugin]")).toHaveLength(0);
  });

  it("route mod_toast vers un toast", () => {
    dispatch("t1", { type: "mod_toast", plugin: "a", text: "coucou", timeoutMs: 2000 });
    expect(document.body.querySelector(".den-toast")?.textContent).toBe("coucou");
  });

  it("affiche un seul bandeau dismissible pour mods_unavailable", () => {
    dispatch("t1", { type: "mods_unavailable", reason: "claude introuvable" });
    dispatch("t2", { type: "mods_unavailable", reason: "claude introuvable" });
    const banners = ctx.mounts.conversation.querySelectorAll(".den-mods-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toContain("claude introuvable");
    (banners[0].querySelector("button") as HTMLButtonElement).click();
    expect(ctx.mounts.conversation.querySelectorAll(".den-mods-banner")).toHaveLength(0);
    dispatch("t1", { type: "mods_unavailable", reason: "encore" });
    expect(ctx.mounts.conversation.querySelectorAll(".den-mods-banner")).toHaveLength(0);
  });

  it("re-dispatch mod_panes et mod_invalidate avec le tabId", () => {
    const panes = vi.fn();
    const inval = vi.fn();
    window.addEventListener("den:mod-panes", panes);
    window.addEventListener("den:mod-invalidate", inval);
    dispatch("t1", { type: "mod_panes", panes: [], shownId: null, focusedId: null });
    dispatch("t1", { type: "mod_invalidate", instances: [{ component: "Pane", instanceId: "p1" }] });
    expect((panes.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ tabId: "t1", panes: [] });
    expect((inval.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      tabId: "t1",
      instances: [{ component: "Pane", instanceId: "p1" }],
    });
    window.removeEventListener("den:mod-panes", panes);
    window.removeEventListener("den:mod-invalidate", inval);
  });
});

describe("mods/index — pont conversationView", () => {
  function streamAssistant(view: ConversationView, id = "m1"): HTMLElement {
    view.handleMessage({ type: "assistant_delta", id, text: "Bon" } as ConversationMessage);
    view.handleMessage({ type: "assistant_delta", id, text: "jour" } as ConversationMessage);
    view.handleMessage({ type: "done" } as ConversationMessage);
    return view.el.querySelector(`.den-msg-assistant[data-msg-id="${id}"]`) as HTMLElement;
  }

  function reply(tree: unknown, hooked: boolean, i = -1): void {
    dispatch("tab-1", {
      type: "mod_tree",
      requestId: sentRenders().at(i)!.msg.requestId,
      tree,
      hooked,
      rewritten: hooked,
    });
  }

  it("demande le rendu avec le texte complet cumulé et isFirstOfReply", () => {
    const view = new ConversationView("tab-1");
    streamAssistant(view, "m1");
    expect(lastRender().msg).toMatchObject({
      component: "AssistantMessage",
      instanceId: "m1",
      props: { text: "Bonjour", isFirstOfReply: true },
    });
    streamAssistant(view, "m2");
    expect(lastRender().msg.props).toMatchObject({ isFirstOfReply: false });
    view.handleMessage({ type: "user_echo", text: "suite" } as ConversationMessage);
    streamAssistant(view, "m3");
    expect(lastRender().msg.props).toMatchObject({ isFirstOfReply: true });
  });

  it("remplace le contenu du bloc quand hooked avec un arbre valide", async () => {
    const view = new ConversationView("tab-1");
    const block = streamAssistant(view);
    reply(OK_TREE, true);
    await flush();
    expect(block.children).toHaveLength(1);
    expect(block.querySelector(".fake-tree")).not.toBeNull();
    expect(block.querySelector(".den-msg-finalized")).toBeNull();
  });

  it.each([
    ["non-hooké", null, false],
    ["engine", { type: "engine", ref: 0 }, true],
    ["invalide", { type: "Box", children: 42 }, true],
  ])("laisse le bloc inchangé quand %s", async (_label, tree, hooked) => {
    const view = new ConversationView("tab-1");
    const block = streamAssistant(view);
    reply(tree, hooked);
    await flush();
    expect(block.querySelector(".den-msg-finalized")).not.toBeNull();
    expect(block.querySelector(".fake-tree")).toBeNull();
    expect(block.textContent).toContain("Bonjour");
  });

  it("ignore la réponse si le bloc a disparu (conversation_reset)", async () => {
    const view = new ConversationView("tab-1");
    const block = streamAssistant(view);
    view.handleMessage({ type: "conversation_reset" } as ConversationMessage);
    reply(OK_TREE, true);
    await flush();
    expect(view.el.contains(block)).toBe(false);
    expect(block.querySelector(".fake-tree")).toBeNull();
    expect(view.el.querySelector(".fake-tree")).toBeNull();
  });

  it("réécrit un ToolResult hooké avec le nom de l'outil retenu", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "tool_use", id: "t", toolUseId: "u1", name: "Bash", input: {} } as ConversationMessage);
    view.handleMessage({ type: "tool_result", id: "t", toolUseId: "u1", output: "ok", isError: false } as ConversationMessage);
    expect(lastRender().msg).toMatchObject({
      component: "ToolResult",
      instanceId: "u1",
      props: { tool_use_id: "u1", tool: "Bash", output: "ok", isErrored: false },
    });
    reply(OK_TREE, true);
    await flush();
    const res = view.el.querySelector(".den-tool-result") as HTMLElement;
    expect(res.querySelector(".fake-tree")).not.toBeNull();
    expect(res.querySelector("pre")).toBeNull();
  });

  it("laisse un ToolResult inchangé quand non-hooké", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "tool_use", id: "t", toolUseId: "u1", name: "Bash", input: {} } as ConversationMessage);
    view.handleMessage({ type: "tool_result", id: "t", toolUseId: "u1", output: "ok", isError: false } as ConversationMessage);
    reply(null, false);
    await flush();
    expect(view.el.querySelector(".den-tool-result pre")).not.toBeNull();
  });

  it("retire le pont à mods_unavailable : plus aucune demande n'est envoyée", () => {
    dispatch("tab-1", { type: "mods_unavailable", reason: "claude introuvable" });
    invokeMock.mockClear();
    streamAssistant(new ConversationView("tab-1"));
    expect(sentRenders()).toHaveLength(0);
  });

  it("sans pont, aucune demande n'est envoyée", () => {
    setModBridge(null);
    invokeMock.mockClear();
    streamAssistant(new ConversationView("tab-1"));
    expect(sentRenders()).toHaveLength(0);
  });
});

type Bridge = { options: (tabId: string, origin?: unknown) => RenderOptions; renderTree: unknown };
const bridge = () => captured.bridge as Bridge;
const PRESS = { plugin: "p", handle: 7 };

describe("mods/index — getModRenderClient et paneAction", () => {
  it("expose le client après init", () => {
    const c = getModRenderClient();
    expect(c).not.toBeNull();
    expect(typeof (c as ModPaneClient).paneAction).toBe("function");
  });

  it("paneAction envoie mod_pane_action et résout sur le mod_result de même requestId", async () => {
    const c = getModRenderClient()!;
    const p = c.paneAction("t1", { action: "show", id: "p1" });
    const { msg, tabId } = sent("mod_pane_action")[0];
    expect(tabId).toBe("t1");
    expect(msg).toMatchObject({ action: "show", id: "p1" });
    dispatch("t1", { type: "mod_result", requestId: "autre", handled: false });
    dispatch("t1", { type: "mod_result", requestId: msg.requestId, handled: true, value: "p1" });
    await expect(p).resolves.toEqual({ handled: true, value: "p1" });
  });

  it("paneAction résout handled:false avec erreur après 10 s", async () => {
    const p = getModRenderClient()!.paneAction("t1", { action: "roster" });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.handled).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("mods/index — interactions", () => {
  const toastText = () => document.body.querySelector(".den-toast")?.textContent;

  it("onPress envoie mod_press et reste muet si handled", async () => {
    bridge().options("t1").onPress!(PRESS, "k", "http://x");
    const { msg } = sent("mod_press")[0];
    expect(msg).toMatchObject({ ...PRESS, key: "k", href: "http://x" });
    dispatch("t1", { type: "mod_result", requestId: msg.requestId, handled: true });
    await flush();
    expect(toastText()).toBeUndefined();
  });

  it("toast d'erreur quand handled:false ou error", async () => {
    bridge().options("t1").onPress!(PRESS);
    dispatch("t1", { type: "mod_result", requestId: sent("mod_press")[0].msg.requestId, handled: false, error: "boom" });
    await flush();
    expect(toastText()).toBe("Action du mod impossible : boom");
  });

  it("pas de toast quand le mod ne gère pas l'action (handled:false sans erreur)", async () => {
    bridge().options("t1").onInput!(PRESS, "change", "a");
    dispatch("t1", { type: "mod_result", requestId: sent("mod_input")[0].msg.requestId, handled: false });
    await flush();
    expect(toastText()).toBeUndefined();
  });

  it("toast quand l'ouverture du terminal échoue", async () => {
    openShell.mockRejectedValueOnce(new Error("aucun dossier de projet"));
    bridge().options("t1").openTerminal!();
    await flush();
    expect(toastText()).toBe("Impossible d'ouvrir le terminal : aucun dossier de projet");
  });

  it("press attend 120 s, input/select 10 s", async () => {
    const o = bridge().options("t1");
    o.onPress!(PRESS);
    o.onInput!(PRESS, "submit", "v");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(document.body.querySelectorAll(".den-toast")).toHaveLength(1);
    document.body.querySelector(".den-toasts")!.replaceChildren();
    await vi.advanceTimersByTimeAsync(110_000);
    expect(document.body.querySelectorAll(".den-toast")).toHaveLength(1);
  });

  it("onInput/onSelect portent component et instanceId de l'origine", () => {
    const o = bridge().options("t1", { component: "ToolResult", instanceId: "u1" });
    o.onInput!(PRESS, "change", "abc", "k");
    o.onSelect!(PRESS, "val");
    expect(sent("mod_input")[0].msg).toMatchObject({ value: "abc", component: "ToolResult", instanceId: "u1" });
    expect(sent("mod_select")[0].msg).toMatchObject({ value: "val", component: "ToolResult", instanceId: "u1" });
  });

  it("openTerminal utilise owner et cwd du tab retenus", () => {
    window.dispatchEvent(
      new CustomEvent("den:active-tab-changed", { detail: { tabId: "t1", cwd: "/w", owner: "me" } }),
    );
    bridge().options("t1").openTerminal!();
    expect(openShell).toHaveBeenCalledWith({ owner: "me", cwd: "/w" });
  });

  it("onUnsupported dédoublonne par tab et par type", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const o = bridge().options("t1");
    o.onUnsupported!("Svg");
    o.onUnsupported!("Svg");
    o.onUnsupported!("Image");
    bridge().options("t2").onUnsupported!("Svg");
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("mods/index — copie, événements, statut", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function mockClipboard(writeText: (t: string) => Promise<void>): void {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  }

  it("mod_copy_request écrit dans le presse-papiers puis répond copied:true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    dispatch("t1", { type: "mod_copy_request", requestId: "r1", text: "salut" });
    await flush();
    expect(writeText).toHaveBeenCalledWith("salut");
    expect(sent("mod_copy_result")[0]).toMatchObject({ tabId: "t1", msg: { requestId: "r1", copied: true } });
  });

  it.each([
    ["rejette", () => mockClipboard(() => Promise.reject(new Error("no")))],
    ["est absente", () => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })],
  ])("mod_copy_request répond copied:false quand l'API %s", async (_l, setup) => {
    setup();
    dispatch("t1", { type: "mod_copy_request", requestId: "r2", text: "x" });
    await flush();
    expect(sent("mod_copy_result")[0].msg).toMatchObject({ requestId: "r2", copied: false });
  });

  it("le detail des événements ne contient pas type", () => {
    const details: Record<string, unknown>[] = [];
    const h = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener("den:mod-panes", h);
    window.addEventListener("den:mod-invalidate", h);
    dispatch("t1", { type: "mod_panes", panes: [], shownId: null, focusedId: null });
    dispatch("t1", { type: "mod_invalidate", instances: [] });
    window.removeEventListener("den:mod-panes", h);
    window.removeEventListener("den:mod-invalidate", h);
    expect(details).toHaveLength(2);
    for (const d of details) expect("type" in d).toBe(false);
  });

  it("purge le statut d'un tab à session-closed", () => {
    activate("t1");
    dispatch("t1", { type: "mod_status", plugin: "a", text: "un" });
    window.dispatchEvent(new CustomEvent("den:session-closed", { detail: { tabId: "t1" } }));
    expect(ctx.mounts.status.querySelectorAll("[data-mod-plugin]")).toHaveLength(0);
    activate("t1");
    expect(ctx.mounts.status.querySelectorAll("[data-mod-plugin]")).toHaveLength(0);
  });

  it("lit l'onglet actif au montage quand l'événement a précédé l'init", () => {
    const fresh = makeCtx();
    const view = document.createElement("div");
    view.className = "den-conversation-tab";
    view.dataset.tabId = "t9";
    fresh.mounts.conversation.appendChild(view);
    createModsModule({ renderTree: fakeRenderTree }).init(fresh);
    dispatch("t9", { type: "mod_status", plugin: "a", text: "visible" });
    expect(fresh.mounts.status.querySelector("[data-mod-plugin]")?.textContent).toBe("visible");
  });
});

describe("mods/index — cache, invalidate, renderEngineDefault", () => {
  // Les vues ne se désabonnent jamais de window : un tab neuf par test évite les échos des vues précédentes.
  let tabId = "";
  let seq = 0;
  beforeEach(() => {
    tabId = `inv-${++seq}`;
  });
  function replyLast(tree: unknown, hooked = true): void {
    dispatch("tab-1", {
      type: "mod_tree",
      requestId: sentRenders().at(-1)!.msg.requestId,
      tree,
      hooked,
      rewritten: hooked,
    });
  }
  function toolResult(view: ConversationView, extra: object = {}): void {
    view.handleMessage({ type: "tool_use", id: "t", toolUseId: "u1", name: "Read", input: {} } as ConversationMessage);
    view.handleMessage({
      type: "tool_result", id: "t", toolUseId: "u1", output: "texte", isError: false, ...extra,
    } as ConversationMessage);
  }
  const invalidate = (instances: object[]) =>
    window.dispatchEvent(new CustomEvent("den:mod-invalidate", { detail: { tabId, instances } }));

  it("envoie structured ?? output dans les props du ToolResult", () => {
    const structured = { type: "text", file: { filePath: "/a" } };
    toolResult(new ConversationView(tabId), { structured });
    expect(lastRender().msg.props).toMatchObject({ output: structured });
  });

  it("garde output quand structured est absent", () => {
    toolResult(new ConversationView(tabId));
    expect(lastRender().msg.props).toMatchObject({ output: "texte" });
  });

  it("redemande le rendu avec les props en cache sur invalidate et remplace le contenu", async () => {
    const view = new ConversationView(tabId);
    toolResult(view, { structured: { s: 1 } });
    replyLast(OK_TREE);
    await flush();
    const before = sentRenders().length;
    invalidate([{ component: "ToolResult", instanceId: "u1" }, { component: "ToolResult", instanceId: "inconnu" }]);
    expect(sentRenders()).toHaveLength(before + 1);
    expect(lastRender().msg).toMatchObject({
      component: "ToolResult", instanceId: "u1", props: { output: { s: 1 }, tool: "Read", isErrored: false },
    });
    replyLast({ type: "Box", children: ["v2"] });
    await flush();
    expect(view.el.querySelector(".fake-tree")?.textContent).toContain("v2");
  });

  it("ignore l'invalidate d'un autre tab ou après conversation_reset", () => {
    const view = new ConversationView(tabId);
    toolResult(view);
    const n = sentRenders().length;
    window.dispatchEvent(new CustomEvent("den:mod-invalidate", {
      detail: { tabId: "autre", instances: [{ component: "ToolResult", instanceId: "u1" }] },
    }));
    view.handleMessage({ type: "conversation_reset" } as ConversationMessage);
    invalidate([{ component: "ToolResult", instanceId: "u1" }]);
    expect(sentRenders()).toHaveLength(n);
  });

  it("renderEngineDefault(0) rend l'original : Box[engine(0), Text] le garde", async () => {
    const view = new ConversationView(tabId);
    // renderTree réel de l'hôte simulé : résout engine(0) via les options.
    setModBridge({
      ...(captured.bridge as Record<string, unknown>),
      renderTree: (node: unknown, opts?: RenderOptions) => {
        const box = document.createElement("div");
        box.className = "box";
        const kids = (node as { children: unknown[] }).children;
        for (const k of kids) {
          if (typeof k === "object" && (k as { type: string }).type === "engine") {
            const n = opts?.renderEngineDefault?.(0);
            if (n) box.appendChild(n);
          } else box.append(String(k));
        }
        return box;
      },
    } as unknown as Parameters<typeof setModBridge>[0]);
    toolResult(view);
    replyLast({ type: "Box", children: [{ type: "engine", ref: 0 }, "décor"] });
    await flush();
    const box = view.el.querySelector(".den-tool-result .box") as HTMLElement;
    expect(box.textContent).toContain("texte");
    expect(box.textContent).toContain("décor");
    expect(box.querySelector("pre")).not.toBeNull();
  });
});
