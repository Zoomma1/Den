/**
 * Sidecar Den — un process par session/tab (cf. CLAUDE.md racine : un crash
 * n'emporte qu'un tab).
 *
 * Lit du NDJSON sur stdin (protocole UI->sidecar, cf.
 * src/types/protocol.ts), pilote le Agent SDK via `query()` en mode
 * "streaming input" (requis pour `Query.interrupt()` — cf. sdk.d.ts :
 * "Only available in streaming input mode"), relaie ses messages en NDJSON
 * sur stdout (protocole sidecar->UI).
 *
 * AUCUNE clé API dans l'environnement de ce process : l'auth passe par
 * l'OAuth du CLI Claude Code déjà loggé (apiKeySource "none"). Une
 * ANTHROPIC_API_KEY en env primerait et basculerait en facturation API —
 * cf. CLAUDE.md racine, incident 2026-08-24. (Le retrait de la variable
 * d'environnement est la responsabilité du process parent Rust, cf.
 * src-tauri/src/sidecar.rs — ce process hérite l'env qu'on lui donne.)
 *
 * Le cwd de la session est celui du process lui-même : Rust spawn ce
 * process avec `Command::current_dir(cwd)` (cf. src-tauri/src/sidecar.rs),
 * et le SDK utilise `process.cwd()` par défaut (cf. `Options.cwd` dans
 * sdk.d.ts) — aucun besoin de le repasser explicitement ici.
 */
import { createInterface } from "node:readline";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  isInterruptMessage,
  isPermissionResponse,
  isQuestionResponse,
  isSetModeMessage,
  isUserMessage,
  type DenProtocolMessage,
  type PermissionModeId,
  type SidecarToUIMessage,
  type UserMessage,
} from "../../src/types/protocol";
import { PermissionBroker } from "./permissions";

function send(message: SidecarToUIMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Câblage `canUseTool` (lot "surface interactive") : émet un
 * `permission_request`/`question_request` sur stdout pour chaque tool call
 * nécessitant une décision (`ExitPlanMode` inclus — un tool comme un autre
 * de ce point de vue) et attend la réponse corrélée reçue sur stdin (cf.
 * `permissions.ts`).
 */
const permissionBroker = new PermissionBroker(send);

/**
 * File d'entrée du mode "streaming input" du SDK : chaque `user_message` reçu
 * sur stdin est poussé ici, consommé par le générateur async passé en
 * `prompt` à `query()`. Ce mode (plutôt qu'un `query()` par tour, comme au
 * lot 0) garde une session unique vivante pour tout le process — condition
 * pour que `Query.interrupt()` soit disponible.
 */
class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffered: SDKUserMessage[] = [];
  private waiters: Array<(msg: SDKUserMessage) => void> = [];

  push(msg: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
      return;
    }
    this.buffered.push(msg);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.buffered.shift();
      if (next) {
        yield next;
        continue;
      }
      yield await new Promise<SDKUserMessage>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }
}

const inputQueue = new UserMessageQueue();

/**
 * File des identifiants de corrélation (`UserMessage.id`) des tours soumis
 * mais pas encore clos par un `result`. Le CLI traite les tours dans l'ordre
 * de soumission en mode streaming input — le premier de la file est donc
 * toujours celui en cours de traitement.
 */
const pendingTurnIds: string[] = [];

function currentTurnId(): string {
  return pendingTurnIds[0] ?? "unknown";
}

/**
 * État du streaming réel (DEN-10 lot 1b, `includePartialMessages: true`).
 *
 * `streamingMessageId` : id du message API (`message.id`, stable entre le
 * `message_start` et le `assistant` final qui le clôt) actuellement en cours
 * de stream — posé au `message_start`, jamais lu ailleurs qu'au moment d'un
 * `text_delta`.
 *
 * `streamedTextMessageIds` : ids des messages pour lesquels AU MOINS UN
 * `text_delta` a effectivement été relayé. Dédup PAR OBSERVATION (pas "tout
 * `assistant` texte est un doublon") : on n'ignore un bloc `text` du message
 * `assistant` final que si on a nous-même streamé du texte pour ce
 * `message.id`. C'est ce qui garde vivant le cas S-b (sonde 05/09) — un tour
 * comme `/model claude-inexistant-99` produit un `assistant` texte SANS
 * aucun `stream_event` avant lui (sdk.d.ts l.3283 : "a turn that produces no
 * stream events still stamps its first assistant message") ; ignorer ce
 * bloc à l'aveugle le perdrait en silence.
 */
