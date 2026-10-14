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

/** Image collée depuis le presse-papier, transportée en base64 (sans préfixe `data:`). */
export interface ImageAttachment {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
}

/** L'utilisateur envoie un tour de conversation au sidecar. */
export interface UserMessage {
  type: "user_message";
  /** Identifiant de corrélation, choisi côté UI. */
  id: string;
  text: string;
  images?: ImageAttachment[];
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
  | "Pane"
  | "UserMessage"
  | "ToolUse"
  | "ToolGroup"
  | "CommandOutput"
  | "TurnDuration";

/** Taille de la surface en cellules mono (RenderViewport du moteur) ; `rows` = hauteur de toute la surface. */
export interface ModViewport {
  columns: number;
  rows: number;
  isFullscreen?: boolean;
}

/** L'UI demande l'arbre de rendu d'un composant ; réponse `mod_tree`. */
export interface ModRender {
  type: "mod_render";
  requestId: string;
  component: ModComponent;
  instanceId: string;
  props: Record<string, unknown>;
  viewport?: ModViewport;
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

/** Adresse d'un Client : instanceId = l'instance_id du ui_render (id du pane, du message…), client = key du noeud, module = chemin sous le plugin. */
export interface ClientAddress {
  plugin: string;
  component: ModComponent;
  instanceId: string;
  client: string;
  module: string;
}

/** Plafonds appliqués par l'hôte Client (mesurés côté moteur). */
export interface ClientLimits {
  nodes: number;
  depth: number;
  chars: number;
  values: number;
  dataDepth: number;
}

/** Bundle d'un plugin : sources des modules Client + runtime à exécuter dans le Worker. */
export interface ClientModuleBundle {
  plugin: string;
  hash: string;
  modules: { module: string; entry: string; component: string }[];
  runtime: string;
  limits: ClientLimits;
  files: { key: string; source: string }[];
}

/** L'UI demande le bundle Client d'un plugin ; réponse `mod_client_module_result`. */
export interface ModClientModule {
  type: "mod_client_module";
  requestId: string;
  plugin: string;
}

/** Événement utilisateur dans un Client ; réponse `mod_client_press_result`. */
export interface ModClientPress {
  type: "mod_client_press";
  requestId: string;
  address: ClientAddress;
  element: string;
  event:
    | { type: "press" }
    | { type: "input"; kind: "change" | "submit"; value: string }
    | { type: "select"; value: string };
}

/** Message module -> plugin (surface.post) ; réponse `mod_message_result`. */
export interface ModMessage {
  type: "mod_message";
  requestId: string;
  address: ClientAddress;
  data: unknown;
}

/** Panne d'un module Client signalée au moteur ; réponse `mod_result`. */
export interface ModClientFault {
  type: "mod_client_fault";
  requestId: string;
  address: ClientAddress;
  phase: "load" | "render" | "run";
  reason: string;
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
  | ModCopyResult
  | ModClientModule
  | ModClientPress
  | ModMessage
  | ModClientFault;

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
  /** Durée du tour en ms (pied de tour natif, TurnDuration). */
  durationMs?: number;
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
  images?: ImageAttachment[];
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

/** Sortie texte d'une commande slash (locale ou de mod), affichée sous son écho. */
export interface CommandOutput {
  type: "command_output";
  id: string;
  command: string;
  args: string;
  text: string;
  isError?: boolean;
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
  /** Props renvoyées par le moteur ; avec `tree: {type:"engine", ref:N}` ce sont les props à redessiner. */
  props?: Record<string, unknown>;
  /** plugin -> hash des bundles Client référencés (client_modules de ui_render). */
  clientModules?: Record<string, string>;
  error?: string;
}

/** Réponse à `mod_press` / `mod_input` / `mod_select` / `mod_pane_action` / `mod_client_fault`. */
export interface ModResult {
  type: "mod_result";
  requestId: string;
  handled: boolean;
  element?: string;
  value?: string;
  error?: string;
}

/** Réponse à `mod_client_press` : `reached` = ce que le moteur a laissé passer (absent = un hook a bloqué). */
export interface ModClientPressResult {
  type: "mod_client_press_result";
  requestId: string;
  handled: boolean;
  reached?: unknown;
  error?: string;
}

/** Réponse à `mod_client_module`. */
export interface ModClientModuleResult {
  type: "mod_client_module_result";
  requestId: string;
  ok: boolean;
  bundle?: ClientModuleBundle;
  error?: string;
}

/** Réponse à `mod_message`. */
export interface ModMessageResult {
  type: "mod_message_result";
  requestId: string;
  handled: boolean;
  props?: unknown;
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

/** Cycle de vie d'un sous-agent (task_started/progress/updated/notification du SDK). */
export interface SubagentUpdate {
  type: "subagent_update";
  taskId: string;
  /** Id du tool_use Agent du parent (absent sur task_updated). */
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  lastToolName?: string;
  isBackgrounded?: boolean;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  /** Tâche donnée au sous-agent (task_started.prompt). */
  prompt?: string;
  /** Rang d'imbrication : 1 = lancé par la session, N+1 = lancé par un agent de rang N. */
  spawnDepth?: number;
}

/** Étape interne d'un sous-agent (texte, appel d'outil ou résultat), tronquée côté sidecar. */
export interface SubagentStep {
  type: "subagent_step";
  /** Id du tool_use Agent qui a lancé ce sous-agent. */
  parentToolUseId: string;
  kind: "text" | "tool_use" | "tool_result";
  toolUseId?: string;
  name?: string;
  text: string;
  truncated: boolean;
  isError?: boolean;
}

/** Rapport final d'un sous-agent, à afficher sur le bloc Agent du parent. */
export interface SubagentReport {
  type: "subagent_report";
  /** Id du tool_use Agent parent. */
  toolUseId: string;
  text: string;
}

export type SidecarToUIMessage =
  | AssistantDelta
  | ToolUse
  | ToolResult
  | SubagentUpdate
  | SubagentReport
  | SubagentStep
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
  | ModClientModuleResult
  | ModMessageResult
  | ModClientPressResult
  | ModsUnavailable
  | CommandOutput;

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

export function isSubagentUpdate(
  msg: DenProtocolMessage,
): msg is SubagentUpdate {
  return msg.type === "subagent_update";
}

export function isSubagentStep(msg: DenProtocolMessage): msg is SubagentStep {
  return msg.type === "subagent_step";
}

export function isSubagentReport(
  msg: DenProtocolMessage,
): msg is SubagentReport {
  return msg.type === "subagent_report";
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

export function isCommandOutput(msg: DenProtocolMessage): msg is CommandOutput {
  return msg.type === "command_output";
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

const MOD_COMPONENT_NAMES: readonly string[] = [
  "AssistantMessage",
  "ToolResult",
  "AbovePrompt",
  "Pane",
  "UserMessage",
  "ToolUse",
  "ToolGroup",
  "CommandOutput",
  "TurnDuration",
];
const CLIENT_PHASES: readonly string[] = ["load", "render", "run"];

const isStr = (v: unknown): v is string => typeof v === "string";

function isClientAddress(v: unknown): v is ClientAddress {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    isStr(a.plugin) &&
    isStr(a.instanceId) &&
    isStr(a.client) &&
    isStr(a.module) &&
    isStr(a.component) &&
    MOD_COMPONENT_NAMES.includes(a.component)
  );
}

function isClientEvent(v: unknown): v is ModClientPress["event"] {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (e.type === "press") return true;
  if (e.type === "input") return (e.kind === "change" || e.kind === "submit") && isStr(e.value);
  return e.type === "select" && isStr(e.value);
}

export function isModClientModule(msg: DenProtocolMessage): msg is ModClientModule {
  const m = msg as unknown as Partial<ModClientModule>;
  return m.type === "mod_client_module" && isStr(m.requestId) && isStr(m.plugin);
}

export function isModClientPress(msg: DenProtocolMessage): msg is ModClientPress {
  const m = msg as unknown as Partial<ModClientPress>;
  return (
    m.type === "mod_client_press" &&
    isStr(m.requestId) &&
    isClientAddress(m.address) &&
    isStr(m.element) &&
    isClientEvent(m.event)
  );
}

export function isModMessage(msg: DenProtocolMessage): msg is ModMessage {
  const m = msg as unknown as Partial<ModMessage>;
  return m.type === "mod_message" && isStr(m.requestId) && isClientAddress(m.address);
}

export function isModClientFault(msg: DenProtocolMessage): msg is ModClientFault {
  const m = msg as unknown as Partial<ModClientFault>;
  return (
    m.type === "mod_client_fault" &&
    isStr(m.requestId) &&
    isClientAddress(m.address) &&
    isStr(m.phase) &&
    CLIENT_PHASES.includes(m.phase) &&
    isStr(m.reason)
  );
}

export function isModClientModuleResult(msg: DenProtocolMessage): msg is ModClientModuleResult {
  const m = msg as unknown as Partial<ModClientModuleResult>;
  return m.type === "mod_client_module_result" && isStr(m.requestId) && typeof m.ok === "boolean";
}

export function isModMessageResult(msg: DenProtocolMessage): msg is ModMessageResult {
  const m = msg as unknown as Partial<ModMessageResult>;
  return m.type === "mod_message_result" && isStr(m.requestId) && typeof m.handled === "boolean";
}

export function isModClientPressResult(msg: DenProtocolMessage): msg is ModClientPressResult {
  const m = msg as unknown as Partial<ModClientPressResult>;
  return m.type === "mod_client_press_result" && isStr(m.requestId) && typeof m.handled === "boolean";
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
    isModCopyResult(msg) ||
    isModClientModule(msg) ||
    isModClientPress(msg) ||
    isModMessage(msg) ||
    isModClientFault(msg)
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
