/**
 * `ConversationView` — flux de conversation DOM d'un seul tabId.
 *
 * Dispatche chaque `ConversationMessage` reçu (via `den:session-message`, cf.
 * conventions inter-lots) vers le bon rendu : texte assistant streamé
 * (délégué à `IncrementalMarkdownRenderer`), blocs `tool_use`/`tool_result`
 * repliables, marqueurs `done`/`error`. Gère aussi l'auto-scroll (collant au
 * bas sauf si l'utilisateur a remonté) et le point d'insertion des blocs
 * custom (surface interactive, lot dédié).
 */
import type {
  ConversationMessage,
  CustomBlock,
} from "../types/protocol";
import { IncrementalMarkdownRenderer } from "./renderer";

const STICK_TO_BOTTOM_THRESHOLD_PX = 32;

interface ActiveAssistant {
  id: string;
  renderer: IncrementalMarkdownRenderer;
  finalizedEl: HTMLElement;
  currentEl: HTMLElement;
  rafHandle: number | null;
  latestCurrentHtml: string;
}

function appendHtml(parent: HTMLElement, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  parent.appendChild(template.content);
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Rend la sortie d'un tool lisible : les blocs `[{type:"text", text}]` du
 * protocole CLI sont dépliés en texte brut (avec leurs vrais retours à la
 * ligne), une string est affichée telle quelle, le reste en JSON indenté —
 * plus jamais de `"a\nb"` échappé sur une seule ligne.
 */
function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function formatToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0 && output.every(isTextBlock)) {
    return output.map((block) => block.text).join("\n");
  }
  return safeStringify(output);
}

export class ConversationView {
  readonly tabId: string;
  /** Container racine à monter dans #den-conversation (un par tab, masqué si inactif). */
  readonly el: HTMLElement;
  private readonly flowEl: HTMLElement;
  private active: ActiveAssistant | null = null;
  private stickToBottom = true;
  private readonly toolBlocksByToolUseId = new Map<string, HTMLElement>();

  constructor(tabId: string) {
    this.tabId = tabId;
    this.el = document.createElement("div");
    this.el.className = "den-conversation-tab";
    this.el.dataset.tabId = tabId;
    this.el.hidden = true;

    this.flowEl = document.createElement("div");
    this.flowEl.className = "den-conversation-flow";
    this.el.appendChild(this.flowEl);

    this.el.addEventListener("scroll", () => this.onScroll());
  }

  handleMessage(msg: ConversationMessage): void {
    switch (msg.type) {
      case "assistant_delta":
        this.onAssistantDelta(msg.id, msg.text);
        return;
      case "tool_use":
        this.finalizeActiveAssistant();
        this.onToolUse(msg.id, msg.name, msg.input);
        return;
      case "tool_result":
        this.finalizeActiveAssistant();
        this.onToolResult(msg.toolUseId, msg.output, msg.isError === true);
        return;
      case "done":
        this.finalizeActiveAssistant();
        return;
      case "error":
        this.finalizeActiveAssistant();
        this.onError(msg.message);
        return;
      case "user_echo":
        // Ne PAS finaliser le bloc assistant en cours : un prompt soumis
        // pendant un streaming s'insère sous le bloc actif, qui continue de
        // streamer avec son renderer intact (finaliser ici couperait le
        // message en deux et casserait tout construct markdown ouvert).
        this.onUserEcho(msg.text);
        return;
      default:
        // session_info / permission_request / question_request : hors
        // scope du renderer markdown (autres lots / surface interactive).
        return;
    }
  }

  /**
   * Monte un placeholder de bloc custom dans le flux, à la position
   * courante, et retourne l'élément dans lequel l'appelant rend son UI.
   * Cf. `mountCustomBlock` exportée par `src/markdown/index.ts` pour le
   * contrat complet.
   */
  mountCustomBlock(block: CustomBlock): HTMLElement {
    this.finalizeActiveAssistant();
    const wrapper = document.createElement("div");
    wrapper.className = "den-custom-block";
    wrapper.dataset.blockId = block.id;
    wrapper.dataset.blockKind = block.kind;

    const content = document.createElement("div");
    content.className = "den-custom-block-content";
    wrapper.appendChild(content);

    this.flowEl.appendChild(wrapper);
    this.scrollToBottomIfStuck();
    return content;
  }

  private onScroll(): void {
    const el = this.el;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.stickToBottom = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD_PX;
  }

  private scrollToBottomIfStuck(): void {
    if (this.stickToBottom) {
      this.el.scrollTop = this.el.scrollHeight;
    }
  }

