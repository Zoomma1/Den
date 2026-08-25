/**
 * Contrat inter-lots — protocole NDJSON sidecar <-> UI.
 *
 * Une ligne = un message JSON (NDJSON) sur stdin/stdout du sidecar Node,
 * relayée côté Rust via un `Channel<String>` Tauri (jamais `emit()`, cf.
 * CLAUDE.md racine). Chaque message est un objet discriminé par `type`.
 *
 * Ce fichier est LE contrat entre les lots : sidecar (lot A), pty/terminal
 * (lot B), UI conversation/interactive (lot C, ...). Ne pas modifier sans
 * concertation — tout lot qui a besoin d'un nouveau message l'ajoute ici de
 * façon additive (nouveau membre d'union), jamais en changeant la forme des
 * messages existants.
 */

// ---------------------------------------------------------------------------
// UI -> sidecar
// ---------------------------------------------------------------------------

/** L'utilisateur envoie un tour de conversation au sidecar. */
export interface UserMessage {
  type: "user_message";
  /** Identifiant de corrélation, choisi côté UI. */
  id: string;
  text: string;
}

/** Réponse de l'utilisateur à une `PermissionRequest`. */
export interface PermissionResponse {
  type: "permission_response";
  requestId: string;
  approved: boolean;
  reason?: string;
}

/** Réponse de l'utilisateur à une `QuestionRequest`. */
export interface QuestionResponse {
  type: "question_response";
  requestId: string;
  answer: string;
}

/** Demande d'interruption du tour en cours (ex. Escap côté UI). */
export interface InterruptMessage {
  type: "interrupt";
}

export type UIToSidecarMessage =
  | UserMessage
  | PermissionResponse
  | QuestionResponse
  | InterruptMessage;

// ---------------------------------------------------------------------------
// sidecar -> UI
// ---------------------------------------------------------------------------

/** Fragment de texte de la réponse assistant (streaming). */
export interface AssistantDelta {
  type: "assistant_delta";
  id: string;
  text: string;
}

/** Le modèle invoque un outil. */
export interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** Résultat d'exécution d'un outil précédemment annoncé par `tool_use`. */
export interface ToolResult {
  type: "tool_result";
  id: string;
  toolUseId: string;
  output: unknown;
  isError?: boolean;
}

/** Le sidecar demande une autorisation utilisateur avant d'exécuter un outil. */
export interface PermissionRequest {
  type: "permission_request";
  requestId: string;
  toolName: string;
  input: unknown;
}

/** Le sidecar pose une question à l'utilisateur (ex. AskUserQuestion). */
export interface QuestionRequest {
  type: "question_request";
  requestId: string;
  question: string;
  options?: string[];
}

/** Métadonnées de session émises à l'initialisation du sidecar. */
export interface SessionInfo {
  type: "session_info";
  sessionId: string;
  model: string;
  /** Provenance de l'auth résolue par le SDK — doit valoir "none" (OAuth CLI), jamais une clé API en env. */
  apiKeySource: string;
}

/** Fin du tour courant. */
export interface Done {
  type: "done";
  sessionId?: string;
}

/** Erreur côté sidecar (agent SDK, process, parsing...). */
export interface ErrorMessage {
  type: "error";
  message: string;
  recoverable?: boolean;
}

export type SidecarToUIMessage =
  | AssistantDelta
  | ToolUse
  | ToolResult
  | PermissionRequest
  | QuestionRequest
  | SessionInfo
  | Done
  | ErrorMessage;

/** Union complète du protocole, dans les deux sens. */
export type DenProtocolMessage = UIToSidecarMessage | SidecarToUIMessage;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isUserMessage(msg: DenProtocolMessage): msg is UserMessage {
  return msg.type === "user_message";
}

export function isPermissionResponse(
  msg: DenProtocolMessage,
): msg is PermissionResponse {
  return msg.type === "permission_response";
}

export function isQuestionResponse(
  msg: DenProtocolMessage,
): msg is QuestionResponse {
  return msg.type === "question_response";
}

export function isInterruptMessage(
  msg: DenProtocolMessage,
): msg is InterruptMessage {
  return msg.type === "interrupt";
}

export function isAssistantDelta(
  msg: DenProtocolMessage,
): msg is AssistantDelta {
  return msg.type === "assistant_delta";
}

export function isToolUse(msg: DenProtocolMessage): msg is ToolUse {
  return msg.type === "tool_use";
}

export function isToolResult(msg: DenProtocolMessage): msg is ToolResult {
  return msg.type === "tool_result";
}

export function isPermissionRequest(
  msg: DenProtocolMessage,
): msg is PermissionRequest {
  return msg.type === "permission_request";
}

export function isQuestionRequest(
  msg: DenProtocolMessage,
): msg is QuestionRequest {
  return msg.type === "question_request";
}

export function isSessionInfo(msg: DenProtocolMessage): msg is SessionInfo {
  return msg.type === "session_info";
}

export function isDone(msg: DenProtocolMessage): msg is Done {
  return msg.type === "done";
}

export function isErrorMessage(msg: DenProtocolMessage): msg is ErrorMessage {
  return msg.type === "error";
}

/** true si le message appartient au sens UI -> sidecar. */
export function isUIToSidecarMessage(
  msg: DenProtocolMessage,
): msg is UIToSidecarMessage {
  return (
    isUserMessage(msg) ||
    isPermissionResponse(msg) ||
    isQuestionResponse(msg) ||
    isInterruptMessage(msg)
  );
}

/** true si le message appartient au sens sidecar -> UI. */
export function isSidecarToUIMessage(
  msg: DenProtocolMessage,
): msg is SidecarToUIMessage {
  return !isUIToSidecarMessage(msg);
}

// ---------------------------------------------------------------------------
// Custom blocks (surface interactive -> flux de conversation)
// ---------------------------------------------------------------------------

/**
 * Bloc injecté par la surface interactive (lot dédié) dans le flux de
 * conversation — ex. un widget de choix, un formulaire, un aperçu. Le
 * renderer markdown l'expose comme un noeud spécial au milieu du flux
 * habituel (texte assistant, tool_use/tool_result).
 */
export interface CustomBlock {
  id: string;
  kind: string;
  payload: unknown;
}
