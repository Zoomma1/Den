/**
 * `permissions.ts` — pont entre le `canUseTool` du SDK (cf. sdk.d.ts) et le
 * protocole NDJSON UI<->sidecar (cf. src/types/protocol.ts).
 *
 * Logique pure : ce module ne touche jamais stdin/stdout lui-même. Il reçoit
 * une fonction `send` (injectée par main.ts, qui écrit réellement sur
 * stdout) et expose deux méthodes que main.ts appelle quand une
 * `permission_response` / `question_response` arrive sur stdin. La
 * corrélation requête/réponse se fait uniquement par `requestId` — celui du
 * control_request SDK (cf. sdk.d.ts, JSDoc `CanUseTool.requestId` : "A
 * control_response sent out-of-band ... must echo this value").
 *
 * AskUserQuestion (cf. sdk-tools.d.ts) est un tool comme un autre côté SDK :
 * son "input" (les questions/options proposées par le modèle) transite par
 * ce même `canUseTool`. Le protocole NDJSON de ce lot (figé, hors
 * périmètre) n'expose qu'un couple question/options singulier
 * (`QuestionRequest`) — seule la première entrée de `input.questions` est
 * donc portée à l'UI. La réponse est réinjectée dans `updatedInput.answers`
 * (même clé que `AskUserQuestionOutput.answers` : texte de la question ->
 * réponse) pour rester proche de la forme que le tool produit normalement.
 *
 * Interruption : `options.signal` (fourni par le SDK à chaque appel de
 * `canUseTool`, signalé quand la session est interrompue) résout la requête
 * en attente par un `deny` plutôt que de bloquer indéfiniment — cf. JSDoc
 * `CanUseTool` : "Fail-closed: an accidental null means no response is sent
 * and the tool stays blocked indefinitely". `rejectAllPending` est un filet
 * de sécurité supplémentaire pour main.ts (ex. stdin fermé avant que le SDK
 * n'ait eu l'occasion de signaler l'abandon).
 */
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  PermissionRequest,
  PermissionResponse,
  QuestionRequest,
  QuestionResponse,
  SidecarToUIMessage,
} from "../../src/types/protocol";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const SESSION_INTERRUPTED_MESSAGE = "Requête annulée : session interrompue.";

type PendingEntry =
  | {
      kind: "permission";
      resolve: (result: PermissionResult) => void;
      /** Suggestions d'always-allow proposées par le SDK pour cette requête (cf. `CanUseTool.suggestions`). */
      suggestions?: PermissionUpdate[];
    }
  | {
      kind: "question";
      resolve: (result: PermissionResult) => void;
      input: Record<string, unknown>;
      questionKey: string;
    };

interface ExtractedQuestion {
  question: string;
  options?: string[];
  questionKey: string;
}

function firstQuestionEntry(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0];
  return first && typeof first === "object"
    ? (first as Record<string, unknown>)
    : undefined;
}

/** Extrait un couple question/options exploitable par `QuestionRequest` depuis l'input `AskUserQuestion`. */
function extractQuestion(input: Record<string, unknown>): ExtractedQuestion {
  const first = firstQuestionEntry(input);
  const question =
    first && typeof first.question === "string"
      ? first.question
      : "AskUserQuestion : question sans texte exploitable.";

  const rawOptions = first && Array.isArray(first.options) ? first.options : [];
  const options = rawOptions
    .map((opt) =>
      opt &&
      typeof opt === "object" &&
      typeof (opt as { label?: unknown }).label === "string"
        ? (opt as { label: string }).label
        : null,
    )
    .filter((label): label is string => label !== null);

  return {
    question,
    options: options.length > 0 ? options : undefined,
    questionKey: question,
  };
}

