/**
 * Module `tabs` — barre d'onglets, un sidecar par session/tab.
 *
 * Contrat inter-lots (événements DOM sur `window`, aucun fichier partagé) :
 * - `den:session-message` (`detail: { tabId, message: ConversationMessage }`) :
 *   chaque message sidecar reçu et validé contre le protocole wire, plus
 *   l'écho local `user_echo` fabriqué ici à l'envoi d'un prompt (cf.
 *   `src/types/protocol.ts` — `UserEcho` n'est jamais sur le wire).
 * - `den:active-tab-changed` (`detail: { tabId }`) à chaque changement de
 *   tab actif, y compris pour le tout premier tab créé au démarrage.
 *
 * Un sidecar par tab (`sidecar_spawn`/`sidecar_send`/`sidecar_kill`, cf.
 * `src-tauri/src/sidecar.rs`) — un crash n'emporte qu'un tab, les autres
 * continuent (routage/état isolés par tabId, cf. `router.ts`).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import "./tabs.css";
import type { DenContext } from "../core/registry";
import {
  isDone,
  isErrorMessage,
  isSessionInfo,
  type ConversationMessage,
} from "../types/protocol";
import { TabRouter } from "./router";

interface Tab {
  id: string;
  cwd: string;
  sessionId?: string;
  buttonEl: HTMLButtonElement;
  titleEl: HTMLSpanElement;
  statusEl: HTMLSpanElement;
}

/**
 * Cwd par défaut d'un nouveau tab. Aucun sélecteur de dossier natif n'est
 * dans le périmètre de ce lot (pas de plugin dialog installé) — "." résout
 * côté Rust au cwd du process app. Limitation connue : pas d'édition du cwd
 * après création dans ce lot (à couvrir par une UI dédiée si besoin).
 */
const DEFAULT_CWD = ".";

