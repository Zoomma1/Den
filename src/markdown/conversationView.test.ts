// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationView, setModBridge } from "./conversationView";
import { MOD_EVENTS } from "../mods/contracts";

// toolGroup.ts est écrit par un autre lot : on ne teste ici que le câblage de la vue.
vi.mock("./toolGroup", () => ({
  isReadOnlyTool: (name: string) => ["Read", "Grep", "Glob"].includes(name),
  summarizeToolRun: (calls: readonly unknown[]) => `${calls.length} reads`,
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
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
    expect(thinking.textContent).toBe("thinking…");

    window.dispatchEvent(
      new CustomEvent("den:tab-state-changed", { detail: { tabId: "tab-1", state: "waiting" } }),
    );
    expect(thinking.hidden).toBe(false);
    expect(thinking.textContent).toBe("waiting for your reply");

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
    const copyButtons = view.el.querySelectorAll(".den-code-block > .den-copy");
    expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(copyButtons.length).toBe(codeBlocks.length);
  });

  it("clic sur .den-copy d'un bloc de code copie le textContent du <pre> qui le suit", async () => {
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

    const button = view.el.querySelector(".den-code-block > .den-copy");
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

  it("user_echo sans images : pas de .den-msg-user__images", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "user_echo", id: "u1", text: "salut" } as UserEcho);
    expect(view.el.querySelector(".den-msg-user__images")).toBeNull();
  });

  it("user_echo avec 2 images rend 2 <img> data: et ✎ restitue le texte seul", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({
      type: "user_echo",
      id: "u1",
      text: "regarde",
      images: [
        { mediaType: "image/png", data: "AAA" },
        { mediaType: "image/jpeg", data: "BBB" },
      ],
    } as UserEcho);

    const imgs = view.el.querySelectorAll<HTMLImageElement>(".den-msg-user__images img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(imgs[1].getAttribute("src")).toBe("data:image/jpeg;base64,BBB");
    expect(imgs[0].alt).toBe("Pasted image");

    const edits: string[] = [];
    window.addEventListener("den:edit-prompt", (e) => edits.push((e as CustomEvent).detail.text), { once: true });
    (view.el.querySelector(".den-edit") as HTMLElement).click();
    expect(edits).toEqual(["regarde"]);
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

  it("user_echo ajoute un <time> HH:MM après le texte, le bouton copier reste juste avant", () => {
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "user_echo", text: "salut" } as UserEcho);
    const text = view.el.querySelector(".den-msg-user__text")!;
    expect(text.previousElementSibling?.classList.contains("den-copy")).toBe(true);
    const time = text.nextElementSibling!;
    expect(time.tagName).toBe("TIME");
    expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  function linkView(href: string): { a: HTMLAnchorElement; view: ConversationView } {
    const view = new ConversationView("tab-1");
    const a = document.createElement("a");
    a.setAttribute("href", href);
    view.el.appendChild(a);
    return { a, view };
  }

  it("clic sur un lien http n'est pas navigué et appelle l'ouverture", () => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    const { a } = linkView("https://example.com/");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://example.com/" });
  });

  it("clic milieu (auxclick) sur un lien est aussi intercepté", () => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    const { a } = linkView("https://example.com/");
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("un lien javascript: est bloqué sans ouverture", () => {
    invokeMock.mockReset();
    const { a } = linkView("javascript:alert(1)");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("ConversationView — surfaces du moteur", () => {
  type Req = { component: string; instanceId: string; props: Record<string, unknown> };
  type Resp = { tree: unknown; hooked: boolean; rewritten: boolean; props?: Record<string, unknown> };

  /** Pont simulé : consigne les requêtes, répond par `respond` ; un arbre string devient un <span class="mod">. */
  function installBridge(respond: (req: Req) => Resp | null = () => null) {
    const requests: Req[] = [];
    const requestRender = vi.fn(async (_tab: string, req: Req) => {
      requests.push(req);
      return respond(req) ?? { tree: null, hooked: false, rewritten: false };
    });
    setModBridge({
      client: { requestRender } as never,
      renderTree: ((tree: unknown) => {
        const span = document.createElement("span");
        span.className = "mod";
        span.textContent = String(tree);
        return span;
      }) as never,
    });
    return requests;
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const hook = (tree: unknown): Resp => ({ tree, hooked: true, rewritten: true });
  const use = (view: ConversationView, id: string, name = "Read", input: unknown = { file_path: `/${id}` }) =>
    view.handleMessage({ type: "tool_use", id: "t1", toolUseId: id, name, input } as ToolUse);
  const result = (view: ConversationView, id: string, extra: object = {}) =>
    view.handleMessage({ type: "tool_result", id: "t1", toolUseId: id, output: "ok", ...extra } as ToolResult);

  afterEach(() => setModBridge(null));

  it("UserMessage : cible = surface de la bulle (texte+heure masqués en CSS), boutons copier/éditer intacts", async () => {
    const requests = installBridge((r) => (r.component === "UserMessage" ? hook("MOD") : null));
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "user_echo", id: "u1", text: "salut" } as UserEcho);
    await tick();

    expect(requests[0]).toMatchObject({
      component: "UserMessage",
      props: { text: "salut", origin: { kind: "composer" }, isExpanded: true },
    });
    const bubble = view.el.querySelector(".den-msg-user") as HTMLElement;
    expect(bubble.querySelector(":scope > .den-msg-user__surface")?.textContent).toBe("MOD");
    expect(bubble.querySelector(".den-msg-user__text")?.previousElementSibling?.classList.contains("den-copy")).toBe(true);
    expect(bubble.querySelector(":scope > .den-copy")).not.toBeNull();
    expect(bubble.querySelector(":scope > .den-edit")).not.toBeNull();
  });

  it("UserMessage : éditer garde le texte exact même après réécriture par un mod", async () => {
    installBridge(() => hook("MOD"));
    const view = new ConversationView("tab-1");
    const edits: string[] = [];
    window.addEventListener("den:edit-prompt", (e) => edits.push((e as CustomEvent).detail.text), { once: true });
    view.handleMessage({ type: "user_echo", id: "u1", text: "salut" } as UserEcho);
    await tick();
    (view.el.querySelector(".den-edit") as HTMLElement).click();
    expect(edits).toEqual(["salut"]);
  });

  it("ToolUse : demandé à tool_use puis redemandé avec le résultat, dans le <summary>", async () => {
    const requests = installBridge((r) => (r.component === "ToolUse" ? hook("USE") : null));
    const view = new ConversationView("tab-1");
    use(view, "tu1", "Bash", { command: "ls" });
    await tick();
    result(view, "tu1", { structured: { stdout: "x" } });
    await tick();

    const toolUse = requests.filter((r) => r.component === "ToolUse");
    expect(toolUse).toHaveLength(2);
    expect(toolUse[0].props).toEqual({
      tool_use_id: "tu1", tool: "Bash", input: { command: "ls" },
      isRunning: true, isErrored: false, isInterrupted: false,
    });
    expect(toolUse[1].props).toMatchObject({ isRunning: false, isErrored: false, output: { stdout: "x" } });
    const details = view.el.querySelector("details.den-tool-block") as HTMLDetailsElement;
    expect(details.querySelector("summary > .den-tool-use-surface")?.textContent).toBe("USE");
    expect(details.querySelector(".den-tool-result")).not.toBeNull();
  });

  /** Pont à réponses manuelles : chaque requête reste en vol jusqu'à `answer(i, resp)`. */
  function installDeferredBridge() {
    const pending: Array<(r: Resp) => void> = [];
    const components: string[] = [];
    const requestRender = vi.fn(
      (_tab: string, req: Req) =>
        new Promise<Resp>((resolve) => {
          if (req.component === "ToolUse" || req.component === "ToolGroup") {
            pending.push(resolve);
            components.push(req.component);
          }
          else resolve({ tree: null, hooked: false, rewritten: false });
        }),
    );
    setModBridge({
      client: { requestRender } as never,
      renderTree: ((tree: unknown, opts: { renderEngineDefault?: (ref: number) => Node | null }) => {
        const span = document.createElement("span");
        span.className = "mod";
        if (tree === "WRAP") span.append(opts.renderEngineDefault?.(0) ?? "");
        else span.textContent = String(tree);
        return span;
      }) as never,
    });
    const answer = async (i: number, resp: Resp) => {
      pending[i](resp);
      await tick();
    };
    return Object.assign(answer, { components });
  }
  const engineDefault: Resp = { tree: { type: "engine", ref: 0 }, hooked: true, rewritten: false };

  it("ToolUse : réponse 1 encore en vol quand la 2 part, la 2 = engine ref 0 -> surface vide", async () => {
    const answer = installDeferredBridge();
    const view = new ConversationView("tab-1");
    use(view, "tu1", "Bash", { command: "ls" });
    result(view, "tu1");
    await answer(0, hook("RUNNING"));
    await answer(1, engineDefault);

    const surface = view.el.querySelector(".den-tool-use-surface") as HTMLElement;
    expect(surface.textContent).toBe("");
    expect(surface.querySelector(".mod")).toBeNull();
  });

  it("ToolUse : réponses hors ordre, la dernière requête gagne", async () => {
    const answer = installDeferredBridge();
    const view = new ConversationView("tab-1");
    use(view, "tu1", "Bash", { command: "ls" });
    result(view, "tu1");
    await answer(1, hook("SECOND"));
    await answer(0, hook("FIRST"));

    expect(view.el.querySelector(".den-tool-use-surface")?.textContent).toBe("SECOND");
  });

  it("ToolGroup : 3 requêtes en vol, renderEngineDefault(0) rend le natif et non un arbre de mod", async () => {
    const answer = installDeferredBridge();
    const view = new ConversationView("tab-1");
    use(view, "r1");
    use(view, "r2");
    use(view, "r3");
    const groups = answer.components.flatMap((c, i) => (c === "ToolGroup" ? [i] : []));
    expect(groups.length).toBe(2);
    // La dernière requête répond en premier avec un arbre simple, la précédente l'enveloppe ensuite : périmée, jetée.
    await answer(groups[1], hook("WRAP"));
    await answer(groups[0], hook("OTHER"));

    const surface = view.el.querySelector(".den-tool-group__surface") as HTMLElement;
    expect(surface.querySelector(".mod .mod")).toBeNull();
    expect(surface.textContent).toBe("");
  });

  it("ToolResult vidé par un mod : le <details> et ses boutons restent", async () => {
    installBridge((r) => (r.component === "ToolResult" ? hook("") : null));
    const view = new ConversationView("tab-1");
    use(view, "tu1", "Bash");
    result(view, "tu1");
    await tick();

    const details = view.el.querySelector("details.den-tool-block");
    expect(details?.querySelector("summary")).not.toBeNull();
    expect(details?.querySelector(".den-tool-input .den-copy")).not.toBeNull();
    expect(details?.querySelector(".den-tool-result")?.textContent).toBe("");
  });

  it("ToolGroup : 2 lectures consécutives sont enveloppées, un Bash ferme le groupe", async () => {
    const requests = installBridge((r) => (r.component === "ToolGroup" ? hook("GROUP") : null));
    const view = new ConversationView("tab-1");
    use(view, "r1");
    expect(view.el.querySelector(".den-tool-group")).toBeNull();
    use(view, "r2");
    use(view, "r3");
    await tick();

    const group = view.el.querySelector("details.den-tool-group") as HTMLElement;
    expect(group.querySelectorAll(".den-tool-group__body > details.den-tool-block")).toHaveLength(3);
    expect(group.querySelector(".den-tool-group__label")?.textContent).toBe("3 reads");
    expect(group.querySelector(".den-tool-group__surface")?.textContent).toBe("GROUP");
    const last = requests.filter((r) => r.component === "ToolGroup").at(-1)!;
    expect(last.props).toMatchObject({ isActive: true, isExpanded: false });
    expect((last.props.calls as unknown[]).length).toBe(3);

    use(view, "b1", "Bash");
    use(view, "r4");
    use(view, "r5");
    expect(view.el.querySelectorAll("details.den-tool-group")).toHaveLength(2);
    expect(group.querySelectorAll("details.den-tool-block")).toHaveLength(3);
  });

  it("ToolGroup : le texte assistant et done ferment le groupe ; le résultat met à jour isActive", async () => {
    const requests = installBridge((r) => (r.component === "ToolGroup" ? hook("G") : null));
    const view = new ConversationView("tab-1");
    use(view, "r1");
    use(view, "r2");
    result(view, "r1");
    result(view, "r2", { isError: true });
    await tick();
    const last = requests.filter((r) => r.component === "ToolGroup").at(-1)!;
    expect(last.props.isActive).toBe(false);
    expect((last.props.calls as { isErrored: boolean }[]).map((c) => c.isErrored)).toEqual([false, true]);

    view.handleMessage({ type: "assistant_delta", id: "m1", text: "ok" } as AssistantDelta);
    use(view, "r3");
    use(view, "r4");
    view.handleMessage({ type: "done" } as Done);
    use(view, "r5");
    use(view, "r6");
    expect(view.el.querySelectorAll("details.den-tool-group")).toHaveLength(3);
  });

  it("CommandOutput : ligne native avec copier, props demandées, texte réécrit par props", async () => {
    const requests = installBridge(() => ({ tree: { type: "engine", ref: 1 }, hooked: true, rewritten: true, props: { text: "réécrit" } }));
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "command_output", id: "c1", command: "cost", args: "", text: "brut", isError: true } as never);
    expect(view.el.querySelector(".den-command-output pre > .den-copy")).not.toBeNull();
    await tick();

    expect(requests.find((r) => r.component === "CommandOutput")).toMatchObject({
      instanceId: expect.stringMatching(/^cmd-\d+$/),
      props: { command: "cost", args: "", text: "brut", isErrored: true },
    });
    expect(view.el.querySelector(".den-command-output code")?.textContent).toBe("réécrit");
  });

  it("CommandOutput : deux sorties dans le même tour ont des instanceId distincts", async () => {
    const requests = installBridge(() => ({ tree: null, hooked: false, rewritten: false }));
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "command_output", id: "same", command: "a", args: "", text: "1" } as never);
    view.handleMessage({ type: "command_output", id: "same", command: "b", args: "", text: "2" } as never);
    await tick();
    const ids = requests.filter((r) => r.component === "CommandOutput").map((r) => r.instanceId);
    expect(new Set(ids).size).toBe(2);
  });

  it("TurnDuration : pied natif sans mod, demande Baked, remplacé par l'arbre ; absent sans durationMs", async () => {
    const requests = installBridge((r) => (r.component === "TurnDuration" ? hook("BAKED") : null));
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "done" } as Done);
    expect(view.el.querySelector(".den-turn-duration")).toBeNull();
    view.handleMessage({ type: "done", durationMs: 6340 } as Done);
    expect(view.el.querySelector(".den-turn-duration")?.textContent).toBe("Worked for 6s");
    await tick();

    expect(requests.filter((r) => r.component === "TurnDuration")).toHaveLength(1);
    expect(requests[0].props).toEqual({ word: "Baked", durationMs: 6340 });
    expect(view.el.querySelector(".den-turn-duration")?.textContent).toBe("BAKED");
  });

  it("AssistantMessage : engine ref≠0 + props redessine le markdown de props.text", async () => {
    installBridge((r) =>
      r.component === "AssistantMessage"
        ? { tree: { type: "engine", ref: 1 }, hooked: true, rewritten: true, props: { text: "**gras**" } }
        : null,
    );
    const view = new ConversationView("tab-1");
    view.handleMessage({ type: "assistant_delta", id: "m1", text: "original" } as AssistantDelta);
    view.handleMessage({ type: "done" } as Done);
    await tick();

    expect(view.el.querySelector(".den-msg-assistant strong")?.textContent).toBe("gras");
    expect(view.el.textContent).not.toContain("original");
  });

  it("engine ref≠0 sans redraw (ToolResult) est ignoré", async () => {
    installBridge(() => ({ tree: { type: "engine", ref: 1 }, hooked: true, rewritten: true, props: { x: 1 } }));
    const view = new ConversationView("tab-1");
    use(view, "tu1", "Bash");
    result(view, "tu1");
    await tick();
    expect(view.el.querySelector(".den-tool-result code")?.textContent).toBe("ok");
  });

  it("viewport : redemande tous les blocs du tab concerné seulement", async () => {
    const requests = installBridge(() => hook("X"));
    const view = new ConversationView("tab-vp");
    view.handleMessage({ type: "user_echo", id: "u1", text: "a" } as UserEcho);
    await tick();
    expect(requests).toHaveLength(1);

    window.dispatchEvent(new CustomEvent(MOD_EVENTS.viewport, { detail: { tabId: "autre", viewport: { columns: 80, rows: 40 } } }));
    await tick();
    expect(requests).toHaveLength(1);
    window.dispatchEvent(new CustomEvent(MOD_EVENTS.viewport, { detail: { tabId: "tab-vp", viewport: { columns: 80, rows: 40 } } }));
    await tick();
    expect(requests).toHaveLength(2);
  });
});
