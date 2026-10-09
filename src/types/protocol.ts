import type { RenderNode } from "../mods/tree";

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

export type ModPaneActionKind = "show" | "focus" | "close" | "roster";

/** Action sur les panes ; réponse `mod_result` (handled = closed pour close, value = id pour show/focus). `roster` déclenche en plus un push `mod_panes`. */
export interface ModPaneAction {
  type: "mod_pane_action";
  requestId: string;
  action: ModPaneActionKind;
  id?: string | null;
}

/** Réponse de l'UI à `mod_copy_request`. */
export interface ModCopyResult {
  type: "mod_copy_result";
  requestId: string;
  copied: boolean;
}

/** Composants moteur que les mods peuvent réécrire. */
export type ModComponent =
  | "AssistantMessage"
  | "ToolResult"
  | "AbovePrompt"
  | "Pane";

/** L'UI demande l'arbre de rendu d'un composant ; réponse `mod_tree`. */
export interface ModRender {
  type: "mod_render";
  requestId: string;
  component: ModComponent;
  instanceId: string;
  props: Record<string, unknown>;
}

/** Clic sur un noeud interactif ; réponse `mod_result`. */
export interface ModPress {
  type: "mod_press";
  requestId: string;
  plugin: string;
  handle: number;
  key?: string;
  href?: string;
}

/** Saisie dans un Input de mod ; réponse `mod_result`. */
export interface ModInput {
  type: "mod_input";
  requestId: string;
  plugin: string;
  handle: number;
  kind: "change" | "submit";
  value: string;
  key?: string;
  component?: ModComponent;
  instanceId?: string;
}

/** Choix dans un Select de mod ; réponse `mod_result`. */
export interface ModSelect {
  type: "mod_select";
  requestId: string;
  plugin: string;
  handle: number;
  value: string;
  key?: string;
  component?: ModComponent;
  instanceId?: string;
}

export type UIToSidecarMessage =
  | UserMessage
  | PermissionResponse
  | QuestionResponse
  | InterruptMessage
  | SetModeMessage
  | ModRender
  | ModPress
  | ModInput
  | ModSelect
  | ModPaneAction
  | ModCopyResult;

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
  /** `tool_use_result` structuré du SDK : la forme que le moteur attend pour ToolResult.output. */
  structured?: unknown;
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

/** Un skill / slash command disponible dans la session (autocomplete "/"). */
export interface CommandInfo {
  name: string;
  description: string;
}

/** Liste complète des commandes de la session — REMPLACE la précédente côté UI. */
export interface Commands {
  type: "commands";
  commands: CommandInfo[];
}

/** Ligne de statut poussée par un mod. */
export interface ModStatus {
  type: "mod_status";
  plugin: string;
  text: string;
}

/** Toast poussé par un mod. */
export interface ModToast {
  type: "mod_toast";
  plugin: string;
  text: string;
  timeoutMs: number;
}

/** Liste COMPLÈTE des panes ouverts — REMPLACE la précédente (vide = tout fermé). */
export interface ModPanes {
  type: "mod_panes";
  panes: {
    id: string;
    title: string;
    plugin: string;
    closeOnEscape?: boolean;
    rows?: number;
    columns?: number;
  }[];
  shownId: string | null;
  focusedId: string | null;
  /** Le mod demande le focus de ce pane. */
  focusRequestedId?: string | null;
}

/** Instances à re-demander via `mod_render`. */
export interface ModInvalidate {
  type: "mod_invalidate";
  instances: { component: ModComponent; instanceId: string }[];
}

/** Réponse à `mod_render`. */
export interface ModTree {
  type: "mod_tree";
  requestId: string;
  tree: RenderNode | null;
  hooked: boolean;
  rewritten: boolean;
  error?: string;
}

/** Réponse à `mod_press` / `mod_input` / `mod_select`. */
export interface ModResult {
  type: "mod_result";
  requestId: string;
  handled: boolean;
  element?: string;
  value?: string;
  error?: string;
}

/** Le moteur demande de copier du texte dans le presse-papiers ; réponse `mod_copy_result`. */
export interface ModCopyRequest {
  type: "mod_copy_request";
  /** Id de la requête du moteur (control_request). */
  requestId: string;
  text: string;
}

/** Le moteur claude système n'est pas utilisable : les mods sont désactivés. */
export interface ModsUnavailable {
  type: "mods_unavailable";
  reason: string;
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
  | ConversationReset
  | Commands
  | ModStatus
  | ModToast
  | ModPanes
  | ModInvalidate
  | ModTree
  | ModResult
  | ModCopyRequest
  | ModsUnavailable;

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

export function isCommands(msg: DenProtocolMessage): msg is Commands {
  return msg.type === "commands";
}

export function isModStatus(msg: DenProtocolMessage): msg is ModStatus {
  return msg.type === "mod_status";
}

export function isModToast(msg: DenProtocolMessage): msg is ModToast {
  return msg.type === "mod_toast";
}

export function isModPanes(msg: DenProtocolMessage): msg is ModPanes {
  return msg.type === "mod_panes";
}

export function isModInvalidate(
  msg: DenProtocolMessage,
): msg is ModInvalidate {
  return msg.type === "mod_invalidate";
}

export function isModTree(msg: DenProtocolMessage): msg is ModTree {
  return msg.type === "mod_tree";
}

export function isModResult(msg: DenProtocolMessage): msg is ModResult {
  return msg.type === "mod_result";
}

export function isModCopyRequest(
  msg: DenProtocolMessage,
): msg is ModCopyRequest {
  return msg.type === "mod_copy_request";
}

export function isModPaneAction(
  msg: DenProtocolMessage,
): msg is ModPaneAction {
  return msg.type === "mod_pane_action";
}

export function isModCopyResult(
  msg: DenProtocolMessage,
): msg is ModCopyResult {
  return msg.type === "mod_copy_result";
}

export function isModsUnavailable(
  msg: DenProtocolMessage,
): msg is ModsUnavailable {
  return msg.type === "mods_unavailable";
}

export function isModRender(msg: DenProtocolMessage): msg is ModRender {
  return msg.type === "mod_render";
}

export function isModPress(msg: DenProtocolMessage): msg is ModPress {
  return msg.type === "mod_press";
}

export function isModInput(msg: DenProtocolMessage): msg is ModInput {
  return msg.type === "mod_input";
}

export function isModSelect(msg: DenProtocolMessage): msg is ModSelect {
  return msg.type === "mod_select";
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
    isSetModeMessage(msg) ||
    isModRender(msg) ||
    isModPress(msg) ||
    isModInput(msg) ||
    isModSelect(msg) ||
    isModPaneAction(msg) ||
    isModCopyResult(msg)
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
