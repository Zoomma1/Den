/**
 * Module `tabs` — sidebar workspace → projet → sessions (DEN-04 A2bis-2 :
 * arbre workspace → projet, les sessions vivent dans les onglets — cf.
 * `./sidebar.ts` pour le rendu DOM pur des rows, `./owner.ts` pour les
 * fonctions pures autour du nœud de rangement d'une session). Un sidecar
 * par session/tab, ancré à un `owner` (toujours un projet, DEN-17) — le
 * `cwd` de la session est figé au spawn, indépendant de l'`owner` (déplacer
 * un projet, ou changer la racine d'un workspace, ne bouge aucune session
 * déjà ouverte). Plus jamais de `$HOME` implicite : chaque `cwd` vient soit
 * d'un projet déjà choisi, soit d'un picker natif ouvert au moment du geste ;
 * « Launch Claude in… » range le dossier choisi dans le workspace implicite
 * (`ensureLooseWorkspace`) — plus de session sans projet.
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
 *   à chaque changement de tab actif ; tout à `null` quand aucun onglet n'est
 *   actif (dernier onglet du projet fermé, projet sans session sélectionné,
 *   sélection retirée).
 * - `den:owner-removed` (`detail: { kind: "project", id: string }`),
 *   émis par `onRemove` pour CHAQUE projet retiré, APRÈS que tous ses tabs
 *   ont fini de fermer (chaque `sidecar_kill` attendu, séquentiellement) et
 *   que le nœud a été retiré de l'état persisté. Retrait d'un workspace :
 *   un événement par projet enfant cascadé, aucun pour le workspace lui-même
 *   (seuls les projets portent des groupes de terminaux). Ancrage DEN-04 A4 :
 *   le module terminal y fait le `pty_kill` du groupe `project:<id>`.
 * - `den:session-closed` (`detail: { tabId, owner, cwd }`), émis par
 *   `closeTab` juste après `tabs.delete(tabId)`, avec l'`owner`/`cwd` de la
 *   session fermée (capturés AVANT le retrait de la `Map`). Le module
 *   terminal ne l'écoute plus : un groupe de terminaux survit à la fermeture
 *   de ses sessions, il ne meurt qu'avec son projet. Contrat gardé pour
 *   DEN-05 (notifications), sans écouteur aujourd'hui.
 * - `den:tab-state-changed` (`detail: { tabId: string, state: TabLifecycleState }`) :
 *   émis quand l'état de lifecycle d'un tab (cf. `./lifecycle.ts`, seule
 *   source de vérité — DEN-10) change réellement, après chaque
 *   `router.handleChunk` et après chaque `router.markPromptSubmitted`. Le
 *   spinner du fil (module markdown) s'y abonne pour afficher "thinking…"
 *   (`running`) ou "waiting for your reply" (`waiting`) ; ce module s'y abonne
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
 * bouton ne redevient "Send" que sur le `done` qui fait retomber l'état à
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
 * Onglets de session (`./sessionTabs.ts`) : barre au-dessus du fil, un onglet
 * par session du projet SÉLECTIONNÉ (`selectedProjectId`, aligné sur le tab
 * actif ou choisi dans la sidebar ; on retient par projet son dernier onglet
 * actif). Le `+` de la barre ouvre une session dans ce projet. `home` (repli
 * `~` du chemin affiché) vient de `homeDir()` (`@tauri-apps/api/path`),
 * résolu une fois dans `init` ; indisponible -> `null`, pas de substitution.
 *
 * Un seul verrou (`withBusy`) garde tous les gestes de création — launch,
 * + Workspace, racine…, + projet — anti-
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
  ensureLooseWorkspace,
  getState,
  pickProjectDirectory,
  removeProject,
  removeWorkspace,
  renameWorkspace,
  setWorkspaceRoot,
} from "../workspace";
import { isLooseWorkspace, LOOSE_WORKSPACE_ID, projectsOfWorkspace } from "../workspace/store";
import {
  ownerKey,
  resolveCwd,
  shortPath,
  type NodeRef,
  type Owner,
  workspaceKey,
} from "./owner";
import type { TabLifecycleState } from "./lifecycle";
import { TabRouter } from "./router";
import { createSessionTabButton, createSessionTabs, type SessionTabs } from "./sessionTabs";
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

  // Repli `~` du chemin du projet sélectionné (cf. docstring de tête) — couvert par
  // `core:default` (`core:path:default`), aucune permission nouvelle. Échec
  // = pas de substitution `~`, jamais de crash : `shortPath` gère `null`.
  let home: string | null = null;
  try {
    // `homeDir()` = "/" donne une chaîne vide : sans repli, tout chemin absolu deviendrait « ~/… ».
    home = (await homeDir()).replace(/\/+$/, "") || null;
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
  let sessionTabs: SessionTabs;
  let selectedProjectId: string | null = null;
  // Ordre d'activation (le plus récent en dernier) : fermer un onglet retombe sur le dernier utilisé du projet.
  const recentTabIds: string[] = [];
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
   * tourne sur ce tab, "Send" (`type="submit"`, comportement natif du
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
      promptSubmitEl.textContent = "Send";
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
   * `done` (via `syncSubmitButton`) fait revenir le bouton à "Send". */
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

  function projectPathText(projectId: string): string | null {
    const project = getState().projects.find((p) => p.id === projectId);
    return project ? shortPath(project.path, home) : null;
  }

  /** Propage la sélection à la sidebar et à la barre d'onglets. */
  function syncSelection(): void {
    const pathText = selectedProjectId ? projectPathText(selectedProjectId) : null;
    sidebar.setSelectedProject(selectedProjectId);
    sessionTabs.setProject(selectedProjectId, pathText);
  }

  function mostRecentTabOf(projectId: string | null): Tab | undefined {
    for (let i = recentTabIds.length - 1; i >= 0; i--) {
      const tab = tabs.get(recentTabIds[i]);
      if (tab && tab.owner.id === projectId) return tab;
    }
    return [...tabs.values()].find((t) => t.owner.id === projectId);
  }

  function selectProject(projectId: string | null): void {
    const target = projectId ? mostRecentTabOf(projectId)?.id ?? null : null;
    // Assigné avant setActiveTab(null), qui ne touche pas à la sélection.
    selectedProjectId = projectId;
    setActiveTab(target);
  }

  /** Sans session active : état vide visible (texte selon projet sélectionné),
   * et prompt bar + sélecteur de mode désactivés — sinon un « Send » ne fait
   * rien en silence, et un mode choisi avant le lancement serait affiché sans
   * jamais être envoyé. */
  function updateEmptyState(): void {
    const idle = activeTabId === null;
    emptyStateEl.hidden = !idle;
    const noProject = selectedProjectId === null;
    emptyStateTextEl.textContent = noProject
      ? "Pick a folder to start a session"
      : "No session — press +";
    emptyLaunchEl.hidden = !noProject;
    modeSelect.disabled = idle;
    if (promptInputEl) promptInputEl.disabled = idle;
    if (promptSubmitEl) promptSubmitEl.disabled = idle;
    syncSubmitButton();
  }

  function setActiveTab(tabId: string | null): void {
    activeTabId = tabId;
    const active = tabId ? tabs.get(tabId) : undefined;
    if (active) {
      selectedProjectId = active.owner.id;
      const seen = recentTabIds.indexOf(active.id);
      if (seen !== -1) recentTabIds.splice(seen, 1);
      recentTabIds.push(active.id);
    }
    // syncSelection d'abord : l'onglet cible doit être visible (projet affiché) avant le scrollIntoView de setActive.
    syncSelection();
    sessionTabs.setActive(active ? active.buttonEl : null);
    // Sans tab actif, le select ne reflète plus aucun mode effectif : retour
    // au défaut plutôt qu'un mode périmé du tab qui vient de fermer.
    setModeSelectValue(modeSelect, active ? active.mode : "default");
    updateEmptyState();
    syncSubmitButton();
    dispatchActiveTabChanged(active ?? null);
  }

  /** Titre de l'onglet : `sessionId` court (dès `session_info`), ou
   * placeholder avant ; le titre complet reste en tooltip (titre clampé). */
  function updateTabTitle(tab: Tab): void {
    const full = tab.sessionId ?? "new session";
    tab.titleEl.textContent = tab.sessionId ? tab.sessionId.slice(0, 8) : full;
    tab.titleEl.title = full;
    // Un onglet en erreur garde le message d'erreur en tooltip.
    if (!tab.buttonEl.classList.contains("den-session-tab--error")) tab.buttonEl.title = full;
  }

  function markTabError(tab: Tab, message: string): void {
    tab.buttonEl.title = message;
    tab.buttonEl.classList.add("den-session-tab--error");
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
    sessionTabs.removeTab(tab.buttonEl);
    const { owner, cwd } = tab;
    tabs.delete(tabId);
    const recent = recentTabIds.indexOf(tabId);
    if (recent !== -1) recentTabIds.splice(recent, 1);
    window.dispatchEvent(
      new CustomEvent("den:session-closed", { detail: { tabId, owner, cwd } }),
    );

    if (activeTabId === tabId) {
      // Plus d'onglet dans le projet -> `null` (contrat inter-lots) : sans ça la
      // conversation du tab mort restait affichée ; le projet reste sélectionné.
      setActiveTab(mostRecentTabOf(owner.id)?.id ?? null);
    }
  }

  /** Crée un tab pour l'`owner` donné, avec `cwd` FIGÉ au spawn (cf.
   * docstring de tête — jamais recalculé après coup, indépendant de
   * l'`owner`). */
  function createTab(owner: Owner, cwd: string): Tab {
    const id = crypto.randomUUID();

    const { buttonEl, titleEl, closeEl } = createSessionTabButton();
    closeEl.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeTab(id);
    });
    buttonEl.addEventListener("click", () => setActiveTab(id));

    sessionTabs.addTab(owner.id, buttonEl);

    const tab: Tab = { id, cwd, owner, mode: "default", buttonEl, titleEl };
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
      // Événement de lifecycle basé sur l'état RÉSULTANT du chunk entier
      // (pas message par message) — cf. `emitStateIfChanged`.
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
    textarea.placeholder = "Message Claude… (⌘⏎ to send)";

    const submitEl = document.createElement("button");
    submitEl.type = "submit";
    submitEl.className = "den-prompt-bar__submit";
    submitEl.textContent = "Send";
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
  // racine…, + projet) — un second clic pendant
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

  /** « Launch Claude in… » : le dossier devient (ou réutilise, dédup par chemin) un projet du workspace implicite, et une session s'y ouvre. */
  async function launchProjectSession(): Promise<void> {
    await withBusy(async () => {
      const path = await pickProjectDirectory("Choose the session folder");
      if (path === null) return;
      await ensureLooseWorkspace();
      const project = await addProject(LOOSE_WORKSPACE_ID, path);
      if (project === null) return;
      // addProject peut rendre un projet en cours de retrait ou déjà retiré (dédup par chemin) : un tab créé maintenant fuirait.
      if (removing.has(ownerKey({ kind: "project", id: project.id }))) return;
      if (!getState().projects.some((p) => p.id === project.id)) return;
      sidebar.setState(getState());
      const tab = createTab({ kind: "project", id: project.id }, project.path);
      setActiveTab(tab.id);
    });
  }

  /** « + Workspace » : crée un workspace sans racine et ouvre aussitôt son
   * renommage inline. Sous verrou : un double-clic ne doit pas créer deux
   * workspaces (ni deux inputs de renommage). */
  async function onAddWorkspace(): Promise<void> {
    await withBusy(async () => {
      const workspace = await addWorkspace("New workspace");
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
      const path = await pickProjectDirectory("Choose the workspace root");
      if (path === null) return;
      await setWorkspaceRoot(id, path);
      sidebar.setState(getState());
    });
  }

  /** Ajoute un projet (dossier choisi) sous le workspace `wsId` (bouton
   * « + projet » d'une row workspace), sans ouvrir de session — c'est au `+`
   * de la row projet résultante d'en ouvrir une. Le picker démarre sur la
   * racine du workspace si elle existe. Workspace en cours de retrait : no-op
   * avant même le picker ; retiré pendant le picker : `addProject` rend
   * `null`, rien n'est écrit. */
  async function onAddProject(wsId: string): Promise<void> {
    if (removing.has(workspaceKey(wsId))) return;
    await withBusy(async () => {
      const rootPath = getState().workspaces.find((w) => w.id === wsId)?.rootPath;
      const path = await pickProjectDirectory("Choose the project folder", rootPath ?? undefined);
      if (path === null) return;
      const project = await addProject(wsId, path);
      if (project === null) return;
      sidebar.setState(getState());
    });
  }

  /** Ouvre une session dans le projet SÉLECTIONNÉ (bouton `+` de la barre
   * d'onglets). Aucun projet, en cours de retrait ou déjà disparu : no-op. */
  function onNewSession(): void {
    if (selectedProjectId === null) return;
    const owner: Owner = { kind: "project", id: selectedProjectId };
    if (removing.has(ownerKey(owner))) return;
    const cwd = resolveCwd(owner, getState());
    if (cwd === null) return;
    const tab = createTab(owner, cwd);
    setActiveTab(tab.id);
  }

  /** Retire un workspace ou un projet (bouton `×` d'une row) : ferme
   * d'abord toutes les sessions du nœud — et, pour un workspace, de ses
   * projets (`closeTab` -> `sidecar_kill`, séquentiel), puis retire le nœud
   * de l'état persisté (cascade côté store pour un workspace), re-rend la
   * sidebar, puis émet `den:owner-removed` pour chaque projet retiré (cf.
   * docstring de tête). Le workspace implicite n'est jamais retirable.
   * Anti-réentrance par clé sur le nœud ET, pour un workspace, sur chacun de
   * ses projets : un second `×` (le même nœud, son parent, ou un de ses
   * projets) pendant le retrait est un no-op, de même qu'un `+` sur ces
   * nœuds (cf. `onNewSession`, `onAddProject`, `launchProjectSession`) — sans ça deux retraits
   * imbriqués fermeraient les mêmes tabs deux fois et émettraient deux
   * événements, ou un tab créé pendant le retrait échapperait au balayage
   * (sidecar fuité). */
  const removing = new Set<string>();
  async function onRemove(target: NodeRef): Promise<void> {
    const { kind, id } = target;
    if (kind === "workspace" && isLooseWorkspace(id)) return;
    const projectIds =
      kind === "workspace"
        ? projectsOfWorkspace(getState(), id).map((p) => p.id)
        : [id];
    const projectKeys = projectIds.map((pid) => ownerKey({ kind: "project", id: pid }));
    const keys = kind === "workspace" ? [workspaceKey(id), ...projectKeys] : projectKeys;
    if (keys.some((k) => removing.has(k))) return;
    for (const k of keys) removing.add(k);
    try {
      const tabsOfOwner = [...tabs.values()].filter((tab) => projectKeys.includes(ownerKey(tab.owner)));
      for (const tab of tabsOfOwner) {
        await closeTab(tab.id);
      }
      if (kind === "workspace") await removeWorkspace(id);
      else await removeProject(id);
      sidebar.setState(getState());
      if (selectedProjectId !== null && projectIds.includes(selectedProjectId)) {
        selectProject(null);
      }
      for (const pid of projectIds) {
        window.dispatchEvent(
          new CustomEvent("den:owner-removed", { detail: { kind: "project", id: pid } }),
        );
      }
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
      void launchProjectSession().catch((err: unknown) => {
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
      onSelectProject: (projectId) => {
        selectProject(projectId);
        // Clic sur un projet sans session : on en ouvre une (la fermeture du dernier onglet, elle, garde l'état vide).
        if (activeTabId === null) onNewSession();
      },
      onRemove: (target) => {
        void onRemove(target).catch((err: unknown) => {
          console.error(`Den: échec du retrait de ${target.kind}:${target.id}`, err);
        });
      },
    },
    createLaunchButton,
    (path) => shortPath(path, home),
  );
  sidebar.setState(getState());

  // La barre se monte elle-même en premier enfant, au-dessus de `.den-views` (déjà inséré par `markdown`).
  sessionTabs = createSessionTabs(ctx.mounts.conversation, { onNew: onNewSession });

  // État vide — visible ssi aucun tab actif ; texte et bouton selon la sélection (cf. updateEmptyState).
  const emptyStateEl = document.createElement("div");
  emptyStateEl.className = "den-empty-state";
  const emptyStateTextEl = document.createElement("p");
  const emptyLaunchEl = createLaunchButton();
  emptyStateEl.append(emptyStateTextEl, emptyLaunchEl);
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
  updateEmptyState();
}