/**
 * Corrèle les `permission_request`/`question_request` émises vers l'UI avec
 * les `permission_response`/`question_response` reçues en retour. Un
 * broker par sidecar (une session/tab, cf. CLAUDE.md racine).
 */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly send: (message: SidecarToUIMessage) => void) {}

  /** À passer tel quel en `options.canUseTool` de `query()`. */
  readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const { requestId, signal, suggestions, title, displayName, description } = options;

    if (signal.aborted) {
      return Promise.resolve({
        behavior: "deny",
        message: SESSION_INTERRUPTED_MESSAGE,
        interrupt: true,
      });
    }

    return toolName === ASK_USER_QUESTION_TOOL
      ? this.askQuestion(requestId, input, signal)
      : this.askPermission(
          requestId,
          toolName,
          input,
          signal,
          suggestions,
          title,
          displayName,
          description,
        );
  };

  /** Résout la requête en attente correspondant à une `permission_response`. */
  handlePermissionResponse(response: PermissionResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.kind !== "permission") return;
    this.pending.delete(response.requestId);

    if (!response.approved) {
      pending.resolve({
        behavior: "deny",
        message: response.reason ?? "Refusé par l'utilisateur.",
      });
      return;
    }

    const destination = response.destination;
    const suggestions = pending.suggestions;
    if (destination && suggestions && suggestions.length > 0) {
      // Always-allow : on ne réécrit la destination que des règles d'outil
      // retenues (addRules) — setMode/addDirectories/... passent tels quels,
      // pour qu'un always-allow n'élargisse jamais un setMode ou un accès
      // répertoire par effet de bord (cf. spec DEN-03).
      const updatedPermissions: PermissionUpdate[] = suggestions.map((suggestion) =>
        suggestion.type === "addRules" ? { ...suggestion, destination } : suggestion,
      );
      pending.resolve({ behavior: "allow", updatedPermissions });
      // Un setMode transmis change le mode effectif de la session sans
      // qu'aucun message SDK ne le confirme sur ce chemin — l'émettre ici,
      // sinon le sélecteur de l'UI ment jusqu'au prochain tour.
      for (const suggestion of updatedPermissions) {
        if (suggestion.type === "setMode") {
          this.send({ type: "mode_changed", mode: suggestion.mode });
        }
      }
      return;
    }

    pending.resolve({ behavior: "allow" });
  }

  /** Résout la requête en attente correspondant à une `question_response`. */
  handleQuestionResponse(response: QuestionResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.kind !== "question") return;
    this.pending.delete(response.requestId);

    const existingAnswers =
      pending.input.answers && typeof pending.input.answers === "object"
        ? (pending.input.answers as Record<string, string>)
        : {};

    pending.resolve({
      behavior: "allow",
      updatedInput: {
        ...pending.input,
        answers: { ...existingAnswers, [pending.questionKey]: response.answer },
      },
    });
  }

  /**
   * Filet de sécurité : résout en `deny` toute requête encore en attente
   * (ex. stdin fermé / process en train de s'arrêter sans que le SDK n'ait
   * signalé `options.signal`).
   */
  rejectAllPending(reason: string = SESSION_INTERRUPTED_MESSAGE): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.resolve({ behavior: "deny", message: reason, interrupt: true });
    }
  }

  /** Nombre de requêtes en attente — utilisé par les tests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private askPermission(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    suggestions: PermissionUpdate[] | undefined,
    title: string | undefined,
    displayName: string | undefined,
    description: string | undefined,
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      this.pending.set(requestId, { kind: "permission", resolve, suggestions });
      signal.addEventListener("abort", () => this.settleOnAbort(requestId, resolve), {
        once: true,
      });
      const message: PermissionRequest = {
        type: "permission_request",
        requestId,
        toolName,
        input,
        suggestions,
        title,
        displayName,
        description,
      };
      this.send(message);
    });
  }

  private askQuestion(
    requestId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const { question, options, questionKey } = extractQuestion(input);
      this.pending.set(requestId, {
        kind: "question",
        resolve,
        input,
        questionKey,
      });
      signal.addEventListener("abort", () => this.settleOnAbort(requestId, resolve), {
        once: true,
      });
      const message: QuestionRequest = {
        type: "question_request",
        requestId,
        question,
        options,
      };
      this.send(message);
    });
  }

  private settleOnAbort(
    requestId: string,
    resolve: (result: PermissionResult) => void,
  ): void {
    if (!this.pending.delete(requestId)) return;
    resolve({
      behavior: "deny",
      message: SESSION_INTERRUPTED_MESSAGE,
      interrupt: true,
    });
  }
}
