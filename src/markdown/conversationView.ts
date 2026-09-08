/**
 * `ConversationView` — flux de conversation DOM d'un seul tabId.
 *
 * Dispatche chaque `ConversationMessage` reçu (via `den:session-message`, cf.
 * conventions inter-lots) vers le bon rendu : texte assistant streamé
 * (délégué à `IncrementalMarkdownRenderer`), blocs `tool_use`/`tool_result`
 * repliables, marqueurs `done`/`error`. Gère aussi l'auto-scroll (collant au
 * bas sauf si l'utilisateur a remonté), le spinner de lifecycle
 * (`den:tab-state-changed`, cf. `src/tabs/index.ts`), le bouton copier (D8)
 * et le point d'insertion des blocs custom (surface interactive, lot dédié).
 *
 * Éditer (D5) : chaque bulle user porte aussi un bouton `.den-edit` — un
 * clic dessus émet `den:edit-prompt` (`detail: { tabId, text }`) sur
 * `window`, consommé par `src/tabs/index.ts` pour reprendre `text` dans la
 * textarea du prompt du tab actif. Cette vue n'interrompt rien elle-même :
 * si un tour tourne, l'utilisateur fait Stop d'abord (cf. `src/tabs/index.ts`).
 */
import type {
  ConversationMessage,
  CustomBlock,
} from "../types/protocol";
import { IncrementalMarkdownRenderer } from "./renderer";

/**
 * Seuil de RACCROCHAGE (pas de décrochage) au fil qui descend — cf. bug
 * constaté au grill du 05/09 : l'ancien seuil unique de 32px n'est jamais
 * atteint pendant un stream qui fait grandir le fil plus vite que le scroll
 * de l'utilisateur (le raccrochage n'arrivait qu'au message suivant). La
 * logique est maintenant une logique de DIRECTION (cf. `onScroll`) : ce
 * seuil ne s'applique que quand `scrollTop` ne diminue pas.
 */
const RESTICK_THRESHOLD_PX = 120;

/** Tolérance « en butée basse » (scrollTop peut être fractionnaire sous WebKit). */
const AT_BOTTOM_EPSILON_PX = 1;

/** Délai d'affichage du feedback "✓"/"✗" sur le bouton copier avant retour à "⧉". */
const COPY_FEEDBACK_MS = 1200;

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

/**
 * Convention UNIQUE du bouton copier (D8) : précède immédiatement l'élément
 * dont le `textContent` doit être copié (`button.nextElementSibling`, cf.
 * listener délégué dans le constructeur). Le renderer markdown (code fences,
 * `renderer.ts`) émet la même structure en HTML brut — cette fabrique DOM
 * doit rester au même contrat.
 */
function createCopyButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "den-copy";
  button.setAttribute("aria-label", "Copier");
  button.title = "Copier";
  button.textContent = "⧉";
  return button;
}

/**
 * Bouton "Reprendre ce message" (D5) — posé sur chaque bulle user, APRÈS
 * `.den-msg-user__text` (la convention `.den-copy` juste avant le span
 * n'est pas touchée, cf. `onUserEcho`). Pas de convention de positionnement
 * DOM comme `.den-copy` : le texte à reprendre est retrouvé par un
 * `querySelector` ciblé au clic (cf. `onEditClick`), pas par un voisin fixe.
 */
function createEditButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "den-edit";
  button.setAttribute("aria-label", "Reprendre ce message");
  button.title = "Reprendre ce message";
  button.textContent = "✎";
  return button;
}

export class ConversationView {
  readonly tabId: string;
  /** Container racine à monter dans #den-conversation (un par tab, masqué si inactif). */
  readonly el: HTMLElement;
  private readonly flowEl: HTMLElement;
  private readonly thinkingEl: HTMLElement;
  private active: ActiveAssistant | null = null;
  private stickToBottom = true;
  private readonly copyFeedbackTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  private lastScrollTop = 0;
  private readonly toolBlocksByToolUseId = new Map<string, HTMLElement>();
  private readonly onTabStateChangedBound: (event: Event) => void;