let streamingMessageId: string | null = null;
const streamedTextMessageIds = new Set<string>();

function parseIncoming(line: string): DenProtocolMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed) as DenProtocolMessage;
  } catch (err) {
    send({ type: "error", message: `NDJSON invalide: ${String(err)}` });
    return null;
  }
}

function handleUserMessage(msg: UserMessage): void {
  pendingTurnIds.push(msg.id);
  inputQueue.push({
    type: "user",
    message: { role: "user", content: msg.text },
    parent_tool_use_id: null,
  });
}

/**
 * Change le mode de permission de la session en cours (sélecteur de mode
 * côté UI, cf. DEN-03). En cas d'échec de `setPermissionMode` (mode inconnu
 * du CLI, session déjà terminée...), on remonte une erreur récupérable sans
 * émettre de `mode_changed` — l'UI garde alors le mode affiché précédent.
 */
async function handleSetMode(mode: PermissionModeId): Promise<void> {
  try {
    await queryHandle.setPermissionMode(mode);
    send({ type: "mode_changed", mode });
  } catch (err) {
    send({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      recoverable: true,
    });
  }
}

const queryHandle = query({
  prompt: inputQueue,
  // `includePartialMessages` (DEN-10 lot 1b) : sans ce flag, les messages
  // `assistant` arrivent ENTIERS en fin de génération (silence total pendant
  // le tour, cf. sonde 05/09) — avec lui, le SDK émet en plus des
  // `stream_event` (`SDKPartialAssistantMessage`, sdk.d.ts l.4748) au fil de
  // la génération, relayés en `assistant_delta` ci-dessous.
  options: { canUseTool: permissionBroker.canUseTool, includePartialMessages: true },
});

