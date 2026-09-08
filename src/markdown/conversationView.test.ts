// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ConversationView } from "./conversationView";
import type {
  AssistantDelta,
  ConversationReset,
  Done,
  ErrorMessage,
  ToolResult,
  ToolUse,
  UserEcho,
} from "../types/protocol";

/** Attend le prochain requestAnimationFrame planifié par la vue (rendu du bloc courant). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("ConversationView", () => {
  it("route les assistant_delta partageant le même id dans un seul bloc de message", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "Bonjour" } as AssistantDelta);
    view.handleMessage({ type: "assistant_delta", id: "m1", text: " le monde" } as AssistantDelta);
    await nextFrame();

    const blocks = view.el.querySelectorAll(".den-msg-assistant");
    expect(blocks).toHaveLength(1);
    expect(view.el.textContent).toContain("Bonjour le monde");
  });

  it("démarre un nouveau bloc quand l'id du message assistant change", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "Premier message." } as AssistantDelta);
    view.handleMessage({ type: "assistant_delta", id: "m2", text: "Second message." } as AssistantDelta);
    await nextFrame();

    const blocks = view.el.querySelectorAll(".den-msg-assistant");
    expect(blocks).toHaveLength(2);
  });

  it("rend un tool_use en bloc repliable <details> et y attache le tool_result correspondant", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "tool_use",
      id: "turn-1",
      toolUseId: "toolu-1",
      name: "Read",
      input: { file_path: "/tmp/x.ts" },
    } as ToolUse);

    const details = view.el.querySelector("details.den-tool-block");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain("Read");
    expect(details?.querySelector(".den-tool-result")).toBeNull();

    view.handleMessage({
      type: "tool_result",
      id: "turn-1",
      toolUseId: "toolu-1",
      output: { content: "ok" },
    } as ToolResult);

    expect(details?.querySelector(".den-tool-result")).not.toBeNull();
    expect(details?.classList.contains("den-tool-block-error")).toBe(false);
  });

  it("marque le bloc tool en erreur quand tool_result.isError est vrai", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "tool_use",
      id: "turn-err",
      toolUseId: "toolu-err",
      name: "Bash",
      input: { command: "false" },
    } as ToolUse);
    view.handleMessage({
      type: "tool_result",
      id: "turn-err",
      toolUseId: "toolu-err",
      output: { stderr: "boom" },
      isError: true,
    } as ToolResult);

    const details = view.el.querySelector('details[data-tool-id="turn-err"]');
    expect(details?.classList.contains("den-tool-block-error")).toBe(true);
    expect(details?.querySelector(".den-tool-result-error")).not.toBeNull();
  });

  it("apparie tool_use/tool_result par toolUseId (bloc SDK), pas par id (tour) — cf. bug DEN-10", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "tool_use",
      id: "turn-1",
      toolUseId: "toolu_1",
      name: "Read",
      input: { file_path: "/tmp/x.ts" },
    } as ToolUse);
    view.handleMessage({
      type: "tool_result",
      id: "turn-1",
      toolUseId: "toolu_1",
      output: { content: "ok" },
    } as ToolResult);

    const details = view.el.querySelector("details.den-tool-block");
    expect(details).not.toBeNull();
    expect(details?.querySelector(".den-tool-result")).not.toBeNull();
    expect(view.el.querySelectorAll(".den-tool-block-orphan")).toHaveLength(0);
  });

  it("affiche un tool_result orphelin (sans tool_use préalable) plutôt que de le perdre", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "tool_result",
      id: "res-orphan",
      toolUseId: "tool-never-seen",
      output: { note: "orphelin" },
    } as ToolResult);

    const orphan = view.el.querySelector(".den-tool-block-orphan");
    expect(orphan).not.toBeNull();
    expect(orphan?.textContent).toContain("orphelin");
  });

  it("finalise le message assistant en cours à la réception de done", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "En cours" } as AssistantDelta);
    view.handleMessage({ type: "done", sessionId: "s1" } as Done);
    await nextFrame();

    const finalizedEl = view.el.querySelector(".den-msg-finalized");
    expect(finalizedEl?.textContent).toContain("En cours");
    const currentEl = view.el.querySelector(".den-msg-current");
    expect(currentEl?.innerHTML).toBe("");
  });

  it("rend un bloc d'erreur visible", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "error",
      message: "Panne du sidecar",
      recoverable: false,
    } as ErrorMessage);

    const errorEl = view.el.querySelector(".den-error-block");
    expect(errorEl?.textContent).toContain("Panne du sidecar");
  });

  it("mountCustomBlock retourne un élément inséré dans le flux, jamais réécrit ensuite", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "avant" } as AssistantDelta);

    const content = view.mountCustomBlock({ id: "blk-1", kind: "demo", payload: {} });
    content.textContent = "UI custom montée par l'appelant";

    const wrapper = view.el.querySelector('.den-custom-block[data-block-id="blk-1"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute("data-block-kind")).toBe("demo");

    // Un nouveau message assistant après le bloc custom ne doit pas l'altérer.
    view.handleMessage({ type: "assistant_delta", id: "m2", text: "après" } as AssistantDelta);
    expect(content.textContent).toBe("UI custom montée par l'appelant");
  });

  it("reste collé en bas par défaut, et s'arrête d'auto-scroller si l'utilisateur remonte", () => {
    const view = new ConversationView("tab-1");
    // happy-dom ne calcule pas de vraie mise en page : on simule les
    // dimensions de scroll pour exercer la logique de collage au bas.
    Object.defineProperty(view.el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(view.el, "clientHeight", { value: 200, configurable: true });
    let scrollTop = 800; // déjà en bas
    Object.defineProperty(view.el, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });

    view.handleMessage({ type: "error", message: "1" } as ErrorMessage);
    expect(scrollTop).toBe(1000); // auto-scroll appliqué

    // L'utilisateur remonte manuellement.
    scrollTop = 0;
    view.el.dispatchEvent(new Event("scroll"));

    view.handleMessage({ type: "error", message: "2" } as ErrorMessage);
    expect(scrollTop).toBe(0); // plus d'auto-scroll tant que l'utilisateur ne redescend pas
  });

  it("conversation_reset vide le fil, et un assistant_delta suivant crée un bloc neuf", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "avant reset" } as AssistantDelta);
    view.handleMessage({
      type: "tool_use",
      id: "turn-1",
      toolUseId: "toolu-1",
      name: "Read",
      input: {},
    } as ToolUse);

    view.handleMessage({
      type: "conversation_reset",
      sessionId: "s1",
      newConversationId: "c2",
    } as ConversationReset);

    const flow = view.el.querySelector(".den-conversation-flow");
    expect(flow?.children).toHaveLength(0);

    view.handleMessage({ type: "assistant_delta", id: "m2", text: "après reset" } as AssistantDelta);
    await nextFrame();

    const blocks = view.el.querySelectorAll(".den-msg-assistant");
    expect(blocks).toHaveLength(1);
    expect(view.el.textContent).toContain("après reset");
    expect(view.el.textContent).not.toContain("avant reset");
  });

  // --- Spinner de lifecycle (den:tab-state-changed) ---

  it("den:tab-state-changed pour ce tabId affiche le spinner avec le bon texte, et le masque hors running/waiting", () => {
    const view = new ConversationView("tab-1");
    const thinking = view.el.querySelector(".den-thinking") as HTMLElement;
    expect(thinking).not.toBeNull();
    expect(thinking.hidden).toBe(true); // masqué par défaut

    window.dispatchEvent(
      new CustomEvent("den:tab-state-changed", { detail: { tabId: "tab-1", state: "running" } }),
    );
    expect(thinking.hidden).toBe(false);
    expect(thinking.textContent).toBe("réfléchit…");

    window.dispatchEvent(
      new CustomEvent("den:tab-state-changed", { detail: { tabId: "tab-1", state: "waiting" } }),
    );
    expect(thinking.hidden).toBe(false);
    expect(thinking.textContent).toBe("attend ta réponse");

    window.dispatchEvent(
      new CustomEvent("den:tab-state-changed", { detail: { tabId: "tab-1", state: "idle" } }),
    );
    expect(thinking.hidden).toBe(true);
  });

  it("den:tab-state-changed pour un AUTRE tabId ne change rien", () => {
    const view = new ConversationView("tab-1");
    const thinking = view.el.querySelector(".den-thinking") as HTMLElement;

    window.dispatchEvent(
      new CustomEvent("den:tab-state-changed", { detail: { tabId: "tab-2", state: "running" } }),
    );

    expect(thinking.hidden).toBe(true);
    expect(thinking.textContent).toBe("");
  });

  // --- Copier (D8) ---

  it("un fence de code fermé produit autant de .den-copy que de .den-code", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "assistant_delta",
      id: "m1",
      text: "```ts\nconst a = 1;\n```\n\nsuite",
    } as AssistantDelta);
    await nextFrame();

    const codeBlocks = view.el.querySelectorAll(".den-code");
    const copyButtons = view.el.querySelectorAll(".den-code > .den-copy");
    expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(copyButtons.length).toBe(codeBlocks.length);
  });

  it("clic sur .den-copy d'un bloc de code copie le textContent du <code> qui le suit", async () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "assistant_delta",
      id: "m1",
      text: "```ts\nconst a = 1;\n```\n\nsuite",
    } as AssistantDelta);
    await nextFrame();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const button = view.el.querySelector(".den-code > .den-copy");
    expect(button).not.toBeNull();
    (button as HTMLButtonElement).click();

    expect(writeText).toHaveBeenCalledWith("const a = 1;");
  });

  it("tool_use rend un .den-copy dans .den-tool-input", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "tool_use",
      id: "turn-1",
      toolUseId: "toolu-1",
      name: "Read",
      input: { file_path: "/tmp/x.ts" },
    } as ToolUse);

    expect(view.el.querySelector(".den-tool-input .den-copy")).not.toBeNull();
  });

  it("user_echo rend un .den-copy et le texte exact dans .den-msg-user__text", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "user_echo", id: "u1", text: "Bonjour Claude" } as UserEcho);

    expect(view.el.querySelector(".den-msg-user .den-copy")).not.toBeNull();
    expect(view.el.querySelector(".den-msg-user__text")?.textContent).toBe(
      "Bonjour Claude",
    );
  });

  // --- Éditer (D5) ---

  it("user_echo rend aussi un .den-edit, sans polluer le texte de .den-msg-user__text", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "user_echo", id: "u1", text: "Bonjour Claude" } as UserEcho);

    expect(view.el.querySelector(".den-msg-user .den-edit")).not.toBeNull();
    expect(view.el.querySelector(".den-msg-user__text")?.textContent).toBe(
      "Bonjour Claude",
    );
  });

  it("clic sur .den-edit émet den:edit-prompt avec le tabId et le texte exact (retours à la ligne compris)", () => {
    const view = new ConversationView("tab-1");
    const text = "Ligne 1\nLigne 2";
    view.handleMessage({ type: "user_echo", id: "u1", text } as UserEcho);

    const handler = vi.fn();
    window.addEventListener("den:edit-prompt", handler);
    try {
      const button = view.el.querySelector(".den-edit");
      expect(button).not.toBeNull();
      (button as HTMLButtonElement).click();

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as CustomEvent<{ tabId: string; text: string }>;
      expect(event.detail).toEqual({ tabId: "tab-1", text });
    } finally {
      window.removeEventListener("den:edit-prompt", handler);
    }
  });

  it("clic sur .den-copy d'une bulle user copie toujours le texte exact (convention nextElementSibling intacte)", () => {
    const view = new ConversationView("tab-1");
    const text = "Ligne 1\nLigne 2";
    view.handleMessage({ type: "user_echo", id: "u1", text } as UserEcho);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const button = view.el.querySelector(".den-msg-user .den-copy");
    expect(button).not.toBeNull();
    (button as HTMLButtonElement).click();

    expect(writeText).toHaveBeenCalledWith(text);
  });

  // --- Stick-to-bottom : direction (cf. bug 05/09) ---

  it("décroche immédiatement au moindre remontée, même sans atteindre le bas au bloc suivant", () => {
    const view = new ConversationView("tab-1");
    Object.defineProperty(view.el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(view.el, "clientHeight", { value: 400, configurable: true });
    let scrollTop = 1000; // déjà collé en bas
    Object.defineProperty(view.el, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });

    // L'utilisateur remonte.
    scrollTop = 300;
    view.el.dispatchEvent(new Event("scroll"));

    // Un bloc qui se finalise pendant qu'on est décroché ne doit pas
    // ramener le fil en bas (bug 05/09 : l'ancien seuil de 32px n'était
    // jamais atteint quand le fil grandit plus vite que le scroll utilisateur).
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "Premier paragraphe." } as AssistantDelta);
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "\n\nSecond paragraphe" } as AssistantDelta);
    expect(scrollTop).toBe(300);

    // L'utilisateur redescend à une distance de 100px du bas (< 120) : ça
    // raccroche avant même d'atteindre le bas exact.
    scrollTop = 500;
    view.el.dispatchEvent(new Event("scroll"));

    view.handleMessage({ type: "assistant_delta", id: "m1", text: "\n\nTroisième paragraphe" } as AssistantDelta);
    expect(scrollTop).toBe(1000);
  });

  it("un contenu qui rétrécit (spinner masqué) rabaisse scrollTop sans décrocher — régression grill 2 du 05/09", () => {
    const view = new ConversationView("tab-1");
    let scrollHeight = 1000;
    Object.defineProperty(view.el, "scrollHeight", { get: () => scrollHeight, configurable: true });
    Object.defineProperty(view.el, "clientHeight", { value: 400, configurable: true });
    let scrollTop = 600; // collé en bas (1000 - 400)
    Object.defineProperty(view.el, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });

    // Le contenu rétrécit de 20px : le navigateur rabaisse scrollTop au
    // nouveau maximum et émet un `scroll` — ce n'est PAS une remontée.
    scrollHeight = 980;
    scrollTop = 580;
    view.el.dispatchEvent(new Event("scroll"));

    // Toujours collé : le prochain bloc finalisé ramène le fil en bas.
    scrollHeight = 1200;
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "Un paragraphe." } as AssistantDelta);
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "\n\nUn autre" } as AssistantDelta);
    expect(scrollTop).toBe(1200);

    // Une vraie remontée décroche toujours.
    scrollTop = 300;
    view.el.dispatchEvent(new Event("scroll"));
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "\n\nEncore un" } as AssistantDelta);
    expect(scrollTop).toBe(300);
  });

  it("onglet masqué puis démasqué : raccroche au bas réel via MutationObserver sur `hidden`", async () => {
    const view = new ConversationView("tab-1");
    // Simule le layout écrasé à 0 tant que l'onglet est masqué (bug 05/09 :
    // `el.hidden = true` -> `scrollHeight` vaut 0, un `scrollTop = scrollHeight`
    // posé pendant ce temps est donc perdu).
    Object.defineProperty(view.el, "scrollHeight", {
      get: () => (view.el.hidden ? 0 : 1000),
      configurable: true,
    });
    Object.defineProperty(view.el, "clientHeight", { value: 400, configurable: true });
    let scrollTop = 0;
    Object.defineProperty(view.el, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });

    view.el.hidden = false; // devient l'onglet actif
    await nextFrame();

    view.el.hidden = true; // l'utilisateur bascule sur un autre onglet
    view.handleMessage({ type: "error", message: "reçu pendant l'absence" } as ErrorMessage);
    expect(scrollTop).toBe(0); // le stick pendant hidden n'a aucun effet utile (scrollHeight à 0)

    view.el.hidden = false; // retour sur l'onglet
    await nextFrame();

    expect(scrollTop).toBe(1000); // le MutationObserver a raccroché au bas réel
  });
});
