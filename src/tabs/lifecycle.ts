import {
  isConversationReset,
  isDone,
  isErrorMessage,
  isModeChanged,
  isPermissionRequest,
  isQuestionRequest,
  isSessionInfo,
  type SidecarToUIMessage,
} from "../types/protocol";

/** États possibles d'un tab (un sidecar par tab, cf. CLAUDE.md racine). */
export type TabLifecycleState =
  | "idle"
  | "running"
  | "waiting"
  | "error"
  | "closed";

/**
 * État complet d'un tab — décision D6 : `pendingTurns` est la SEULE source
 * de vérité sur le nombre de tours en file (aucun compteur ailleurs, cf.
 * ticket). Sondes 05/09 : deux prompts d'affilée produisent deux `done` (le
 * second tour démarre seul après un Stop, sdk.d.ts l.2591 — Stop n'annule
 * pas la file), et `/clear` émet `conversation_reset` PUIS `session_info` +
 * `mode_changed` PUIS un `done` de tour vide. Le compteur absorbe le
 * premier fait (un `done` ne clôt qu'un tour parmi ceux en attente) ; le
 * clamp à 0 dans `Math.max` absorbe le second (le `done` qui suit un reset
 * ne doit jamais faire passer le compteur négatif).
 */
export interface TabLifecycle {
  state: TabLifecycleState;
  pendingTurns: number;
}

export const INITIAL_TAB_LIFECYCLE: TabLifecycle = { state: "idle", pendingTurns: 0 };

export type TabLifecycleEvent =
  | { kind: "created" }
  | { kind: "prompt_submitted" }
  | { kind: "sidecar_message"; message: SidecarToUIMessage }
  | { kind: "closed" };

/**
 * Machine à états pure d'un tab.
 *
 * - `closed` est terminal : aucun événement ne le fait sortir de cet état
 *   (le tab est démonté côté DOM par l'appelant, cf. `index.ts`).
 * - `error` est sticky face à `done`/`conversation_reset` : un tour qui se
 *   termine normalement après un crash sidecar ne doit pas effacer l'état
 *   d'erreur affiché à l'utilisateur (Done visé : "kill du sidecar d'un tab
 *   -> le tab touché affiche l'erreur, les autres continuent"). La règle
 *   générale de récupération (`recoverable`) est DEN-09, hors scope ici —
 *   seul le cas `recoverable !== true` (conserver `pendingTurns` sinon) est
 *   traité, pour ne pas perdre le compte des tours en file sur une erreur
 *   dont on sait déjà qu'elle n'interrompt pas la conversation.
 * - `waiting` : un `permission_request`/`question_request` reçu pendant un
 *   tour en cours (`running` ou déjà `waiting`) fait basculer le tab en
 *   attente de réponse utilisateur. N'importe quel autre message sidecar
 *   reçu en `waiting` repasse le tab en `running` — le router voit déjà ces
 *   messages passer (permission_response/question_response ne sont jamais
 *   émis par le sidecar), donc zéro couplage avec le module interactive
 *   pour détecter que l'utilisateur a répondu et que le sidecar a repris.
 */
export function reduceTabLifecycle(
  lifecycle: TabLifecycle,
  event: TabLifecycleEvent,
): TabLifecycle {
  if (lifecycle.state === "closed") return lifecycle;

  switch (event.kind) {
    case "created":
      return { ...INITIAL_TAB_LIFECYCLE };
    case "prompt_submitted":
      if (lifecycle.state === "error") return lifecycle;
      return { state: "running", pendingTurns: lifecycle.pendingTurns + 1 };
    case "sidecar_message":
      return reduceSidecarMessage(lifecycle, event.message);
    case "closed":
      return { state: "closed", pendingTurns: lifecycle.pendingTurns };
  }
}

function reduceSidecarMessage(
  lifecycle: TabLifecycle,
  message: SidecarToUIMessage,
): TabLifecycle {
  if (isErrorMessage(message)) {
    const recoverable = message.recoverable === true;
    return {
      state: "error",
      pendingTurns: recoverable ? lifecycle.pendingTurns : 0,
    };
  }

  if (isDone(message)) {
    // Un `done` ne clôt qu'un seul tour parmi ceux en file (cf. docstring).
    const pendingTurns = Math.max(0, lifecycle.pendingTurns - 1);
    const state: TabLifecycleState =
      lifecycle.state === "error" ? "error" : pendingTurns > 0 ? "running" : "idle";
    return { state, pendingTurns };
  }

  if (isConversationReset(message)) {
    const state: TabLifecycleState = lifecycle.state === "error" ? "error" : "idle";
    return { state, pendingTurns: 0 };
  }

  if (isPermissionRequest(message) || isQuestionRequest(message)) {
    if (lifecycle.state === "running" || lifecycle.state === "waiting") {
      return { ...lifecycle, state: "waiting" };
    }
    return lifecycle;
  }

  // Tout autre message de PROGRESSION du tour (assistant_delta, tool_use,
  // tool_result...) reçu pendant l'attente d'une réponse utilisateur
  // signifie que le sidecar a repris. `session_info` et `mode_changed` sont
  // exclus : le CLI ré-émet un `init` (donc ces deux messages) en DÉBUT de
  // tour, et un changement de mode fait par l'utilisateur pendant l'attente
  // (sélecteur, cf. index.ts) répond `mode_changed` sans que le tool call
  // bloqué ait avancé — review 07/09.
  if (
    lifecycle.state === "waiting" &&
    !isSessionInfo(message) &&
    !isModeChanged(message)
  ) {
    return { ...lifecycle, state: "running" };
  }

  return lifecycle;
}