  constructor(tabId: string) {
    this.tabId = tabId;
    this.el = document.createElement("div");
    this.el.className = "den-conversation-tab";
    this.el.dataset.tabId = tabId;
    this.el.hidden = true;

    this.flowEl = document.createElement("div");
    this.flowEl.className = "den-conversation-flow";
    this.el.appendChild(this.flowEl);

    // Enfant de `this.el` APRÈS `flowEl` : reste visuellement en bas du fil,
    // et `conversation_reset` (qui vide `flowEl` par `replaceChildren`) ne le
    // détruit pas — pas besoin de le recréer après un reset.
    this.thinkingEl = document.createElement("div");
    this.thinkingEl.className = "den-thinking";
    this.thinkingEl.hidden = true;
    this.el.appendChild(this.thinkingEl);

    this.el.addEventListener("scroll", () => this.onScroll());
    // Listener unique délégué pour tous les boutons copier ET éditer du fil
    // (D8/D5) — un par bouton serait autant de listeners à poser/déposer à
    // chaque re-render du bloc courant (innerHTML), sans rien gagner.
    this.el.addEventListener("click", (event) => {
      this.onCopyClick(event);
      this.onEditClick(event);
    });

    // Spinner de lifecycle : la vue ne COMPTE rien elle-même (seule source
    // de vérité : `src/tabs/lifecycle.ts`, cf. DEN-10 D6) — elle ne fait que
    // refléter l'état reçu sur l'événement, filtré sur son propre tabId.
    this.onTabStateChangedBound = (event) => this.onTabStateChanged(event);
    window.addEventListener("den:tab-state-changed", this.onTabStateChangedBound);

    // Onglet masqué (index.ts du module markdown fait `el.hidden = true`
    // sur les vues inactives) -> `scrollHeight` vaut 0 pendant que l'onglet
    // est caché, un `scrollTop = scrollHeight` fait pendant ce temps est
    // perdu (bug constaté au grill du 05/09 : le fil n'est pas en bas au
    // retour sur l'onglet). Fix par observation plutôt que par un appel
    // depuis `index.ts` : la vue reste autonome sur son propre contrat de
    // scroll, `index.ts` n'a pas à connaître cette mécanique interne.
    const hiddenObserver = new MutationObserver(() => this.onHiddenAttributeChanged());
    hiddenObserver.observe(this.el, { attributes: true, attributeFilter: ["hidden"] });
  }

