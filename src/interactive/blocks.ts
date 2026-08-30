/**
 * `blocks.ts` — rendu DOM des blocs de décision (`permission_request` /
 * `question_request`) et flux de décision associé.
 *
 * Pas de dépendance à `@tauri-apps/api/core` ici : l'envoi de la réponse au
 * sidecar est délégué à un callback injecté (`onRespond`), pour rester
 * testable en isolation (happy-dom, sans mock Tauri) — cf. `index.ts` pour
 * le câblage réel (écoute `den:session-message`, `invoke("sidecar_send")`).
 */
import type {
  PermissionRequest,
  PermissionResponse,
  PermissionRuleDestination,
  QuestionRequest,
  QuestionResponse,
} from "../types/protocol";

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Rend une UI de décision permission (allow/deny, éventuellement
 * always-allow) dans `content` (l'élément retourné par `mountCustomBlock`,
 * cf. src/markdown/index.ts). Libellés UI en anglais (arbitrage produit).
 *
 * `onRespond` est appelé une seule fois, à la première décision de
 * l'utilisateur :
 * - Allow / Deny simples -> le bloc reste affiché, boutons désactivés et
 *   statut "✓ Allowed" / "✗ Denied" (comportement historique).
 * - Always-allow (bouton principal ou menu "…") -> réponse avec
 *   `destination`, puis le bloc se REPLIE en affichage compact (seul le
 *   titre reste visible) : ce choix modifie une règle de permission
 *   persistante côté CLI, contrairement à un allow ponctuel.
 *
 * "Always allow" et le menu "…" ne sont proposés que si le SDK a fourni des
 * `suggestions` (le SDK est seul juge de ce qui peut être generalisé en
 * règle — cf. sonde runtime en tête du ticket) et jamais pour
 * `ExitPlanMode` (sortie de plan mode : un allow nu suffit, le CLI gère
 * lui-même la bascule de mode).
 */
export function renderPermissionBlock(
  content: HTMLElement,
  message: PermissionRequest,
  onRespond: (response: PermissionResponse) => void,
): void {
  content.classList.add("den-decision-block", "den-permission-block");

  const label = message.displayName ?? message.toolName;
  const titleText = message.title ?? `Allow "${label}"?`;

  const title = document.createElement("p");
  title.className = "den-decision-block__title";
  title.textContent = titleText;

  let description: HTMLParagraphElement | undefined;
  if (message.description) {
    description = document.createElement("p");
    description.className = "den-decision-block__description";
    description.textContent = message.description;
  }

  const pre = document.createElement("pre");
  pre.className = "den-decision-block__detail";
  pre.textContent = safeStringify(message.input);

  const actions = document.createElement("div");
  actions.className = "den-decision-block__actions";

  const allowBtn = document.createElement("button");
  allowBtn.type = "button";
  allowBtn.className = "den-btn den-btn--allow";
  allowBtn.textContent = "Allow";

  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "den-btn den-btn--deny";
  denyBtn.textContent = "Deny";

  const status = document.createElement("p");
  status.className = "den-decision-block__status";
  status.hidden = true;

  // "Always allow" n'a de sens que si les suggestions contiennent au moins
  // une règle d'outil (addRules) : des suggestions faites uniquement de
  // setMode/addDirectories (ex. Write hors-cwd) ne persisteraient aucune
  // règle — le bouton mentirait. Le garde ExitPlanMode reste en plus
  // (done criterion du ticket : jamais d'always-allow sur la sortie de plan).
  const hasSuggestions =
    !!message.suggestions &&
    message.suggestions.some((s) => s.type === "addRules") &&
    message.toolName !== "ExitPlanMode";

  let settled = false;

  /** Verrous posés par les branches de rendu : chaque commande interactive
   * (boutons, items de menu, fermeture du menu) s'y enregistre pour être
   * neutralisée d'un coup au règlement — sinon un clic post-décision est un
   * no-op silencieux et un menu ouvert reste flottant sur le fil. */
  const lockers: Array<() => void> = [];

  function lockAll(): void {
    for (const lock of lockers) lock();
  }

  const DESTINATION_LABELS: Record<PermissionRuleDestination, string> = {
    session: "this session",
    localSettings: "this project",
    userSettings: "all projects",
  };

  /** Repli en affichage compact après un always-allow : le titre reste sur
   * une ligne avec la portée appliquée, le reste du bloc de décision
   * (description, détail JSON, actions, menu) est retiré. */
  function collapse(destination: PermissionRuleDestination): void {
    content.classList.add("den-decision-block--collapsed");
    description?.remove();
    pre.remove();
    actions.remove();
    status.hidden = false;
    status.textContent = `✓ Always allowed (${DESTINATION_LABELS[destination]})`;
  }

  function settleSimple(approved: boolean): void {
    if (settled) return;
    settled = true;
    lockAll();
    status.hidden = false;
    status.textContent = approved ? "✓ Allowed" : "✗ Denied";
    onRespond({
      type: "permission_response",
      requestId: message.requestId,
      approved,
    });
  }

  function settleWithDestination(destination: PermissionRuleDestination): void {
    if (settled) return;
    settled = true;
    lockAll();
    onRespond({
      type: "permission_response",
      requestId: message.requestId,
      approved: true,
      destination,
    });
    collapse(destination);
  }

  allowBtn.addEventListener("click", () => settleSimple(true));
  denyBtn.addEventListener("click", () => settleSimple(false));
  lockers.push(() => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
  });

  actions.append(allowBtn);

  if (hasSuggestions) {
    // Bouton principal "Always allow" -> portée session, parité avec le
    // comportement du CLI (session = tab côté Den).
    const alwaysAllowBtn = document.createElement("button");
    alwaysAllowBtn.type = "button";
    alwaysAllowBtn.className = "den-btn den-btn--always-allow";
    alwaysAllowBtn.textContent = "Always allow";
    alwaysAllowBtn.addEventListener("click", () => settleWithDestination("session"));
    lockers.push(() => {
      alwaysAllowBtn.disabled = true;
    });
    actions.append(alwaysAllowBtn);

    // Menu inline "…" (pas de lib externe) pour les deux autres portées.
    const menuWrapper = document.createElement("div");
    menuWrapper.className = "den-decision-block__menu-wrapper";

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "den-btn den-btn--more";
    moreBtn.textContent = "…";
    moreBtn.setAttribute("aria-haspopup", "true");
    moreBtn.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "den-decision-block__menu";
    menu.hidden = true;

    const projectItem = document.createElement("button");
    projectItem.type = "button";
    projectItem.className = "den-decision-block__menu-item";
    projectItem.textContent = "Allow for this project";
    projectItem.addEventListener("click", () => settleWithDestination("localSettings"));

    // Libellé distinct du bouton principal (portée session) : deux commandes
    // au même nom pour deux portées différentes seraient indiscernables.
    const userItem = document.createElement("button");
    userItem.type = "button";
    userItem.className = "den-decision-block__menu-item";
    userItem.textContent = "Always allow (all projects)";
    userItem.addEventListener("click", () => settleWithDestination("userSettings"));

    menu.append(projectItem, userItem);

    moreBtn.addEventListener("click", () => {
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      moreBtn.setAttribute("aria-expanded", String(willOpen));
    });

    lockers.push(() => {
      moreBtn.disabled = true;
      projectItem.disabled = true;
      userItem.disabled = true;
      menu.hidden = true;
      moreBtn.setAttribute("aria-expanded", "false");
    });

    menuWrapper.append(moreBtn, menu);
    actions.append(menuWrapper);
  }

  actions.append(denyBtn);

  content.append(title);
  if (description) content.append(description);
  content.append(pre, actions, status);
}

