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

/** Portée d'une règle de permission "always allow" côté SDK. */
export type PermissionRuleDestination =
  | "session"
  | "localSettings"
  | "userSettings";

/** Réponse de l'utilisateur à une `PermissionRequest`. */
export interface PermissionResponse {
  type: "permission_response";
  requestId: string;
  approved: boolean;
  reason?: string;
  /** Présent = always-allow avec cette portée ; absent = allow/deny simple. */
  destination?: PermissionRuleDestination;
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

/**
 * Identifiants de mode de permission — copie locale des modes du SDK Agent.
 * protocol.ts ne doit pas importer le SDK (l'UI n'en dépend pas) : cette
 * union est maintenue en phase avec les modes exposés côté sidecar.
 */
export type PermissionModeId =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** L'utilisateur change le mode de permission courant. */
export interface SetModeMessage {
  type: "set_mode";
  mode: PermissionModeId;
}

export type UIToSidecarMessage =
  | UserMessage
  | PermissionResponse
  | QuestionResponse
  | InterruptMessage
  | SetModeMessage;

// ---------------------------------------------------------------------------
// sidecar -> UI
// ---------------------------------------------------------------------------

/** Fragment de texte de la réponse assistant (streaming). */
export interface AssistantDelta {
  type: "assistant_delta";
  id: string;
  text: string;
}

/**
 * Le modèle invoque un outil.
 *
 * Deux identifiants distincts, à ne pas confondre :
 * - `id` : id du TOUR (turn) en cours, cohérent avec `AssistantDelta.id` et
 *   `ToolResult.id` — plusieurs `tool_use` d'un même tour partagent ce `id`.
 * - `toolUseId` : id du BLOC tool_use côté SDK (`block.id`, ex.
 *   "toolu_01…"), unique par appel d'outil — c'est la clé qui apparie ce
 *   `tool_use` avec le `ToolResult.toolUseId` correspondant.
 */
export interface ToolUse {
  type: "tool_use";
  id: string;
  toolUseId: string;
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

/**
 * Représentation opaque côté protocole d'une PermissionUpdate du SDK
 * (suggestion d'always-allow). Le sidecar garde les entrées typées de son
 * côté ; l'UI ne fait que tester la présence de ces suggestions.
 */
export interface PermissionSuggestion {
  type: string;
  [key: string]: unknown;
}

/** Le sidecar demande une autorisation utilisateur avant d'exécuter un outil. */
export interface PermissionRequest {
  type: "permission_request";
  requestId: string;
  toolName: string;
  input: unknown;
  /** Suggestions d'always-allow proposées par le SDK, à afficher côté UI. */
  suggestions?: PermissionSuggestion[];
  title?: string;
  displayName?: string;
  description?: string;
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

/**
 * Écho local du prompt utilisateur dans le flux de conversation.
 * Jamais émis par le sidecar : le module `tabs` le dispatche lui-même sur
 * `den:session-message` au moment de l'envoi, pour que le fil reste
 * relisible (le protocole NDJSON réel ne renvoie pas les prompts).
 */
export interface UserEcho {
  type: "user_echo";
  /** Même id de corrélation que le `user_message` envoyé au sidecar. */
  id: string;
  text: string;
}

/** Le sidecar confirme le changement de mode de permission. */
export interface ModeChanged {
  type: "mode_changed";
  mode: PermissionModeId;
}

/**
 * Le SDK a réinitialisé la conversation (`/clear`, sortie de plan mode,
 * fresh-session flow — cf. sdk.d.ts `SDKConversationResetMessage`). L'UI
 * doit vider le fil affiché : le contexte réel est reparti à zéro sous
 * `newConversationId`.
 */
export interface ConversationReset {
  type: "conversation_reset";
  sessionId: string;
  newConversationId: string;
}

export type SidecarToUIMessage =
  | AssistantDelta
  | ToolUse
  | ToolResult
  | PermissionRequest
  | QuestionRequest
  | SessionInfo
  | Done
  | ErrorMessage
  | ModeChanged
  | ConversationReset;

/**
 * Messages affichables dans le fil de conversation : le wire sidecar -> UI
 * plus l'écho local `UserEcho`, fabriqué côté UI (module `tabs`) et jamais
 * présent sur le wire NDJSON. C'est le type transporté par l'événement
 * `den:session-message` — les parseurs wire (cf. `src/tabs/router.ts`)
 * restent, eux, sur `SidecarToUIMessage`.
 */
export type ConversationMessage = SidecarToUIMessage | UserEcho;

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

export function isSetModeMessage(
  msg: DenProtocolMessage,
): msg is SetModeMessage {
  return msg.type === "set_mode";
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

export function isModeChanged(msg: DenProtocolMessage): msg is ModeChanged {
  return msg.type === "mode_changed";
}

export function isConversationReset(
  msg: DenProtocolMessage,
): msg is ConversationReset {
  return msg.type === "conversation_reset";
}

export function isUserEcho(msg: ConversationMessage): msg is UserEcho {
  return msg.type === "user_echo";
}

/** true si le message appartient au sens UI -> sidecar. */
export function isUIToSidecarMessage(
  msg: DenProtocolMessage,
): msg is UIToSidecarMessage {
  return (
    isUserMessage(msg) ||
    isPermissionResponse(msg) ||
    isQuestionResponse(msg) ||
    isInterruptMessage(msg) ||
    isSetModeMessage(msg)
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
