// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ConversationView } from "./conversationView";
import type {
  AssistantDelta,
  Done,
  ErrorMessage,
  ToolResult,
  ToolUse,
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
      id: "tool-1",
      name: "Read",
      input: { file_path: "/tmp/x.ts" },
    } as ToolUse);

    const details = view.el.querySelector("details.den-tool-block");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain("Read");
    expect(details?.querySelector(".den-tool-result")).toBeNull();

    view.handleMessage({
      type: "tool_result",
      id: "res-1",
      toolUseId: "tool-1",
      output: { content: "ok" },
    } as ToolResult);

    expect(details?.querySelector(".den-tool-result")).not.toBeNull();
    expect(details?.classList.contains("den-tool-block-error")).toBe(false);
  });

  it("marque le bloc tool en erreur quand tool_result.isError est vrai", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "tool_use",
      id: "tool-err",
      name: "Bash",
      input: { command: "false" },
    } as ToolUse);
    view.handleMessage({
      type: "tool_result",
      id: "res-err",
      toolUseId: "tool-err",
      output: { stderr: "boom" },
      isError: true,
    } as ToolResult);

    const details = view.el.querySelector('details[data-tool-id="tool-err"]');
    expect(details?.classList.contains("den-tool-block-error")).toBe(true);
    expect(details?.querySelector(".den-tool-result-error")).not.toBeNull();
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
});
