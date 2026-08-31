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
 * Sélecteur de mode de permission par tab (DEN-03) : un unique `<select>`
 * reflète le mode EFFECTIF du tab actif (jamais optimiste — cf.
 * `setModeSelectValue`). Un changement utilisateur envoie `set_mode` au
 * sidecar du tab actif ; la valeur affichée ne bascule que sur réception
 * d'un `mode_changed` (guard `isModeChanged`, routé par `router.ts` comme
 * les autres messages sidecar -> UI).
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
  isModeChanged,
  isSessionInfo,
  type ConversationMessage,
  type PermissionModeId,
} from "../types/protocol";
import { TabRouter } from "./router";

interface Tab {
  id: string;
  cwd: string;
  sessionId?: string;
  /** Mode de permission effectif du tab — un nouveau tab démarre en
   * "default" ; ne change que sur confirmation `mode_changed` du sidecar
   * (jamais d'optimisme, cf. sélecteur de mode dans `init`). */
  mode: PermissionModeId;
  buttonEl: HTMLButtonElement;
  titleEl: HTMLSpanElement;
  statusEl: HTMLSpanElement;
}

/** Options fixes du sélecteur de mode — libellés en anglais (arbitrage
 * produit, cf. blocks.ts). Un mode reçu hors de cette liste (ex.
 * `bypassPermissions`) est ajouté dynamiquement par `ensureModeOption` pour
 * rester honnête sur le mode réel du tab plutôt que de le masquer. */
const MODE_OPTIONS: Array<{ value: PermissionModeId; label: string }> = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
];

/** Ajoute une option pour `mode` si le select ne la connaît pas déjà.
 * Désactivée : un mode hors MVP (ex. `bypassPermissions`) doit être
 * affichable comme état effectif, mais jamais sélectionnable à la main —
 * le select est partagé entre tous les tabs, une option cliquable ferait de
 * n'importe quel mode reçu une escalade à un clic depuis n'importe quel tab. */
function ensureModeOption(select: HTMLSelectElement, mode: PermissionModeId): void {
  if ([...select.options].some((option) => option.value === mode)) return;
  const option = document.createElement("option");
  option.value = mode;
  option.textContent = mode;
  option.disabled = true;
  select.appendChild(option);
}

/** Reflète `mode` dans le select (ajoute l'option au besoin) — jamais
 * d'optimisme : n'appeler qu'avec le mode EFFECTIF (courant ou confirmé). */
function setModeSelectValue(select: HTMLSelectElement, mode: PermissionModeId): void {
  ensureModeOption(select, mode);
  select.value = mode;
}

/**
 * Cwd par défaut d'un nouveau tab. Aucun sélecteur de dossier natif n'est
 * dans le périmètre de ce lot (pas de plugin dialog installé) — "." résout
 * côté Rust au cwd du process app. Limitation connue : pas d'édition du cwd
 * après création dans ce lot (à couvrir par une UI dédiée si besoin).
 */
const DEFAULT_CWD = ".";

export async function init(ctx: DenContext): Promise<void> {
  // Purge des sidecars d'une éventuelle session précédente (DEN-06) — AVANT
  // tout `sidecar_spawn` : la résolution de cet invoke est garantie ici
  // avant que la moindre UI capable de spawn (bouton "+", premier tab plus
  // bas) n'existe, donc avant qu'aucun `createTab` ne puisse s'exécuter.
  // Sans cette garantie d'ordre, un `sidecar_kill_all` qui résoudrait après
  // le premier `sidecar_spawn` de CETTE session tuerait le sidecar qu'on
  // vient de faire naître. Volontairement PAS de timeout sur cet await : un
  // `invoke` Tauri n'est pas annulable — un `Promise.race` n'abandonnerait
  // que l'attente JS, laissant le kill_all en vol côté Rust s'exécuter
  // APRÈS le premier spawn et tuer le tab qu'on vient d'ouvrir (la race
  // exacte que ce commentaire décrit). L'await nu, lui, garantit l'ordre
  // par construction. Contrepartie assumée : un IPC qui ne répond jamais
  // fige le bootstrap — mais un IPC incapable de drainer une HashMap ne
  // servirait pas davantage le spawn suivant ; l'app serait morte de toute
  // façon, autant que ce soit visible.
  try {
    await invoke("sidecar_kill_all");
  } catch (err) {
    console.error("Den: échec sidecar_kill_all au démarrage", err);
  }

  const router = new TabRouter();
  const tabs = new Map<string, Tab>();
  let activeTabId: string | null = null;

  const modeSelect = document.createElement("select");
  modeSelect.className = "den-mode-select";
  modeSelect.setAttribute("aria-label", "Permission mode");
  for (const { value, label } of MODE_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    modeSelect.appendChild(option);
  }
  modeSelect.addEventListener("change", () => {
    const tabId = activeTabId;
    const tab = tabId ? tabs.get(tabId) : undefined;
    if (!tabId || !tab) return;
    const mode = modeSelect.value as PermissionModeId;
    invoke("sidecar_send", {
      tabId,
      message: JSON.stringify({ type: "set_mode", mode }),
    }).catch((err: unknown) => {
      // Même traitement que les autres échecs d'envoi (cf. sendPrompt) : un
      // set_mode perdu sans signal UI serait relu comme un bug du sélecteur.
      markTabError(tab, err instanceof Error ? err.message : String(err));
    });
    // Pas d'optimisme : le select revient au mode effectif courant tant que
    // le sidecar n'a pas confirmé via `mode_changed` (cf. handler du channel
    // plus bas).
    setModeSelectValue(modeSelect, tab.mode);
  });

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
    const active = tabs.get(tabId);
    if (active) setModeSelectValue(modeSelect, active.mode);
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

    const tab: Tab = { id, cwd, mode: "default", buttonEl, titleEl, statusEl };
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
        } else if (isModeChanged(message)) {
          // Idempotent : un doublon de mode_changed réécrit la même valeur
          // sans effet observable.
          tab.mode = message.mode;
          if (activeTabId === id) setModeSelectValue(modeSelect, tab.mode);
        }
        // Dispatché aussi bien pour les messages "métier" que pour
        // mode_changed — le module interactive l'ignore, mais le contrat
        // d'événement reste uniforme (cf. docstring de tête).
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

    // Colonne de droite : bouton d'envoi + sélecteur de mode dessous
    // (retour grill DEN-03 : le sélecteur vit près de la saisie, pas dans la
    // barre d'onglets).
    const side = document.createElement("div");
    side.className = "den-prompt-bar__side";
    side.append(submitEl, modeSelect);

    form.append(textarea, side);
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