export function init(ctx: DenContext): void {
  const router = new TabRouter();
  const tabs = new Map<string, Tab>();
  let activeTabId: string | null = null;

  function dispatchSessionMessage(
    tabId: string,
    message: ConversationMessage,
  ): void {
    window.dispatchEvent(
      new CustomEvent("den:session-message", { detail: { tabId, message } }),
    );
  }

  function dispatchActiveTabChanged(tabId: string): void {
    window.dispatchEvent(
      new CustomEvent("den:active-tab-changed", { detail: { tabId } }),
    );
  }

  function setActiveTab(tabId: string): void {
    activeTabId = tabId;
    for (const tab of tabs.values()) {
      const selected = tab.id === tabId;
      tab.buttonEl.setAttribute("aria-selected", String(selected));
      tab.buttonEl.classList.toggle("den-tab--active", selected);
    }
    dispatchActiveTabChanged(tabId);
  }

  function updateTabTitle(tab: Tab): void {
    // "." = cwd par défaut, sans valeur pour l'utilisateur — préférer un
    // libellé neutre en attendant un vrai choix de dossier par tab.
    const label = tab.cwd === "." ? "Session" : tab.cwd;
    tab.titleEl.textContent = tab.sessionId
      ? `${label} ${tab.sessionId.slice(0, 8)}`
      : label;
  }

  function markTabError(tab: Tab, message: string): void {
    // Le chip tronque déjà par ellipsis CSS (.den-tab__status) — le message
    // complet reste lisible au survol (title).
    tab.statusEl.textContent = `Erreur: ${message}`;
    tab.statusEl.title = message;
    tab.buttonEl.classList.add("den-tab--error");
  }

  async function closeTab(tabId: string): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab) return;
    try {
      await invoke("sidecar_kill", { tabId });
    } catch (err) {
      console.error(`Den: échec sidecar_kill pour le tab ${tabId}`, err);
    }
    router.closeTab(tabId);
    tab.buttonEl.remove();
    tabs.delete(tabId);

    if (activeTabId === tabId) {
      const remaining = [...tabs.keys()];
      if (remaining.length > 0) {
        setActiveTab(remaining[0]);
      } else {
        activeTabId = null;
      }
    }
  }

  function createTab(cwd: string): Tab {
    const id = crypto.randomUUID();

    const buttonEl = document.createElement("button");
    buttonEl.type = "button";
    buttonEl.className = "den-tab";
    buttonEl.setAttribute("role", "tab");

    const titleEl = document.createElement("span");
    titleEl.className = "den-tab__title";

    const statusEl = document.createElement("span");
    statusEl.className = "den-tab__status";

    const closeEl = document.createElement("span");
    closeEl.className = "den-tab__close";
    closeEl.textContent = "×";
    closeEl.setAttribute("role", "button");
    closeEl.setAttribute("aria-label", "Fermer l'onglet");
    closeEl.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTab(id);
    });

    buttonEl.append(titleEl, statusEl, closeEl);
    buttonEl.addEventListener("click", () => setActiveTab(id));

    const list = ctx.mounts.tabs.querySelector(".den-tab-list");
    if (list) list.appendChild(buttonEl);

    const tab: Tab = { id, cwd, buttonEl, titleEl, statusEl };
    tabs.set(id, tab);
    updateTabTitle(tab);
    router.registerTab(id);

    const channel = new Channel<string>();
    channel.onmessage = (chunk) => {
      for (const { message } of router.handleChunk(id, chunk)) {
        if (isSessionInfo(message)) {
          tab.sessionId = message.sessionId;
          updateTabTitle(tab);
        } else if (isErrorMessage(message)) {
          markTabError(tab, message.message);
        } else if (isDone(message) && router.getState(id) !== "error") {
          tab.statusEl.textContent = "";
        }
        dispatchSessionMessage(id, message);
      }
    };

    invoke("sidecar_spawn", { tabId: id, cwd, onMessage: channel }).catch(
      (err: unknown) => {
        markTabError(tab, err instanceof Error ? err.message : String(err));
      },
    );

    return tab;
  }

  /** Retourne false si le prompt n'a pas pu partir (l'appelant peut alors
   * restituer le texte tapé au lieu de le perdre). */
  async function sendPrompt(tabId: string, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return true;
    if (router.getState(tabId) === "error") return false;

    router.markPromptSubmitted(tabId);
    const tab = tabs.get(tabId);
    if (tab) tab.statusEl.textContent = "…";

    const payload = {
      type: "user_message" as const,
      id: crypto.randomUUID(),
      text: trimmed,
    };
    try {
      await invoke("sidecar_send", {
        tabId,
        message: JSON.stringify(payload),
      });
    } catch (err) {
      if (tab) markTabError(tab, err instanceof Error ? err.message : String(err));
      return false;
    }
    // Écho local du prompt dans le fil (cf. UserEcho, protocol.ts) — le
    // sidecar ne renvoie jamais les prompts, sans ça le fil est illisible.
    // Émis seulement une fois l'envoi confirmé : un écho dispatché avant
    // l'invoke afficherait comme livré un message qui ne l'est pas.
    dispatchSessionMessage(tabId, {
      type: "user_echo",
      id: payload.id,
      text: trimmed,
    });
    return true;
  }

  function buildPromptBar(): void {
    const form = document.createElement("form");
    form.className = "den-prompt-bar";

    const textarea = document.createElement("textarea");
    textarea.className = "den-prompt-bar__input";
    textarea.rows = 2;
    textarea.placeholder = "Message pour Claude…";

    const submitEl = document.createElement("button");
    submitEl.type = "submit";
    submitEl.className = "den-prompt-bar__submit";
    submitEl.textContent = "Envoyer";

    form.append(textarea, submitEl);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!activeTabId) return;
      const text = textarea.value;
      textarea.value = "";
      void sendPrompt(activeTabId, text).then((sent) => {
        // Envoi en échec : restituer le texte tapé (sauf si l'utilisateur a
        // déjà commencé autre chose) plutôt que de le perdre.
        if (!sent && textarea.value.length === 0) {
          textarea.value = text;
        }
      });
    });

    // Entrée envoie, Maj+Entrée insère un saut de ligne.
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    ctx.mounts.conversation.appendChild(form);
  }

  ctx.mounts.tabs.textContent = "";
  const list = document.createElement("div");
  list.className = "den-tab-list";
  list.setAttribute("role", "tablist");

  const addEl = document.createElement("button");
  addEl.type = "button";
  addEl.className = "den-tab-add";
  addEl.textContent = "+";
  addEl.setAttribute("aria-label", "Nouvel onglet");
  addEl.addEventListener("click", () => {
    const tab = createTab(DEFAULT_CWD);
    setActiveTab(tab.id);
  });

  ctx.mounts.tabs.append(list, addEl);

  buildPromptBar();

  // Premier tab créé au démarrage — den:active-tab-changed doit être émis
  // pour lui aussi (contrat inter-lots), pas seulement pour les bascules
  // ultérieures.
  const first = createTab(DEFAULT_CWD);
  setActiveTab(first.id);
}