  private onAssistantDelta(id: string, text: string): void {
    if (!this.active || this.active.id !== id) {
      this.finalizeActiveAssistant();
      this.active = this.createActiveAssistant(id);
    }
    const active = this.active;
    const { finalizedHtml, currentHtml } = active.renderer.feed(text);

    for (const html of finalizedHtml) {
      appendHtml(active.finalizedEl, html);
    }
    active.latestCurrentHtml = currentHtml;
    this.scheduleCurrentRender(active);

    if (finalizedHtml.length > 0) {
      this.scrollToBottomIfStuck();
    }
  }

  private createActiveAssistant(id: string): ActiveAssistant {
    const block = document.createElement("div");
    block.className = "den-msg den-msg-assistant";
    block.dataset.msgId = id;

    const finalizedEl = document.createElement("div");
    finalizedEl.className = "den-msg-finalized";
    const currentEl = document.createElement("div");
    currentEl.className = "den-msg-current";

    block.appendChild(finalizedEl);
    block.appendChild(currentEl);
    this.flowEl.appendChild(block);

    return {
      id,
      renderer: new IncrementalMarkdownRenderer(),
      finalizedEl,
      currentEl,
      rafHandle: null,
      latestCurrentHtml: "",
    };
  }

  /** Throttle le rendu du bloc en cours : au plus une écriture DOM par frame. */
  private scheduleCurrentRender(active: ActiveAssistant): void {
    if (active.rafHandle !== null) {
      return;
    }
    active.rafHandle = requestAnimationFrame(() => {
      active.rafHandle = null;
      active.currentEl.innerHTML = active.latestCurrentHtml;
      this.scrollToBottomIfStuck();
    });
  }

  private finalizeActiveAssistant(): void {
    const active = this.active;
    if (!active) {
      return;
    }
    if (active.rafHandle !== null) {
      cancelAnimationFrame(active.rafHandle);
      active.rafHandle = null;
    }
    const remaining = active.renderer.finalize();
    for (const html of remaining) {
      appendHtml(active.finalizedEl, html);
    }
    active.currentEl.innerHTML = "";
    this.active = null;
  }

  private onToolUse(id: string, name: string, input: unknown): void {
    const details = document.createElement("details");
    details.className = "den-tool-block";
    details.dataset.toolId = id;

    const summary = document.createElement("summary");
    summary.textContent = `🔧 ${name}`;
    const pre = document.createElement("pre");
    pre.className = "den-tool-input";
    pre.textContent = safeStringify(input);

    details.appendChild(summary);
    details.appendChild(pre);
    this.flowEl.appendChild(details);
    this.toolBlocksByToolUseId.set(id, details);
    this.scrollToBottomIfStuck();
  }

  private onToolResult(toolUseId: string, output: unknown, isError: boolean): void {
    const resultEl = document.createElement("div");
    resultEl.className = isError
      ? "den-tool-result den-tool-result-error"
      : "den-tool-result";
    const label = document.createElement("strong");
    label.textContent = isError ? "Erreur" : "Résultat";
    const pre = document.createElement("pre");
    pre.textContent = formatToolOutput(output);
    resultEl.appendChild(label);
    resultEl.appendChild(pre);

    const details = this.toolBlocksByToolUseId.get(toolUseId);
    if (details) {
      details.appendChild(resultEl);
      if (isError) {
        details.classList.add("den-tool-block-error");
      }
    } else {
      // tool_result sans tool_use correspondant (ex. reprise de session
      // tronquée) : on l'affiche quand même, isolé, plutôt que de le perdre.
      const orphan = document.createElement("div");
      orphan.className = "den-tool-block den-tool-block-orphan";
      orphan.dataset.toolUseId = toolUseId;
      orphan.appendChild(resultEl);
      this.flowEl.appendChild(orphan);
    }
    this.scrollToBottomIfStuck();
  }

  private onError(message: string): void {
    const el = document.createElement("div");
    el.className = "den-error-block";
    el.textContent = `⚠ ${message}`;
    this.flowEl.appendChild(el);
    this.scrollToBottomIfStuck();
  }

  private onUserEcho(text: string): void {
    const el = document.createElement("div");
    el.className = "den-msg den-msg-user";
    // Texte brut volontairement (pas de rendu markdown) : c'est l'écho
    // exact de ce que l'utilisateur a tapé.
    el.textContent = text;
    this.flowEl.appendChild(el);
    this.scrollToBottomIfStuck();
  }
}
