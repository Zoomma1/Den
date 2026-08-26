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
 * Rend une UI de décision permission (autoriser/refuser) dans `content`
 * (l'élément retourné par `mountCustomBlock`, cf. src/markdown/index.ts).
 * `onRespond` est appelé une seule fois, à la décision de l'utilisateur ;
 * les boutons sont désactivés juste après pour empêcher un double envoi.
 */
export function renderPermissionBlock(
  content: HTMLElement,
  message: PermissionRequest,
  onRespond: (response: PermissionResponse) => void,
): void {
  content.classList.add("den-decision-block", "den-permission-block");

  const title = document.createElement("p");
  title.className = "den-decision-block__title";
  title.textContent = `Autoriser l'outil « ${message.toolName} » ?`;

  const pre = document.createElement("pre");
  pre.className = "den-decision-block__detail";
  pre.textContent = safeStringify(message.input);

  const actions = document.createElement("div");
  actions.className = "den-decision-block__actions";

  const allowBtn = document.createElement("button");
  allowBtn.type = "button";
  allowBtn.className = "den-btn den-btn--allow";
  allowBtn.textContent = "Autoriser";

  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "den-btn den-btn--deny";
  denyBtn.textContent = "Refuser";

  const status = document.createElement("p");
  status.className = "den-decision-block__status";
  status.hidden = true;

  let settled = false;
  function settle(approved: boolean): void {
    if (settled) return;
    settled = true;
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    status.hidden = false;
    status.textContent = approved ? "✓ Autorisé" : "✗ Refusé";
    onRespond({
      type: "permission_response",
      requestId: message.requestId,
      approved,
    });
  }

  allowBtn.addEventListener("click", () => settle(true));
  denyBtn.addEventListener("click", () => settle(false));

  actions.append(allowBtn, denyBtn);
  content.append(title, pre, actions, status);
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