/**
 * Rend une UI de réponse à une `QuestionRequest` (options cliquables si
 * `message.options` est fourni, champ libre toujours disponible) dans
 * `content`. `onRespond` est appelé une seule fois ; toutes les commandes
 * sont désactivées juste après pour empêcher un double envoi.
 */
export function renderQuestionBlock(
  content: HTMLElement,
  message: QuestionRequest,
  onRespond: (response: QuestionResponse) => void,
): void {
  content.classList.add("den-decision-block", "den-question-block");

  const title = document.createElement("p");
  title.className = "den-decision-block__title";
  title.textContent = message.question;
  content.appendChild(title);

  const status = document.createElement("p");
  status.className = "den-decision-block__status";
  status.hidden = true;

  let settled = false;
  const lockers: Array<() => void> = [];

  function settle(rawAnswer: string): void {
    const answer = rawAnswer.trim();
    if (settled || answer.length === 0) return;
    settled = true;
    for (const lock of lockers) lock();
    status.hidden = false;
    status.textContent = `→ ${answer}`;
    onRespond({
      type: "question_response",
      requestId: message.requestId,
      answer,
    });
  }

  if (message.options && message.options.length > 0) {
    const optionsEl = document.createElement("div");
    optionsEl.className = "den-decision-block__options";
    for (const option of message.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "den-btn den-btn--option";
      btn.textContent = option;
      btn.addEventListener("click", () => settle(option));
      lockers.push(() => {
        btn.disabled = true;
      });
      optionsEl.appendChild(btn);
    }
    content.appendChild(optionsEl);
  }

  const form = document.createElement("form");
  form.className = "den-decision-block__freeform";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "den-decision-block__input";
  input.placeholder = "Autre réponse…";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "den-btn den-btn--submit";
  submitBtn.textContent = "Envoyer";

  lockers.push(() => {
    input.disabled = true;
    submitBtn.disabled = true;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    settle(input.value);
  });

  form.append(input, submitBtn);
  content.append(form, status);
}