  handleMessage(msg: ConversationMessage): void {
    switch (msg.type) {
      case "assistant_delta":
        this.onAssistantDelta(msg.id, msg.text);
        return;
      case "tool_use":
        this.finalizeActiveAssistant();
        this.onToolUse(msg.id, msg.toolUseId, msg.name, msg.input);
        return;
      case "tool_result":
        this.finalizeActiveAssistant();
        this.onToolResult(msg.toolUseId, msg.output, msg.isError === true);
        return;
      case "done":
        this.finalizeActiveAssistant();
        return;
      case "conversation_reset":
        // Le SDK a réinitialisé la conversation (/clear, sortie de plan
        // mode...) : le fil affiché doit refléter que le contexte réel est
        // reparti à zéro (sonde S-h : conversation_reset -> init avec
        // nouveau session_id -> result vide). On vide tout, y compris la
        // map d'appariement tool_use/tool_result — les toolUseId d'avant le
        // reset n'ont plus aucun sens.
        this.finalizeActiveAssistant();
        this.flowEl.replaceChildren();
        this.active = null;
        this.toolBlocksByToolUseId.clear();
        this.stickToBottom = true;
        this.lastScrollTop = 0;
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

  /** Reflète l'état de lifecycle du tab (`den:tab-state-changed`, émis par
   * `src/tabs/index.ts`) — ignore tout événement qui ne concerne pas CE
   * tabId : plusieurs vues coexistent, une par tab. */
  private onTabStateChanged(event: Event): void {
    const detail = (event as CustomEvent<{ tabId: string; state: string }>).detail;
    if (!detail || detail.tabId !== this.tabId) return;

    if (detail.state === "running") {
      this.thinkingEl.textContent = "réfléchit…";
      this.thinkingEl.hidden = false;
      this.scrollToBottomIfStuck();
    } else if (detail.state === "waiting") {
      this.thinkingEl.textContent = "attend ta réponse";
      this.thinkingEl.hidden = false;
      this.scrollToBottomIfStuck();
    } else {
      this.thinkingEl.hidden = true;
    }
  }

  /** Au retour sur un onglet masqué, raccroche au bas si le fil y était
   * resté collé (cf. constructeur — un `scrollTop` posé pendant `hidden`
   * est un no-op, `scrollHeight` valant 0 tant que l'élément est masqué). */
  private onHiddenAttributeChanged(): void {
    if (!this.el.hidden) {
      this.scrollToBottomIfStuck();
    }
  }

  /**
   * Logique de DIRECTION (cf. bug 05/09, docstring de `RESTICK_THRESHOLD_PX`) :
   * remonter décroche immédiatement, quelle que soit la distance restante au
   * bas ; descendre (ou un scroll programmatique de
   * `scrollToBottomIfStuck`, qui va toujours au maximum) raccroche dès qu'on
   * repasse sous le seuil. Un contenu qui grandit sans émettre de `scroll`
   * ne change pas `stickToBottom` — c'est voulu : rien ne dit que
   * l'utilisateur a bougé.
   */
  private onScroll(): void {
    const el = this.el;
    const scrollTop = el.scrollTop;
    const distanceFromBottom = el.scrollHeight - scrollTop - el.clientHeight;
    if (distanceFromBottom <= AT_BOTTOM_EPSILON_PX) {
      // En butée basse : soit notre scroll programmatique, soit le
      // navigateur qui a RABAISSÉ scrollTop parce que le contenu a rétréci
      // (spinner masqué au `done`, redimensionnement) — jamais une remontée
      // de l'utilisateur. Régression du grill 2 (05/09) : lu comme une
      // remontée, ce rabaissement décrochait le fil à chaque fin de tour,
      // et plus rien ne le raccrochait.
      this.stickToBottom = true;
    } else if (scrollTop < this.lastScrollTop) {
      this.stickToBottom = false;
    } else {
      this.stickToBottom = distanceFromBottom < RESTICK_THRESHOLD_PX;
    }
    this.lastScrollTop = scrollTop;
  }

  private scrollToBottomIfStuck(): void {
    if (this.stickToBottom) {
      this.el.scrollTop = this.el.scrollHeight;
      this.lastScrollTop = this.el.scrollTop;
    }
  }

  /** Listener délégué unique (posé dans le constructeur) pour tous les
   * `.den-copy` du fil — convention D8 : le texte à copier est le
   * `textContent` de l'élément qui suit immédiatement le bouton dans le DOM. */
  private onCopyClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(".den-copy");
    if (!(button instanceof HTMLButtonElement)) return;

    const source = button.nextElementSibling;
    const text = source?.textContent ?? "";
    navigator.clipboard.writeText(text).then(
      () => this.flashCopyButton(button, "✓"),
      (err: unknown) => {
        console.error("Den: échec de la copie dans le presse-papier", err);
        this.flashCopyButton(button, "✗");
      },
    );
  }

  private flashCopyButton(button: HTMLButtonElement, symbol: string): void {
    button.textContent = symbol;
    // Un second clic pendant le feedback annule le retour programmé par le
    // premier — sinon il écraserait le feedback du second (review 07/09).
    const previous = this.copyFeedbackTimers.get(button);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      button.textContent = "⧉";
      this.copyFeedbackTimers.delete(button);
    }, COPY_FEEDBACK_MS);
    this.copyFeedbackTimers.set(button, timer);
  }

  /** Clic sur `.den-edit` (D5) : retrouve le texte exact de la bulle user
   * (`.den-msg-user__text`, voisin dans le même parent) et le republie via
   * `den:edit-prompt` — `src/tabs/index.ts` décide ensuite s'il le reprend
   * (tab actif ou non). N'interrompt jamais un tour en cours ici : c'est à
   * l'utilisateur de faire Stop d'abord (D5). */
  private onEditClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest(".den-edit");
    if (!(button instanceof HTMLButtonElement)) return;

    const text = button.parentElement?.querySelector(".den-msg-user__text")?.textContent ?? "";
    window.dispatchEvent(
      new CustomEvent("den:edit-prompt", { detail: { tabId: this.tabId, text } }),
    );
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

  private onToolUse(
    id: string,
    toolUseId: string,
    name: string,
    input: unknown,
  ): void {
    const details = document.createElement("details");
    details.className = "den-tool-block";
    // `id` (du tour) reste la clé attendue par src/markdown/replay.test.ts —
    // `toolUseId` (du bloc SDK) est ce qui apparie réellement le tool_result
    // (cf. bug DEN-10 : le sidecar envoyait `id` du tour des deux côtés du
    // tool_result mais `tool_use.id` du tour côté tool_use, qui ne matchait
    // jamais `toolUseId` en pratique).
    details.dataset.toolId = id;
    details.dataset.toolUseId = toolUseId;

    const summary = document.createElement("summary");
    summary.textContent = `🔧 ${name}`;
    const pre = document.createElement("pre");
    pre.className = "den-tool-input";
    const code = document.createElement("code");
    code.textContent = safeStringify(input);
    pre.appendChild(createCopyButton());
    pre.appendChild(code);

    details.appendChild(summary);
    details.appendChild(pre);
    this.flowEl.appendChild(details);
    this.toolBlocksByToolUseId.set(toolUseId, details);
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
    const code = document.createElement("code");
    code.textContent = formatToolOutput(output);
    pre.appendChild(createCopyButton());
    pre.appendChild(code);
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
    el.appendChild(createCopyButton());
    // Texte brut volontairement (pas de rendu markdown), en `<span>` dédié
    // (pas directement dans `.den-msg-user` : convention D8, le bouton
    // copier doit être suivi immédiatement par l'élément qui porte le
    // texte) — c'est l'écho exact de ce que l'utilisateur a tapé.
    const textEl = document.createElement("span");
    textEl.className = "den-msg-user__text";
    textEl.textContent = text;
    el.appendChild(textEl);
    // Bouton éditer (D5) APRÈS le span de texte — la convention copier
    // (`.den-copy` immédiatement avant `.den-msg-user__text`) reste intacte.
    el.appendChild(createEditButton());
    this.flowEl.appendChild(el);
    this.scrollToBottomIfStuck();
  }
}
