/**
 * Sidecar Den — un process par session/tab (cf. CLAUDE.md racine : un crash
 * n'emporte qu'un tab).
 *
 * Lit du NDJSON sur stdin (protocole UI->sidecar, cf.
 * src/types/protocol.ts), pilote le Agent SDK via `query()`, relaie ses
 * messages en NDJSON sur stdout (protocole sidecar->UI).
 *
 * AUCUNE clé API dans l'environnement de ce process : l'auth passe par
 * l'OAuth du CLI Claude Code déjà loggé (apiKeySource "none"). Une
 * ANTHROPIC_API_KEY en env primerait et basculerait en facturation API —
 * cf. CLAUDE.md racine, incident 2026-08-24.
 */
import { createInterface } from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  isUserMessage,
  type DenProtocolMessage,
  type SidecarToUIMessage,
  type UserMessage,
} from "../../src/types/protocol";

function send(message: SidecarToUIMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseUserMessage(line: string): UserMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    send({ type: "error", message: `NDJSON invalide: ${String(err)}` });
    return null;
  }

  const msg = parsed as DenProtocolMessage;
  if (!isUserMessage(msg)) {
    // Lot 0 : seul user_message est traité ici. permission_response,
    // question_response et interrupt sont pour les lots dédiés (permissions,
    // contrôle de tour en cours).
    return null;
  }
  return msg;
}

async function handleUserMessage(msg: UserMessage): Promise<void> {
  try {
    for await (const sdkMessage of query({ prompt: msg.text })) {
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
            send({ type: "assistant_delta", id: msg.id, text: block.text });
          }
        }
      } else if (sdkMessage.type === "result") {
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

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const msg = parseUserMessage(line);
  if (msg) {
    void handleUserMessage(msg);
  }
});
