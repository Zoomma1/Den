/**
 * Module `tabs` — sidebar workspace → projet → sessions (DEN-04 A2bis-2 :
 * arbre à 3 niveaux, remplace la liste plate de projets d'A2 — cf.
 * `./sidebar.ts` pour le rendu DOM pur des rows, `./owner.ts` pour les
 * fonctions pures autour du nœud de rangement d'une session). Un sidecar
 * par session/tab, ancré à un `owner` (racine, workspace ou projet) — le
 * `cwd` de la session est figé au spawn, indépendant de l'`owner` (déplacer
 * un projet, ou changer la racine d'un workspace, ne bouge aucune session
 * déjà ouverte). Plus jamais de `$HOME` implicite : chaque `cwd` vient soit
 * d'un projet/racine de workspace déjà choisi, soit d'un picker natif ouvert
 * au moment du geste.
 *
 * Contrat inter-lots (événements DOM sur `window` ; `tabs` consomme en plus
 * l'API du module `workspace` — workspaces/projets, picker, cf.
 * `src/workspace/index.ts`) :
 * - `den:session-message` (`detail: { tabId, message: ConversationMessage }`) :
 *   chaque message sidecar reçu et validé contre le protocole wire, plus
 *   l'écho local `user_echo` fabriqué ici à l'envoi d'un prompt (cf.
 *   `src/types/protocol.ts` — `UserEcho` n'est jamais sur le wire).
 * - `den:active-tab-changed`
 *   (`detail: { tabId: string | null, cwd: string | null, owner: Owner | null }`)
 *   à chaque changement de tab actif, tout à `null` quand le dernier tab se
 *   ferme (aucune session restante).
 * - `den:owner-removed` (`detail: { kind: "workspace" | "project", id: string }`),
 *   émis par `onRemove` APRÈS que tous les tabs du nœud (et, pour un
 *   workspace, de ses projets) ont fini de fermer (chaque `sidecar_kill`
 *   attendu, séquentiellement) et que le nœud a été retiré de l'état
 *   persisté. Remplace `den:project-removed` (A2) — même contrat, étendu aux
 *   workspaces. Ancrage DEN-04 A4 : le module terminal y fera le `pty_kill`
 *   du groupe de terminaux du nœud — aucun consommateur aujourd'hui, cet
 *   événement est un no-op observable tant qu'A4 n'est pas fait.
 * - `den:tab-state-changed` (`detail: { tabId: string, state: TabLifecycleState }`) :
 *   émis quand l'état de lifecycle d'un tab (cf. `./lifecycle.ts`, seule
 *   source de vérité — DEN-10) change réellement, après chaque
 *   `router.handleChunk` et après chaque `router.markPromptSubmitted`. Le
 *   spinner du fil (module markdown) s'y abonne pour afficher "réfléchit…"
 *   (`running`) ou "attend ta réponse" (`waiting`) ; ce module s'y abonne
 *   lui-même (cf. `syncSubmitButton`) pour transformer le bouton d'envoi en
 *   Stop tant que le tab ACTIF tourne un tour.
 * - `den:edit-prompt` (`detail: { tabId: string, text: string }`), émis par
 *   `src/markdown/conversationView.ts` (bouton `.den-edit` sur une bulle
 *   user, D5) : reprend `text` dans la textarea du prompt SSI `tabId` est le
 *   tab actif — n'interrompt rien, l'utilisateur fait Stop lui-même d'abord
 *   si un tour tourne encore.
 *
 * Stop (D4) : pendant qu'un tour tourne sur le tab actif, le bouton
 * d'envoi devient "Stop" (`syncSubmitButton`, lu depuis `router.getState` —
 * aucun second compteur ici) et un clic envoie `{ type: "interrupt" }` au
 * sidecar (`sendInterrupt`) sans toucher au contenu de la textarea. Le
 * bouton ne redevient "Envoyer" que sur le `done` qui fait retomber l'état à
 * `idle` — jamais d'optimisme. `Escape` dans la textarea fait la même chose
 * quand le tab actif tourne.
 *
 * Sélecteur de mode de permission par tab (DEN-03) : un unique `<select>`
 * reflète le mode EFFECTIF du tab actif (jamais optimiste — cf.
 * `setModeSelectValue`). Un changement utilisateur envoie `set_mode` au
 * sidecar du tab actif ; la valeur affichée ne bascule que sur réception
 * d'un `mode_changed` (guard `isModeChanged`, routé par `router.ts` comme
 * les autres messages sidecar -> UI).
 *
 * Header de session (`updateSessionHeader`) : `basename(cwd)` (pas de
 * désambiguïsation — c'est le rôle de `displayName` côté rows sidebar, pas
 * du header) + `shortPath(cwd, home)` sous forme d'un second span, `title`
 * du header = `cwd` complet. `home` (repli `~`) vient de `homeDir()`
 * (`@tauri-apps/api/path`), résolu une fois dans `init` ; indisponible ->
 * `null`, jamais de crash, juste pas de substitution `~`.
 *
 * Un seul verrou (`withBusy`) garde tous les gestes de création — launch,
 * + Workspace, racine…, + projet, + session sur un workspace — anti-
 * réentrance comme l'ancien `launching` ; les retraits ont le leur
 * (`removing`, par nœud). Picker annulé : rien, pas d'erreur console.
 *
 * Un sidecar par tab (`sidecar_spawn`/`sidecar_send`/`sidecar_kill`, cf.
 * `src-tauri/src/sidecar.rs`) — un crash n'emporte qu'un tab (routage/état
 * isolés par tabId, cf. `router.ts`).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import "./tabs.css";
import type { DenContext } from "../core/registry";
import {
  isErrorMessage,
  isModeChanged,
  isSessionInfo,
  type ConversationMessage,
  type PermissionModeId,
} from "../types/protocol";
import {
  addProject,
  addWorkspace,
  getState,
  pickProjectDirectory,
  probePath,
  removeProject,
  removeWorkspace,
  renameWorkspace,
  setWorkspaceRoot,
} from "../workspace";
import { projectsOfWorkspace } from "../workspace/store";
import {
  basename,
  ownerKey,
  resolveCwd,
  shortPath,
  type Owner,
} from "./owner";
import type { TabLifecycleState } from "./lifecycle";
import { TabRouter } from "./router";
import { createSidebar, type Sidebar } from "./sidebar";

interface Tab {
  id: string;
  /** `cwd` figé au spawn — jamais recalculé après coup (cf. docstring de
   * tête : indépendant de `owner`). */
  cwd: string;
  /** Nœud de rangement de cette session — indépendant du `cwd`. */
  owner: Owner;
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

  // Repli `~` du header de session (cf. docstring de tête) — couvert par
  // `core:default` (`core:path:default`), aucune permission nouvelle. Échec
  // = pas de substitution `~`, jamais de crash : `shortPath` gère `null`.
  let home: string | null = null;
  try {
    home = (await homeDir()).replace(/\/+$/, "");
  } catch (err) {
    console.warn("den: homeDir indisponible, pas de substitution ~ dans le header.", err);
  }

  const router = new TabRouter();
  const tabs = new Map<string, Tab>();
  let activeTabId: string | null = null;
  // Assignée plus bas (setup DOM, cf. bas de `init`) — les fonctions qui la
  // ferment (`createTab`, `onRemove`...) ne sont appelées qu'après cette
  // assignation (clic utilisateur), jamais avant.
  let sidebar: Sidebar;
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

  function dispatchSessionMessage(
    tabId: string,
    message: ConversationMessage,
  ): void {
    window.dispatchEvent(
      new CustomEvent("den:session-message", { detail: { tabId, message } }),
    );
  }

  /** `tab === null` -> `{ tabId: null, cwd: null, owner: null }` (dernier tab
   * fermé, ou aucune session active). */
  function dispatchActiveTabChanged(tab: Tab | null): void {
    window.dispatchEvent(
      new CustomEvent("den:active-tab-changed", {
        detail: tab
          ? { tabId: tab.id, cwd: tab.cwd, owner: tab.owner }
          : { tabId: null, cwd: null, owner: null },
      }),
    );
  }

  /** Reflète en direct l'état `running` du tab ACTIF sur le bouton d'envoi
   * (D4) — "Stop" (`type="button"`, cf. `sendInterrupt`) tant qu'un tour
   * tourne sur ce tab, "Envoyer" (`type="submit"`, comportement natif du
   * form) sinon. Lit `router.getState`, ne compte rien elle-même (seule
   * source de vérité : `./lifecycle.ts`). Idempotente : rappelable sans
   * condition depuis n'importe quel point qui peut avoir changé l'état
   * affiché (tab actif changé, ou état du tab actif changé). */
  function syncSubmitButton(): void {
    if (!promptSubmitEl) return;
    const state = activeTabId ? router.getState(activeTabId) : undefined;
    // `waiting` aussi (review 07/09) : un tour bloqué sur une permission
    // doit pouvoir être stoppé — `interrupt()` annule le tool call en attente.
    if (state === "running" || state === "waiting") {
      promptSubmitEl.type = "button";
      promptSubmitEl.textContent = "Stop";
      promptSubmitEl.classList.add("den-prompt-bar__submit--stop");
    } else {
      promptSubmitEl.type = "submit";
      promptSubmitEl.textContent = "Envoyer";
      promptSubmitEl.classList.remove("den-prompt-bar__submit--stop");
    }
  }

  /** Émet `den:tab-state-changed` ssi l'état de lifecycle du tab a
   * effectivement changé depuis `previousState` — un tab fermé entre-temps
   * (`getState` -> undefined) n'émet rien. Unique point d'émission de cet
   * événement (cf. docstring de tête), appelé après chaque
   * `router.handleChunk` et après chaque `router.markPromptSubmitted`. */
  function emitStateIfChanged(
    tabId: string,
    previousState: TabLifecycleState | undefined,
  ): void {
    const state = router.getState(tabId);
    if (state === undefined || state === previousState) return;
    window.dispatchEvent(
      new CustomEvent("den:tab-state-changed", { detail: { tabId, state } }),
    );
    // Au même endroit que l'émission (jamais via un listener window sur son
    // propre événement, cf. docstring de tête) — le tab qui a changé n'est
    // pas forcément le tab actif, mais `syncSubmitButton` relit toujours
    // l'état du tab actif : un appel pour un tab en arrière-plan est un
    // no-op observable.
    syncSubmitButton();
  }

  /** Envoie `{ type: "interrupt" }` au sidecar du tab (D4) — clic sur le
   * bouton Stop, ou `Escape` dans la textarea pendant que le tab actif
   * tourne. Ne touche jamais au contenu de la textarea : seul le prochain
   * `done` (via `syncSubmitButton`) fait revenir le bouton à "Envoyer". */
  async function sendInterrupt(tabId: string): Promise<void> {
    const tab = tabs.get(tabId);
    try {
      await invoke("sidecar_send", {
        tabId,
        message: JSON.stringify({ type: "interrupt" }),
      });
    } catch (err) {
      // Même traitement que les autres échecs d'envoi (cf. sendPrompt) : un
      // interrupt perdu sans signal UI laisserait croire à un Stop qui n'a
      // jamais atteint le sidecar.
      if (tab) markTabError(tab, err instanceof Error ? err.message : String(err));
    }
  }

  /** Reflète l'état de lifecycle sur le chip d'onglet — "…" tant qu'un tour
   * tourne ou qu'un tab attend une réponse utilisateur, vide sinon. Ne
   * touche jamais l'état `error` : son texte (message complet) est posé par
   * `markTabError`, jamais écrasé ici. Remplace l'ancien
   * `isDone(...) && getState !== "error"` — un `done` peut désormais laisser
   * le tab `running` s'il reste un tour en file (compteur lifecycle). */
  function updateTabChip(tab: Tab, state: TabLifecycleState): void {
    if (state === "running" || state === "waiting") {
      tab.statusEl.textContent = "…";
    } else if (state === "idle") {
      tab.statusEl.textContent = "";
    }
  }

  function updateSessionHeader(): void {
    const tab = activeTabId ? tabs.get(activeTabId) : undefined;
    if (!tab) {
      sessionHeaderNameEl.textContent = "Aucune session";
      sessionHeaderPathEl.textContent = "";
      sessionHeaderEl.removeAttribute("title");
      sessionHeaderIdEl.textContent = "";
      return;
    }
    sessionHeaderNameEl.textContent = basename(tab.cwd);
    sessionHeaderPathEl.textContent = shortPath(tab.cwd, home);
    sessionHeaderEl.title = tab.cwd;
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
    syncSubmitButton();
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
    syncSubmitButton();
    dispatchActiveTabChanged(active ?? null);
  }

  /** Titre de la row session : `sessionId` court (dès `session_info`), ou
   * placeholder avant — le nom du nœud parent est déjà porté par la row
   * (`.den-workspace__name` / `.den-project__name`, sidebar.ts), pas besoin
   * de le répéter ici. Le header du pane (`updateSessionHeader`), lui, garde
   * `basename(cwd) + shortPath(cwd) + sessionId`. */
  function updateTabTitle(tab: Tab): void {
    tab.titleEl.textContent = tab.sessionId ? tab.sessionId.slice(0, 8) : "nouvelle session";
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
      // Dernier tab fermé -> tout `null` (contrat inter-lots) : sans ça la
      // conversation du tab mort restait affichée (bug corrigé au passage).
      setActiveTab(remaining.length > 0 ? remaining[0] : null);
    }
  }

  /** Crée un tab pour l'`owner` donné, avec `cwd` FIGÉ au spawn (cf.
   * docstring de tête — jamais recalculé après coup, indépendant de
   * l'`owner`). */
  function createTab(owner: Owner, cwd: string): Tab {
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

    sidebar.appendSessionRow(owner, buttonEl);

    const tab: Tab = { id, cwd, owner, mode: "default", buttonEl, titleEl, statusEl };
    tabs.set(id, tab);
    updateTabTitle(tab);
    router.registerTab(id);

    const channel = new Channel<string>();
    channel.onmessage = (chunk) => {
      const previousState = router.getState(id);
      for (const { message } of router.handleChunk(id, chunk)) {
        if (isSessionInfo(message)) {
          tab.sessionId = message.sessionId;
          updateTabTitle(tab);
        } else if (isErrorMessage(message)) {
          markTabError(tab, message.message);
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
      // Chip et événement de lifecycle basés sur l'état RÉSULTANT du chunk
      // entier (pas message par message) — cf. `emitStateIfChanged`.
      const state = router.getState(id);
      if (state && state !== "error") updateTabChip(tab, state);
      emitStateIfChanged(id, previousState);
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
    const previousState = router.getState(tabId);
    if (previousState === "error") return false;

    router.markPromptSubmitted(tabId);
    emitStateIfChanged(tabId, previousState);
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
    textarea.placeholder = "Message pour Claude… (⌘⏎ pour envoyer)";

    const submitEl = document.createElement("button");
    submitEl.type = "submit";
    submitEl.className = "den-prompt-bar__submit";
    submitEl.textContent = "Envoyer";
    // Mode Stop (D4, cf. syncSubmitButton) : le bouton passe en
    // `type="button"` — ce clic-ci n'est alors PAS un submit de form, donc
    // le listener "submit" du form ci-dessous ne s'en charge pas.
    submitEl.addEventListener("click", () => {
      if (submitEl.type === "button" && activeTabId) {
        void sendInterrupt(activeTabId);
      }
    });

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

    // Entrée seule : comportement natif (saut de ligne, on ne fait rien) —
    // Entrée + Ctrl/Cmd/Maj envoie (D3, retour grill : des messages
    // partaient par accident sur un simple Entrée). `requestSubmit()` marche
    // même quand le bouton est en `type="button"` (mode Stop) : le submit du
    // form ne dépend pas du bouton qui le déclenche.
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
        return;
      }
      // Escape interrompt le tour en cours du tab actif (D4) — rien si le
      // tab actif n'est pas `running` (ex. laisser Escape à son usage
      // natif ailleurs, comme fermer un select ouvert).
      const activeState = activeTabId ? router.getState(activeTabId) : undefined;
      if (event.key === "Escape" && activeTabId && (activeState === "running" || activeState === "waiting")) {
        event.preventDefault();
        void sendInterrupt(activeTabId);
      }
    });

    ctx.mounts.conversation.appendChild(form);
  }

  // Verrou PARTAGÉ par tous les gestes de création (launch, + Workspace,
  // racine…, + projet, + session sur un workspace) — un second clic pendant
  // que l'un d'eux tourne (picker natif ouvert, IPC en vol) est un no-op,
  // sans ça un double-clic dupliquerait la création (deux workspaces, deux
  // sessions) ou ouvrirait deux pickers. Le picker natif est modal : un
  // clic sur un autre nœud pendant qu'il est ouvert est de toute façon
  // impossible, le verrou ne coûte rien de plus à l'utilisateur. Ne pas
  // imbriquer deux `withBusy` : l'intérieur serait un no-op.
  let busy = false;
  async function withBusy(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  }

  /** « Launch Claude in… » (bouton de la barre racine et de l'état vide) :
   * picker natif, puis session **au niveau racine** de l'arbre (owner
   * `root`) dans le dossier choisi — aucun projet ni workspace créé ou
   * modifié (décision grill A2bis-2 du 11/09 : on lance au plus haut niveau,
   * le rangement viendra du drag & drop, hors de ce lot ; ranger une session
   * sous un projet passe pour l'instant par « + projet » puis le `+` du
   * projet). `null` (picker annulé) : rien ne se passe, pas d'erreur
   * console. */
  async function launchRootSession(): Promise<void> {
    await withBusy(async () => {
      const path = await pickProjectDirectory("Choisis le dossier de la session");
      if (path === null) return;
      const tab = createTab({ kind: "root", id: null }, path);
      setActiveTab(tab.id);
    });
  }

  /** « + Workspace » : crée un workspace sans racine et ouvre aussitôt son
   * renommage inline. Sous verrou : un double-clic ne doit pas créer deux
   * workspaces (ni deux inputs de renommage). */
  async function onAddWorkspace(): Promise<void> {
    await withBusy(async () => {
      const workspace = await addWorkspace("Nouveau workspace");
      sidebar.setState(getState());
      sidebar.beginRename(workspace.id);
    });
  }

  async function onRenameWorkspace(id: string, name: string): Promise<void> {
    await renameWorkspace(id, name);
    sidebar.setState(getState());
  }

  async function onSetWorkspaceRoot(id: string): Promise<void> {
    await withBusy(async () => {
      const path = await pickProjectDirectory("Choisis la racine du workspace");
      if (path === null) return;
      await setWorkspaceRoot(id, path);
      sidebar.setState(getState());
    });
  }

  /** Ajoute un projet (dossier choisi) sous le workspace `wsId` (bouton
   * « + projet » d'une row workspace), sans ouvrir de session — c'est au `+`
   * de la row projet résultante d'en ouvrir une. Workspace en cours de
   * retrait : no-op avant même le picker ; retiré pendant le picker :
   * `addProject` rend `null`, rien n'est écrit. */
  async function onAddProject(wsId: string): Promise<void> {
    if (removing.has(ownerKey({ kind: "workspace", id: wsId }))) return;
    await withBusy(async () => {
      const path = await pickProjectDirectory();
      if (path === null) return;
      const project = await addProject(wsId, path);
      if (project === null) return;
      sidebar.setState(getState());
    });
  }

  /** Ouvre une session sur le workspace `owner` : racine déjà valide (existe
   * encore sur disque) -> spawn direct ; racine absente ou disparue -> picker
   * (titre qui distingue "jamais posée" de "introuvable") puis
   * `setWorkspaceRoot` AVANT le spawn — la racine posée par ce geste devient
   * la racine persistée du workspace, relue canonicalisée depuis l'état.
   * Tout le geste est sous verrou (`withBusy`), y compris le chemin rapide :
   * un double-clic sur `+` ne doit pas spawner deux sessions. */
  async function onNewWorkspaceSession(owner: Owner): Promise<void> {
    const workspaceId = owner.id;
    if (workspaceId === null) return;
    await withBusy(async () => {
      const workspace = getState().workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;

      let rootPath = workspace.rootPath;
      let pickerTitle = "Choisis la racine du workspace";
      if (rootPath !== null && !(await probePath(rootPath))) {
        rootPath = null;
        pickerTitle = "Racine introuvable — choisis la racine du workspace";
      }

      if (rootPath === null) {
        const path = await pickProjectDirectory(pickerTitle);
        if (path === null) return;
        await setWorkspaceRoot(workspaceId, path);
        sidebar.setState(getState());
        // Valeur canonicalisée persistée par `setWorkspaceRoot`, pas le path
        // brut du picker (`null` si le workspace a disparu entre-temps :
        // `setWorkspaceRoot` est alors un no-op).
        rootPath = getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null;
        if (rootPath === null) return;
      }
      // Après les `await` (probePath, picker) : le workspace a pu être retiré
      // entre-temps — un `createTab` ici spawnerait un sidecar sans row pour
      // le fermer (review A2bis-2). Revérification synchrone, juste avant le
      // spawn, sur les deux chemins.
      if (removing.has(ownerKey(owner))) return;
      if (!getState().workspaces.some((w) => w.id === workspaceId)) return;

      const tab = createTab(owner, rootPath);
      setActiveTab(tab.id);
    });
  }

  /** Ouvre une nouvelle session sur `owner` (bouton `+` d'une row workspace
   * ou projet de la sidebar). Nœud retiré entre le clic et l'exécution (en
   * cours de retrait, ou déjà disparu) : no-op silencieux. */
  function onNewSession(owner: Owner): void {
    if (removing.has(ownerKey(owner))) return;
    if (owner.kind === "project") {
      const cwd = resolveCwd(owner, getState(), null);
      if (cwd === null) return;
      const tab = createTab(owner, cwd);
      setActiveTab(tab.id);
      return;
    }
    if (owner.kind === "workspace") {
      void onNewWorkspaceSession(owner).catch((err: unknown) => {
        console.error(`Den: échec de la nouvelle session pour le workspace ${owner.id}`, err);
      });
    }
  }

  /** Retire un workspace ou un projet (bouton `×` d'une row) : ferme
   * d'abord toutes ses sessions — et, pour un workspace, celles de ses
   * projets aussi — (`closeTab` -> `sidecar_kill`, séquentiel), puis retire
   * le nœud de l'état persisté (cascade côté store pour un workspace), re-
   * rend la sidebar, puis émet UN SEUL `den:owner-removed` (cf. docstring de
   * tête). Anti-réentrance par `ownerKey` sur le nœud ET, pour un workspace,
   * sur chacun de ses projets : un second `×` (le même nœud, son parent, ou
   * un de ses projets) pendant le retrait est un no-op, de même qu'un `+`
   * sur ces nœuds (cf. `onNewSession`, `onAddProject`) — sans ça deux
   * retraits imbriqués fermeraient les mêmes tabs deux fois et émettraient
   * deux événements, ou un tab créé pendant le retrait échapperait au
   * balayage (sidecar fuité). */
  const removing = new Set<string>();
  async function onRemove(owner: Owner): Promise<void> {
    const id = owner.id;
    if (owner.kind === "root" || id === null) return;
    const projectIds =
      owner.kind === "workspace" ? projectsOfWorkspace(getState(), id).map((p) => p.id) : [];
    const keys = [ownerKey(owner), ...projectIds.map((pid) => ownerKey({ kind: "project", id: pid }))];
    if (keys.some((k) => removing.has(k))) return;
    for (const k of keys) removing.add(k);
    try {
      const owned = new Set(keys);
      const tabsOfOwner = [...tabs.values()].filter((tab) => owned.has(ownerKey(tab.owner)));
      for (const tab of tabsOfOwner) {
        await closeTab(tab.id);
      }
      if (owner.kind === "workspace") await removeWorkspace(id);
      else await removeProject(id);
      sidebar.setState(getState());
      window.dispatchEvent(
        new CustomEvent("den:owner-removed", { detail: { kind: owner.kind, id } }),
      );
    } finally {
      for (const k of keys) removing.delete(k);
    }
  }

  /** Un même bouton « Launch Claude in… », dupliqué en tête de la sidebar
   * et dans l'état vide (même libellé, même action). */
  function createLaunchButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "den-launch";
    button.textContent = "Launch Claude in…";
    button.setAttribute("aria-label", "Launch Claude in…");
    button.addEventListener("click", () => {
      void launchRootSession().catch((err: unknown) => {
        console.error("Den: échec du picker/lancement de session", err);
      });
    });
    return button;
  }

  sidebar = createSidebar(
    ctx.mounts.sidebar,
    {
      onAddWorkspace: () => {
        void onAddWorkspace().catch((err: unknown) => {
          console.error("Den: échec de la création du workspace", err);
        });
      },
      onRenameWorkspace: (id, name) => {
        void onRenameWorkspace(id, name).catch((err: unknown) => {
          console.error(`Den: échec du renommage du workspace ${id}`, err);
        });
      },
      onSetWorkspaceRoot: (id) => {
        void onSetWorkspaceRoot(id).catch((err: unknown) => {
          console.error(`Den: échec du choix de racine pour le workspace ${id}`, err);
        });
      },
      onAddProject: (id) => {
        void onAddProject(id).catch((err: unknown) => {
          console.error(`Den: échec de l'ajout de projet au workspace ${id}`, err);
        });
      },
      onNewSession,
      onRemove: (owner) => {
        void onRemove(owner).catch((err: unknown) => {
          console.error(`Den: échec du retrait de ${ownerKey(owner)}`, err);
        });
      },
    },
    createLaunchButton,
  );
  sidebar.setState(getState());

  // Header de session, en tête du mount conversation — `prepend` s'exécute
  // après celui de `markdown` (`.den-views`, cf. ordre d'init dans main.ts) :
  // le header passe donc au-dessus du fil.
  const sessionHeaderEl = document.createElement("div");
  sessionHeaderEl.className = "den-session-header";
  const sessionHeaderNameEl = document.createElement("span");
  sessionHeaderNameEl.className = "den-session-header__name";
  const sessionHeaderPathEl = document.createElement("span");
  sessionHeaderPathEl.className = "den-session-header__path";
  const sessionHeaderIdEl = document.createElement("span");
  sessionHeaderIdEl.className = "den-session-header__id";
  sessionHeaderEl.append(sessionHeaderNameEl, sessionHeaderPathEl, sessionHeaderIdEl);
  ctx.mounts.conversation.prepend(sessionHeaderEl);

  // État vide — visible ssi aucun tab actif (démarrage, ou dernier tab
  // fermé).
  const emptyStateEl = document.createElement("div");
  emptyStateEl.className = "den-empty-state";
  const emptyStateTextEl = document.createElement("p");
  emptyStateTextEl.textContent = "Choisis un dossier pour démarrer une session";
  emptyStateEl.append(emptyStateTextEl, createLaunchButton());
  ctx.mounts.conversation.append(emptyStateEl);

  buildPromptBar();

  // Éditer (D5) : reprend le texte d'une bulle user dans la textarea du
  // prompt, SSI le message vient du tab actif — un tabId différent (bulle
  // d'un autre tab, éventuellement en arrière-plan) ne touche à rien. Pas
  // d'interruption automatique du tour en cours (cf. docstring de tête).
  window.addEventListener("den:edit-prompt", (event) => {
    const detail = (event as CustomEvent<{ tabId: string; text: string }>).detail;
    if (!detail || detail.tabId !== activeTabId || !promptInputEl) return;
    promptInputEl.value = detail.text;
    promptInputEl.focus();
    const len = promptInputEl.value.length;
    promptInputEl.setSelectionRange(len, len);
  });

  // Aucun tab au démarrage (DEN-04 A1) — état vide affiché jusqu'au premier
  // « Launch Claude in… ».
  updateSessionHeader();
  updateEmptyState();
}
