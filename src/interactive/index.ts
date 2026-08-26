/**
 * Module `interactive` — surface interactive : décision de permission
 * (`permission_request`, y compris `ExitPlanMode` — un tool comme un
 * autre du point de vue du protocole, donc déjà couvert ici) et réponse à
 * une question (`question_request`, ex. `AskUserQuestion`) du sidecar,
 * affichées inline dans le flux de conversation.
 *
 * Contrat inter-lots : écoute `den:session-message` (émis par le lot
 * `tabs`, cf. src/tabs/index.ts — `detail: { tabId, message }`), monte son
 * UI via `mountCustomBlock` (cf. src/markdown/index.ts, docstring de
 * l'API custom block), et renvoie la décision au sidecar par
 * `invoke("sidecar_send", { tabId, message })` — exactement le canal
 * qu'utilise `tabs` pour les prompts utilisateur (cf. `sendPrompt` dans
 * src/tabs/index.ts).
 *
 * Le rendu et le flux de décision (boutons, désactivation après réponse)
 * vivent dans `blocks.ts`, découplés de `invoke` pour rester testables en
 * isolation (happy-dom, sans mock Tauri) — cf. sa docstring.
 */
import { invoke } from "@tauri-apps/api/core";
import type { DenContext } from "../core/registry";
import {
  isPermissionRequest,
  isQuestionRequest,
  type CustomBlock,
  type PermissionResponse,
  type QuestionResponse,
  type SidecarToUIMessage,
} from "../types/protocol";
import { mountCustomBlock } from "../markdown";
import { renderPermissionBlock, renderQuestionBlock } from "./blocks";
import "./interactive.css";

interface SessionMessageDetail {
  tabId: string;
  message: SidecarToUIMessage;
}

async function sendToSidecar(
  tabId: string,
  response: PermissionResponse | QuestionResponse,
): Promise<void> {
  try {
    await invoke("sidecar_send", { tabId, message: JSON.stringify(response) });
  } catch (err) {
    console.error(`Den: échec d'envoi de la réponse (tab ${tabId})`, err);
  }
}

function onSessionMessage(event: Event): void {
  const detail = (event as CustomEvent<SessionMessageDetail>).detail;
  if (!detail) return;
  const { tabId, message } = detail;

  if (isPermissionRequest(message)) {
    const block: CustomBlock = {
      id: message.requestId,
      kind: "permission_request",
      payload: message,
    };
    const content = mountCustomBlock(tabId, block);
    renderPermissionBlock(content, message, (response) => {
      void sendToSidecar(tabId, response);
    });
    return;
  }

  if (isQuestionRequest(message)) {
    const block: CustomBlock = {
      id: message.requestId,
      kind: "question_request",
      payload: message,
    };
    const content = mountCustomBlock(tabId, block);
    renderQuestionBlock(content, message, (response) => {
      void sendToSidecar(tabId, response);
    });
    return;
  }
}

export function init(_ctx: DenContext): void {
  window.addEventListener("den:session-message", onSessionMessage);
}
