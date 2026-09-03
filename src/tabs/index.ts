/**
 * Module `tabs` — barre d'onglets, un sidecar par session/tab, ancré dans un
 * projet (DEN-04 A1 : plus de tab auto au démarrage, plus de `cwd` "." par
 * défaut — chaque tab naît d'un projet choisi via « Launch Claude in… »).
 *
 * Contrat inter-lots (événements DOM sur `window` ; `tabs` consomme en plus
 * l'API du module `workspace` — projets, picker, cf. `src/workspace/index.ts`) :
 * - `den:session-message` (`detail: { tabId, message: ConversationMessage }`) :
 *   chaque message sidecar reçu et validé contre le protocole wire, plus
 *   l'écho local `user_echo` fabriqué ici à l'envoi d'un prompt (cf.
 *   `src/types/protocol.ts` — `UserEcho` n'est jamais sur le wire).
 * - `den:active-tab-changed`
 *   (`detail: { tabId: string | null, projectId: string | null }`) à chaque
 *   changement de tab actif, y compris `{ null, null }` quand le dernier tab
 *   se ferme (aucune session restante).
 *
 * Sélecteur de mode de permission par tab (DEN-03) : un unique `<select>`
 * reflète le mode EFFECTIF du tab actif (jamais optimiste — cf.
 * `setModeSelectValue`). Un changement utilisateur envoie `set_mode` au
 * sidecar du tab actif ; la valeur affichée ne bascule que sur réception
 * d'un `mode_changed` (guard `isModeChanged`, routé par `router.ts` comme
 * les autres messages sidecar -> UI).
 *
 * Un sidecar par tab (`sidecar_spawn`/`sidecar_send`/`sidecar_kill`, cf.
 * `src-tauri/src/sidecar.rs`) — un crash n'emporte qu'un tab (routage/état
 * isolés par tabId, cf. `router.ts`).
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
import { addProject, getProjects, pickProjectDirectory } from "../workspace";
import { displayName, type Project } from "../workspace/store";
import { TabRouter } from "./router";

interface Tab {
  id: string;
  projectId: string;
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

export async function init(ctx: DenContext): Promise<void> {
  // Purge des sidecars d'une éventuelle session précédente (DEN-06) — AVANT
  // tout `sidecar_spawn` : la résolution de cet invoke est garantie ici
  // avant que la moindre UI capable de spawn (bouton "Launch Claude in…")
  // n'existe, donc avant qu'aucun `createTab` ne puisse s'exécuter.
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
  // Renseignés par buildPromptBar — désactivés tant qu'aucune session n'est
  // active (cf. updateEmptyState).
  let promptInputEl: HTMLTextAreaElement | null = null;
  let promptSubmitEl: HTMLButtonElement | null = null;

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

  /** Projet du tab, retrouvé par `projectId` dans la liste courante — pas de
   * référence figée sur `Tab` : le nom affiché (collision de basename) doit
   * rester correct si d'autres projets sont ajoutés ensuite. */
  function projectOf(tab: Tab): Project | undefined {
    return getProjects().find((p) => p.id === tab.projectId);
  }

  function tabLabel(tab: Tab): string {
    const project = projectOf(tab);
    return project ? displayName(project, getProjects()) : tab.projectId;
  }

  function dispatchSessionMessage(
    tabId: string,
    message: ConversationMessage,
  ): void {
    window.dispatchEvent(
      new CustomEvent("den:session-message", { detail: { tabId, message } }),
    );
  }

  function dispatchActiveTabChanged(tabId: string | null, projectId: string | null): void {
    window.dispatchEvent(
      new CustomEvent("den:active-tab-changed", { detail: { tabId, projectId } }),
    );
  }

  function updateSessionHeader(): void {
    const tab = activeTabId ? tabs.get(activeTabId) : undefined;
    if (!tab) {
      sessionHeaderNameEl.textContent = "Aucune session";
      sessionHeaderEl.removeAttribute("title");
      sessionHeaderIdEl.textContent = "";
      return;
    }
    const project = projectOf(tab);
    sessionHeaderNameEl.textContent = tabLabel(tab);
    if (project) sessionHeaderEl.title = project.path;
    else sessionHeaderEl.removeAttribute("title");
    sessionHeaderIdEl.textContent = tab.sessionId ? tab.sessionId.slice(0, 8) : "";
  }

  /** Sans session active : état vide visible, et prompt bar + sélecteur de
   * mode désactivés — sinon un « Envoyer » ne fait rien en silence, et un
   * mode choisi avant le lancement serait affiché sans jamais être envoyé. */
  function updateEmptyState(): void {
    const idle = activeTabId === null;
    emptyStateEl.hidden = !idle;
    modeSelect.disabled = idle;
    if (promptInputEl) promptInputEl.disabled = idle;
    if (promptSubmitEl) promptSubmitEl.disabled = idle;
  }

  function setActiveTab(tabId: string | null): void {
    activeTabId = tabId;
    const active = tabId ? tabs.get(tabId) : undefined;
    for (const tab of tabs.values()) {
      const selected = tab.id === tabId;
      tab.buttonEl.setAttribute("aria-selected", String(selected));
      tab.buttonEl.classList.toggle("den-tab--active", selected);
    }
    // Sans tab actif, le select ne reflète plus aucun mode effectif : retour
    // au défaut plutôt qu'un mode périmé du tab qui vient de fermer.
    setModeSelectValue(modeSelect, active ? active.mode : "default");
    updateSessionHeader();
    updateEmptyState();
    dispatchActiveTabChanged(tabId, active?.projectId ?? null);
  }

  function updateTabTitle(tab: Tab): void {
    tab.titleEl.textContent = tab.sessionId
      ? `${tabLabel(tab)} ${tab.sessionId.slice(0, 8)}`
      : tabLabel(tab);
    if (activeTabId === tab.id) updateSessionHeader();
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
      // Dernier tab fermé -> `{ null, null }` (contrat inter-lots) : sans ça
      // la conversation du tab mort restait affichée (bug corrigé au passage).
      setActiveTab(remaining.length > 0 ? remaining[0] : null);
    }
  }

  function createTab(project: Project): Tab {
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

    const tab: Tab = { id, projectId: project.id, mode: "default", buttonEl, titleEl, statusEl };
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

    invoke("sidecar_spawn", { tabId: id, cwd: project.path, onMessage: channel }).catch(
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

    promptInputEl = textarea;
    promptSubmitEl = submitEl;
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

  /** Ouvre le picker natif, ajoute (ou retrouve) le projet choisi et lui
   * ouvre une session. `null` (picker annulé) : rien ne se passe, pas
   * d'erreur console. */
  let launching = false;
  async function launchInProject(): Promise<void> {
    // Anti-réentrance : un second clic pendant le picker ou le `save` du
    // projet ouvrirait deux sessions pour un seul geste.
    if (launching) return;
    launching = true;
    try {
      const path = await pickProjectDirectory();
      if (path === null) return;
      const project = await addProject(path);
      const tab = createTab(project);
      // Un projet ajouté peut créer une collision de basename avec un tab
      // existant : tous les titres sont recalculés, pas seulement le nouveau.
      for (const other of tabs.values()) updateTabTitle(other);
      setActiveTab(tab.id);
    } finally {
      launching = false;
    }
  }

  /** Un même bouton « Launch Claude in… », dupliqué dans la barre d'onglets
   * et dans l'état vide (même libellé, même action). */
  function createLaunchButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "den-launch";
    button.textContent = "Launch Claude in…";
    button.setAttribute("aria-label", "Launch Claude in…");
    button.addEventListener("click", () => {
      void launchInProject().catch((err: unknown) => {
        console.error("Den: échec du picker/lancement de projet", err);
      });
    });
    return button;
  }

  ctx.mounts.tabs.textContent = "";
  const list = document.createElement("div");
  list.className = "den-tab-list";
  list.setAttribute("role", "tablist");
  ctx.mounts.tabs.append(list, createLaunchButton());

  // Header de session, en tête du mount conversation — `prepend` s'exécute
  // après celui de `markdown` (`.den-views`, cf. ordre d'init dans main.ts) :
  // le header passe donc au-dessus du fil.
  const sessionHeaderEl = document.createElement("div");
  sessionHeaderEl.className = "den-session-header";
  const sessionHeaderNameEl = document.createElement("span");
  sessionHeaderNameEl.className = "den-session-header__name";
  const sessionHeaderIdEl = document.createElement("span");
  sessionHeaderIdEl.className = "den-session-header__id";
  sessionHeaderEl.append(sessionHeaderNameEl, sessionHeaderIdEl);
  ctx.mounts.conversation.prepend(sessionHeaderEl);

  // État vide — visible ssi aucun tab actif (démarrage, ou dernier tab
  // fermé).
  const emptyStateEl = document.createElement("div");
  emptyStateEl.className = "den-empty-state";
  const emptyStateTextEl = document.createElement("p");
  emptyStateTextEl.textContent = "Ouvre un projet pour démarrer une session";
  emptyStateEl.append(emptyStateTextEl, createLaunchButton());
  ctx.mounts.conversation.append(emptyStateEl);

  buildPromptBar();

  // Aucun tab au démarrage (DEN-04 A1) — état vide affiché jusqu'au premier
  // « Launch Claude in… ».
  updateSessionHeader();
  updateEmptyState();
}
