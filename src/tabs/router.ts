import {
  isAssistantDelta,
  isDone,
  isErrorMessage,
  isPermissionRequest,
  isQuestionRequest,
  isSessionInfo,
  isToolResult,
  isToolUse,
  type DenProtocolMessage,
  type SidecarToUIMessage,
} from "../types/protocol";
import { NdjsonLineBuffer } from "./ndjson";
import { reduceTabLifecycle, type TabLifecycleState } from "./lifecycle";

export interface RoutedMessage {
  tabId: string;
  message: SidecarToUIMessage;
}

interface TabEntry {
  buffer: NdjsonLineBuffer;
  state: TabLifecycleState;
}

/**
 * Registre de routage par tabId : un buffer NDJSON et un état de cycle de
 * vie par tab, strictement isolés. Un chunk partiel ou un crash sur un tab
 * ne doit jamais affecter le routage ou l'état d'un autre tab (Done visé :
 * "kill du sidecar d'un tab -> les autres continuent").
 */
export class TabRouter {
  private readonly tabs = new Map<string, TabEntry>();

  registerTab(tabId: string): void {
    this.tabs.set(tabId, { buffer: new NdjsonLineBuffer(), state: "idle" });
  }

  getState(tabId: string): TabLifecycleState | undefined {
    return this.tabs.get(tabId)?.state;
  }

  markPromptSubmitted(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    entry.state = reduceTabLifecycle(entry.state, { kind: "prompt_submitted" });
  }

  closeTab(tabId: string): void {
    this.tabs.delete(tabId);
  }

  /**
   * Traite un chunk brut reçu du `Channel<String>` pour `tabId` : découpe en
   * lignes NDJSON complètes (buffer partiel propre à ce tab), parse et
   * valide chacune contre le protocole, met à jour l'état du tab, et
   * retourne les messages valides prêts à être dispatchés en
   * `den:session-message`. Une ligne invalide (JSON cassé ou hors
   * protocole) est silencieusement ignorée — jamais de throw qui ferait
   * planter le routing des autres tabs. Un tabId inconnu (non enregistré,
   * ou déjà fermé) retourne `[]` sans effet.
   */
  handleChunk(tabId: string, chunk: string): RoutedMessage[] {
    const entry = this.tabs.get(tabId);
    if (!entry) return [];

    const routed: RoutedMessage[] = [];
    for (const line of entry.buffer.push(chunk)) {
      const message = parseSidecarMessage(line);
      if (!message) continue;
      entry.state = reduceTabLifecycle(entry.state, {
        kind: "sidecar_message",
        message,
      });
      routed.push({ tabId, message });
    }
    return routed;
  }
}

function parseSidecarMessage(line: string): SidecarToUIMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    return null;
  }
  const candidate = parsed as DenProtocolMessage;

  // Validation par liste positive des guards sidecar->UI (cf.
  // src/types/protocol.ts). `isSidecarToUIMessage` y est défini par
  // négation (`!isUIToSidecarMessage`) — il traiterait un `type` inconnu
  // ou malformé comme "valide", ce qui n'est pas ce qu'on veut ici pour
  // une ligne venue du process externe.
  const isKnownSidecarMessage =
    isAssistantDelta(candidate) ||
    isToolUse(candidate) ||
    isToolResult(candidate) ||
    isPermissionRequest(candidate) ||
    isQuestionRequest(candidate) ||
    isSessionInfo(candidate) ||
    isDone(candidate) ||
    isErrorMessage(candidate);

  return isKnownSidecarMessage ? (candidate as SidecarToUIMessage) : null;
}