async function pump(): Promise<void> {
  try {
    for await (const sdkMessage of queryHandle) {
      if (sdkMessage.type === "system" && sdkMessage.subtype === "init") {
        send({
          type: "session_info",
          sessionId: sdkMessage.session_id,
          model: sdkMessage.model,
          apiKeySource: sdkMessage.apiKeySource,
        });
        send({ type: "mode_changed", mode: sdkMessage.permissionMode });
      } else if (sdkMessage.type === "system" && sdkMessage.subtype === "status") {
        // Le CLI pousse un status avec permissionMode après une sortie de
        // plan mode gérée par lui-même (cf. sonde runtime : ExitPlanMode
        // n'a pas besoin de cas spécial côté broker) ou tout autre
        // changement de mode déclenché hors `set_mode` (ex. setPermissionMode
        // côté CLI). L'UI est idempotente sur les doublons avec le point 1.
        if (sdkMessage.permissionMode) {
          send({ type: "mode_changed", mode: sdkMessage.permissionMode });
        }
      } else if (sdkMessage.type === "stream_event") {
        // Sous-agents (DEN-10 lot 1b) : `parent_tool_use_id` non nul signale
        // un event émis par un sous-agent. Le rendu des sous-agents est hors
        // scope (pas de `forwardSubagentText`, cf. Options.forwardSubagentText
        // dans sdk.d.ts) — on ignore silencieusement ces events ; le
        // tool_use/tool_result du sous-agent reste relayé par ailleurs (cas
        // "assistant"/"user" ci-dessous, jamais affecté par ce filtre).
        if (sdkMessage.parent_tool_use_id !== null) {
          continue;
        }
        const event = sdkMessage.event;
        if (event.type === "message_start") {
          streamingMessageId = event.message.id;
        } else if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          // On note avoir streamé du texte pour CE message.id — c'est cette
          // observation, pas la simple présence d'un `assistant` texte, qui
          // pilote la dédup au message final (cf. docstring
          // `streamedTextMessageIds`).
          if (streamingMessageId !== null) {
            streamedTextMessageIds.add(streamingMessageId);
          }
          send({
            type: "assistant_delta",
            id: currentTurnId(),
            text: event.delta.text,
          });
        }
        // Tout autre event (thinking_delta — jamais relayé, input_json_delta,
        // content_block_start/stop, message_delta/stop, ping...) : rien à
        // faire ici.
      } else if (sdkMessage.type === "assistant") {
        for (const block of sdkMessage.message.content) {
          if (block.type === "text") {
            // Sonde 05/09 : le message `assistant` final répète tout le
            // texte déjà envoyé par les `stream_event` (même `message.id`)
            // — sans cette dédup, l'UI afficherait le texte deux fois. Cas
            // S-b (voir docstring `streamedTextMessageIds`) : ce message.id
            // n'a jamais été streamé, donc le `has` est faux et le texte est
            // bien relayé — seul filet de sécurité pour ce cas.
            if (streamedTextMessageIds.has(sdkMessage.message.id)) {
              continue;
            }
            send({
              type: "assistant_delta",
              id: currentTurnId(),
              text: block.text,
            });
          } else if (block.type === "tool_use") {
            send({
              type: "tool_use",
              id: currentTurnId(),
              toolUseId: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
      } else if (sdkMessage.type === "user") {
        // Le CLI ré-émet ici, en type "user", les tool_result répondant aux
        // tool_use annoncés par l'assistant (cf. sdk.d.ts : "the CLI emits
        // them for user-role content it adds to the conversation itself,
        // chiefly the tool_result blocks").
        const content = sdkMessage.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              send({
                type: "tool_result",
                id: currentTurnId(),
                toolUseId: block.tool_use_id,
                output: block.content,
                isError: block.is_error,
              });
            }
          }
        }
      } else if (sdkMessage.type === "conversation_reset") {
        // /clear, sortie de plan mode ou fresh-session flow (cf. sdk.d.ts
        // `SDKConversationResetMessage`) : jamais de string-matching sur
        // "/clear" ici, le SDK nous le dit explicitement par ce type.
        send({
          type: "conversation_reset",
          sessionId: sdkMessage.session_id,
          newConversationId: sdkMessage.new_conversation_id,
        });
      } else if (sdkMessage.type === "result") {
        // Reset par tour (DEN-10 lot 1b) : la dédup ne doit pas fuiter sur le
        // tour suivant — un `message.id` réutilisé par erreur (ou un état
        // resté à un ancien id) avalerait à tort le texte d'un nouveau tour.
        streamedTextMessageIds.clear();
        streamingMessageId = null;
        pendingTurnIds.shift();
        // Sonde S-a (05/09) : un tour interrompu via `queryHandle.interrupt()`
        // se termine par `is_error: true, terminal_reason: "aborted_streaming"`
        // (et de même pour "aborted_tools") — ce n'est pas une erreur, c'est
        // l'utilisateur qui a stoppé le tour (ex. Escap côté UI). Émettre
        // `error` ici rendrait le tab "error" sticky (cf. lifecycle.ts) pour
        // un Stop normal. Les autres `is_error` (règle générale recoverable,
        // hors scope DEN-09) restent inchangés.
        const isUserInterrupt =
          sdkMessage.is_error &&
          (sdkMessage.terminal_reason === "aborted_streaming" ||
            sdkMessage.terminal_reason === "aborted_tools");
        if (sdkMessage.is_error && !isUserInterrupt) {
          // subtype "success" avec is_error: le texte d'erreur est dans
          // `result` (cf. sdk.d.ts). Les autres subtypes ("error_*") le
          // portent dans `errors`.
          const errorText =
            sdkMessage.subtype === "success"
              ? sdkMessage.result
              : sdkMessage.errors.join("; ");
          send({
            type: "error",
            message: errorText || "Le tour s'est terminé en erreur.",
            recoverable: true,
          });
        }
        send({ type: "done", sessionId: sdkMessage.session_id });
      }
    }
  } catch (err) {
    send({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

void pump();

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const msg = parseIncoming(line);
  if (!msg) return;

  if (isUserMessage(msg)) {
    handleUserMessage(msg);
  } else if (isInterruptMessage(msg)) {
    void queryHandle.interrupt();
  } else if (isPermissionResponse(msg)) {
    permissionBroker.handlePermissionResponse(msg);
  } else if (isQuestionResponse(msg)) {
    permissionBroker.handleQuestionResponse(msg);
  } else if (isSetModeMessage(msg)) {
    void handleSetMode(msg.mode);
  }
});

/**
 * Auto-terminaison (DEN-06) : le CLI claude et le wrapper tsx ne meurent
 * qu'en cascade de LA mort de CE process (node main.ts) — sans elle, l'EOF
 * sur stdin (drop du ChildStdin côté Rust) est bien reçu ici (cf.
 * `rl.on("close")` ci-dessous) mais ne suffisait pas à faire sortir
 * main.ts, laissant tout l'arbre en fuite derrière lui. `interrupt()`
 * tente une sortie propre de la query en cours (best-effort : elle peut
 * déjà être terminée, d'où le `.catch`) ; le timer hard-exit couvre le cas
 * où `interrupt()` ne résout jamais. Idempotente (garde `dying`) : le
 * watchdog ppid ci-dessous et `rl.on("close")` peuvent tous deux
 * l'invoquer.
 */
let dying = false;
function dieGracefully(): void {
  if (dying) return;
  dying = true;
  // Jamais `.unref()` : ce timer doit tenir l'event loop ouverte jusqu'à
  // son déclenchement pour garantir la sortie même si `interrupt()` pend
  // indéfiniment (sans lui, un event loop par ailleurs vide pourrait sortir
  // avant l'échéance, mais rien ne le garantit dans le cas contraire).
  setTimeout(() => process.exit(0), 2000);
  queryHandle
    .interrupt()
    .catch(() => {
      // Query déjà terminée/jamais démarrée — sans conséquence, on sort
      // quand même.
    })
    .then(() => process.exit(0));
}

// Filet de sécurité : stdin fermé (process en train de s'arrêter) avant que
// le SDK n'ait signalé l'abandon d'un tool call en attente de décision —
// cf. docstring `PermissionBroker.rejectAllPending`.
rl.on("close", () => {
  permissionBroker.rejectAllPending();
  dieGracefully();
});

/**
 * Watchdog parent (DEN-06) : si le process Rust meurt sans passer par le
 * retrait de registre habituel (crash, kill -9...) et que l'EOF stdin se
 * perd, ce sidecar resterait orphelin indéfiniment. `process.ppid` ne
 * suffit PAS : ce process (node main.ts) est un FILS du wrapper tsx, pas du
 * process Rust — un crash de Rust orpheline le tsx (qui survit, reparenté à
 * launchd) sans jamais changer le ppid vu d'ici. On sonde donc directement
 * le PID Rust transmis au spawn (`DEN_PARENT_PID`, cf.
 * src-tauri/src/sidecar.rs) via `kill(pid, 0)` — signal nul, pur test
 * d'existence. Un throw (ESRCH : mort ; EPERM : PID recyclé par un process
 * d'un autre user, donc le parent est mort aussi) = mourir. Le test
 * `ppid === 1` reste en complément pour le cas symétrique : le wrapper tsx
 * meurt seul et ce node est reparenté à launchd. Un sidecar orphelin n'est
 * JAMAIS légitime, peu importe la cause de la mort du parent.
 */
const parentPid = Number(process.env.DEN_PARENT_PID);
setInterval(() => {
  if (process.ppid === 1) {
    dieGracefully();
    return;
  }
  if (Number.isInteger(parentPid) && parentPid > 0) {
    try {
      process.kill(parentPid, 0);
    } catch {
      dieGracefully();
    }
  }
}, 2000);
