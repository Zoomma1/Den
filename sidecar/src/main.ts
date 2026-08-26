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
  isUserMessage,
  type DenProtocolMessage,
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

const queryHandle = query({
  prompt: inputQueue,
  options: { canUseTool: permissionBroker.canUseTool },
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
      } else if (sdkMessage.type === "assistant") {
        for (const block of sdkMessage.message.content) {
          if (block.type === "text") {
            send({
              type: "assistant_delta",
              id: currentTurnId(),
              text: block.text,
            });
          } else if (block.type === "tool_use") {
            send({
              type: "tool_use",
              id: currentTurnId(),
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
      } else if (sdkMessage.type === "result") {
        pendingTurnIds.shift();
        if (sdkMessage.is_error) {
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
  }
});

// Filet de sécurité : stdin fermé (process en train de s'arrêter) avant que
// le SDK n'ait signalé l'abandon d'un tool call en attente de décision —
// cf. docstring `PermissionBroker.rejectAllPending`.
rl.on("close", () => {
  permissionBroker.rejectAllPending();
});
