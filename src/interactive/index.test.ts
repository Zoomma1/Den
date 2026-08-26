// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import type { DenContext } from "../core/registry";
import { mountCustomBlock } from "../markdown";
import { init } from "./index";

const fakeCtx = undefined as unknown as DenContext;

function dispatch(tabId: string, message: unknown): void {
  window.dispatchEvent(new CustomEvent("den:session-message", { detail: { tabId, message } }));
}

/** Retrouve le container de flux du tab (`mountCustomBlock` renvoie le
 * même conteneur de vue pour un `tabId` déjà utilisé — cf. contrat de
 * `src/markdown/index.ts`). */
function tabContainer(tabId: string): Element {
  const probe = mountCustomBlock(tabId, { id: `probe-${tabId}`, kind: "probe", payload: null });
  const container = probe.closest(".den-conversation-tab");
  if (!container) throw new Error("container introuvable");
  return container;
}

describe("interactive/index", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("monte une UI de permission sur permission_request et renvoie la décision via sidecar_send", () => {
    init(fakeCtx);
    const tabId = "tab-perm";

    dispatch(tabId, {
      type: "permission_request",
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "ls" },
    });

    const block = tabContainer(tabId).querySelector(".den-permission-block");
    expect(block).not.toBeNull();

    block!.querySelector<HTMLButtonElement>(".den-btn--allow")!.click();

    expect(invokeMock).toHaveBeenCalledWith("sidecar_send", {
      tabId,
      message: JSON.stringify({
        type: "permission_response",
        requestId: "req-1",
        approved: true,
      }),
    });
  });

  it("monte une UI de question sur question_request et renvoie la réponse choisie", () => {
    init(fakeCtx);
    const tabId = "tab-question";

    dispatch(tabId, {
      type: "question_request",
      requestId: "req-2",
      question: "Continuer ?",
      options: ["Oui", "Non"],
    });

    const block = tabContainer(tabId).querySelector(".den-question-block");
    expect(block).not.toBeNull();

    block!.querySelectorAll<HTMLButtonElement>(".den-btn--option")[0].click();

    expect(invokeMock).toHaveBeenCalledWith("sidecar_send", {
      tabId,
      message: JSON.stringify({
        type: "question_response",
        requestId: "req-2",
        answer: "Oui",
      }),
    });
  });

  it("le bloc de décision porte l'id/kind attendus (attributs data-* du CustomBlock)", () => {
    init(fakeCtx);
    const tabId = "tab-attrs";

    dispatch(tabId, {
      type: "permission_request",
      requestId: "req-3",
      toolName: "Read",
      input: {},
    });

    const wrapper = tabContainer(tabId).querySelector(".den-custom-block");
    expect(wrapper?.getAttribute("data-block-id")).toBe("req-3");
    expect(wrapper?.getAttribute("data-block-kind")).toBe("permission_request");
  });

  it("ignore un den:session-message sans detail (pas de crash)", () => {
    init(fakeCtx);
    expect(() => window.dispatchEvent(new CustomEvent("den:session-message"))).not.toThrow();
  });

  it("ignore les types de message non pertinents (ex. assistant_delta)", () => {
    init(fakeCtx);
    const tabId = "tab-irrelevant";
    dispatch(tabId, { type: "assistant_delta", id: "m1", text: "salut" });
    expect(tabContainer(tabId).querySelector(".den-decision-block")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
