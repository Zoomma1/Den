// Fonctions pures extraites de main.ts : lecture des messages du SDK.

import type { SubagentReport, SubagentUpdate } from "../../src/types/protocol";

export interface ToolResultOf {
  toolUseId: string;
  output: unknown;
  structured?: unknown;
  isError?: boolean;
}

/**
 * Résultats d'outils d'un message SDK `user`. `tool_use_result` est porté par le
 * message, pas par bloc : un seul bloc -> on l'attache ; plusieurs blocs -> seulement
 * si c'est un tableau de même longueur (association par index, forme non mesurée
 * contre le vrai SDK). Sinon on ne devine pas : pas de `structured`, repli sur la sortie brute.
 */
export function toolResultsOf(msg: { message?: { content?: unknown }; tool_use_result?: unknown }): ToolResultOf[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  const blocks = content.filter((b: any) => b?.type === "tool_result");
  const tur = msg.tool_use_result;
  return blocks.map((b: any, i: number) => {
    let structured: unknown;
    if (blocks.length === 1) structured = tur;
    else if (Array.isArray(tur) && tur.length === blocks.length) structured = tur[i];
    return {
      toolUseId: b.tool_use_id,
      output: b.content,
      ...(structured !== undefined ? { structured } : {}),
      isError: b.is_error,
    };
  });
}

export interface CommandOutputOf {
  command: string;
  args: string;
  text: string;
  isError?: boolean;
}

const ENVELOPE = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

/** Sortie d'une commande slash : message `assistant` synthétique portant `local_command_run`, sinon null. */
export function commandOutputOf(msg: any): CommandOutputOf | null {
  if (msg?.type !== "assistant" || !msg.local_command_run) return null;
  const { command, args } = msg.local_command_run;
  const raw: unknown =
    typeof msg.local_command_source === "string"
      ? msg.local_command_source
      : msg.message?.content?.find?.((b: any) => b?.type === "text")?.text;
  if (typeof raw !== "string") return null;
  const m = ENVELOPE.exec(raw);
  return { command: String(command ?? ""), args: String(args ?? ""), text: m ? m[1] : raw };
}

/** Durée du tour pour le pied « Worked for » : absente d'un result à 0 tour (commande slash, aucun travail). */
export function durationMsOf(result: any): number | undefined {
  return typeof result?.duration_ms === "number" && result.num_turns > 0 ? result.duration_ms : undefined;
}

const SUBAGENT_TASK_TYPES = ["local_agent", "local_workflow"];
const PATCH_STATUS: Record<string, NonNullable<SubagentUpdate["status"]>> = {
  pending: "running",
  running: "running",
  paused: "running",
  completed: "completed",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
};

// hasOwn : un statut hors table ne doit pas tomber sur le prototype de l'objet.
const statusOf = (s: unknown): SubagentUpdate["status"] | undefined =>
  typeof s === "string" && Object.hasOwn(PATCH_STATUS, s) ? PATCH_STATUS[s] : undefined;

const usageOf = (u: any): SubagentUpdate["usage"] | undefined =>
  u && typeof u === "object"
    ? { totalTokens: u.total_tokens, toolUses: u.tool_uses, durationMs: u.duration_ms }
    : undefined;

const opt = (k: string, v: unknown) => (v !== undefined ? { [k]: v } : {});

/** Mise à jour de card sous-agent depuis un message system task_*; `known` mémorise les task_started retenus (les autres tâches sont ignorées). */
export function subagentUpdateOf(msg: any, known: Set<string>): SubagentUpdate | null {
  if (msg?.type !== "system" || typeof msg.task_id !== "string") return null;
  const taskId: string = msg.task_id;
  switch (msg.subtype) {
    case "task_started":
      if (msg.ambient || msg.skip_transcript) return null;
      if (msg.task_type !== undefined && !SUBAGENT_TASK_TYPES.includes(msg.task_type)) return null;
      known.add(taskId);
      return {
        type: "subagent_update",
        taskId,
        status: "running",
        ...opt("toolUseId", msg.tool_use_id),
        ...opt("description", msg.description),
        ...opt("subagentType", msg.subagent_type),
        ...opt("isBackgrounded", msg.is_backgrounded),
      };
    case "task_progress":
      if (!known.has(taskId)) return null;
      return {
        type: "subagent_update",
        taskId,
        status: "running",
        ...opt("toolUseId", msg.tool_use_id),
        // Pas de description : un progress porte parfois « Running <cmd> » qui écraserait le libellé du started.
        ...opt("lastToolName", msg.last_tool_name),
        ...opt("usage", usageOf(msg.usage)),
      };
    case "task_updated": {
      if (!known.has(taskId)) return null;
      return {
        type: "subagent_update",
        taskId,
        ...opt("status", statusOf(msg.patch?.status)),
        ...opt("description", msg.patch?.description),
      };
    }
    case "task_notification":
      if (!known.has(taskId)) return null;
      return {
        type: "subagent_update",
        taskId,
        ...opt("status", statusOf(msg.status)),
        ...opt("toolUseId", msg.tool_use_id),
        ...opt("usage", usageOf(msg.usage)),
      };
    default:
      return null;
  }
}

/** Rapport markdown d'un sous-agent : input.message de son tool_use SubagentHandback, rattaché au tool_use Agent du parent. */
export function subagentReportOf(msg: any): SubagentReport | null {
  if (msg?.type !== "assistant" || msg.parent_tool_use_id == null) return null;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;
  const block = content.find((b: any) => b?.type === "tool_use" && b.name === "SubagentHandback");
  if (typeof block?.input?.message !== "string") return null;
  return { type: "subagent_report", toolUseId: msg.parent_tool_use_id, text: block.input.message };
}
