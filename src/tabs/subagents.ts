import type { ConversationMessage, SubagentUpdate } from "../types/protocol";

export interface Subagent {
  taskId: string;
  toolUseId?: string;
  description: string;
  subagentType?: string;
  status: NonNullable<SubagentUpdate["status"]>;
  lastToolName?: string;
  usage?: SubagentUpdate["usage"];
}

export type Subagents = readonly Subagent[];

export const EMPTY_SUBAGENTS: Subagents = [];

/** Fusionne seulement les champs définis : task_updated peut n'apporter que le statut. */
function merge(prev: Subagent | undefined, u: SubagentUpdate): Subagent {
  const next: Subagent = { ...(prev ?? { taskId: u.taskId, description: "", status: "running" }) };
  if (u.toolUseId !== undefined) next.toolUseId = u.toolUseId;
  if (u.description !== undefined) next.description = u.description;
  if (u.subagentType !== undefined) next.subagentType = u.subagentType;
  // Un progress tardif ne ressuscite pas un agent déjà terminé.
  if (u.status !== undefined && !(next.status !== "running" && u.status === "running")) next.status = u.status;
  if (u.lastToolName !== undefined) next.lastToolName = u.lastToolName;
  if (u.usage !== undefined) next.usage = u.usage;
  return next;
}

function same(a: Subagent, b: Subagent): boolean {
  return (
    a.toolUseId === b.toolUseId &&
    a.description === b.description &&
    a.subagentType === b.subagentType &&
    a.status === b.status &&
    a.lastToolName === b.lastToolName &&
    a.usage?.totalTokens === b.usage?.totalTokens &&
    a.usage?.toolUses === b.usage?.toolUses &&
    a.usage?.durationMs === b.usage?.durationMs
  );
}

/** Sous-agents d'une session, déduits du flux de messages. */
export function nextSubagents(prev: Subagents, message: ConversationMessage): Subagents {
  switch (message.type) {
    case "subagent_update": {
      const i = prev.findIndex((s) => s.taskId === message.taskId);
      const merged = merge(prev[i], message);
      if (i === -1) return [...prev, merged];
      if (same(prev[i], merged)) return prev;
      return prev.map((s, j) => (j === i ? merged : s));
    }
    // Nouveau tour : les sous-agents terminés du tour précédent disparaissent.
    case "user_echo": {
      const kept = prev.filter((s) => s.status === "running");
      return kept.length === prev.length ? prev : kept;
    }
    case "conversation_reset":
      return prev.length === 0 ? prev : EMPTY_SUBAGENTS;
    default:
      return prev;
  }
}

const STATUS_LABEL: Record<Subagent["status"], string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** Libellé court d'un sous-agent pour le panneau Sessions. */
export function subagentLine(s: Subagent): string {
  // Le dernier outil n'a de sens que pendant le run (en fin, c'est le SubagentHandback).
  const tool = s.status === "running" ? s.lastToolName : undefined;
  return [s.subagentType ?? "agent", s.description, STATUS_LABEL[s.status], tool]
    .filter((p) => p)
    .join(" · ");
}
