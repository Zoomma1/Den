import type { ConversationMessage } from "../types/protocol";
import type { SessionStatus } from "./status";

export interface Activity {
  turnId: string | null;
  text: string;
  waitingFor: string | null;
}

export const EMPTY_ACTIVITY: Activity = { turnId: null, text: "", waitingFor: null };

const MAX_CHARS = 120;

function tail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trimStart();
  return flat.length > MAX_CHARS ? flat.slice(-MAX_CHARS) : flat;
}

function clip(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

/** Dernière activité lisible d'une session, déduite du flux de messages. */
export function nextActivity(prev: Activity, message: ConversationMessage): Activity {
  switch (message.type) {
    case "assistant_delta": {
      const base = message.id === prev.turnId ? prev.text : "";
      return { ...prev, turnId: message.id, text: tail(base + message.text) };
    }
    // « Waiting » est dérivé au rendu depuis le statut : on ne touche ni à text ni à turnId.
    case "permission_request":
      return { ...prev, waitingFor: clip(message.displayName ?? message.toolName) };
    case "question_request":
      return { ...prev, waitingFor: "question" };
    case "error":
      return { turnId: null, text: clip(message.message), waitingFor: prev.waitingFor };
    case "conversation_reset":
      return EMPTY_ACTIVITY;
    default:
      return prev;
  }
}

/** « Waiting » n'est montré que tant que le statut est needs_input : le lifecycle reste seule source de vérité. */
export function displayActivity(activity: Activity, status: SessionStatus | null): string {
  return status === "needs_input" && activity.waitingFor !== null
    ? `Waiting: ${activity.waitingFor}`
    : activity.text;
}
