import {
  isDone,
  isErrorMessage,
  type SidecarToUIMessage,
} from "../types/protocol";

/** États possibles d'un tab (un sidecar par tab, cf. CLAUDE.md racine). */
export type TabLifecycleState = "idle" | "running" | "error" | "closed";

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
 * - `error` est sticky face à `done` : un tour qui se termine normalement
 *   après un crash sidecar ne doit pas effacer l'état d'erreur affiché à
 *   l'utilisateur (Done visé : "kill du sidecar d'un tab -> le tab touché
 *   affiche l'erreur, les autres continuent"). Un nouveau `prompt_submitted`
 *   sur un tab en erreur n'a pas d'effet — le sidecar de ce tab est mort,
 *   respawn hors scope de ce lot.
 */
export function reduceTabLifecycle(
  state: TabLifecycleState,
  event: TabLifecycleEvent,
): TabLifecycleState {
  if (state === "closed") return "closed";

  switch (event.kind) {
    case "created":
      return "idle";
    case "prompt_submitted":
      return state === "error" ? state : "running";
    case "sidecar_message":
      if (isErrorMessage(event.message)) return "error";
      if (isDone(event.message)) return state === "error" ? state : "idle";
      return state;
    case "closed":
      return "closed";
  }
}
