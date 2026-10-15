import type { ConversationMessage, SubagentStep, SubagentUpdate, WorkflowProgress } from "../types/protocol";

export interface SubagentStepView {
  kind: "text" | "tool_use" | "tool_result";
  toolUseId?: string;
  name?: string;
  text: string;
  truncated: boolean;
  isError?: boolean;
}

export const MAX_SUBAGENTS = 20;
export const MAX_STEPS = 200;

export interface Subagent {
  taskId: string;
  toolUseId?: string;
  description: string;
  subagentType?: string;
  status: NonNullable<SubagentUpdate["status"]>;
  lastToolName?: string;
  usage?: SubagentUpdate["usage"];
  prompt?: string;
  steps: readonly SubagentStepView[];
  report?: string;
  depth: number;
  workflowName?: string;
  workflow?: WorkflowProgress;
  parentTaskId?: string;
  turnsSinceEnd: number;
  /** Total monotone d'étapes reçues : l'index absolu de steps[i] vaut stepCount - steps.length + i. */
  stepCount: number;
}

export type Subagents = readonly Subagent[];

export const EMPTY_SUBAGENTS: Subagents = [];

/** Fusionne seulement les champs définis : task_updated peut n'apporter que le statut. */
function merge(prev: Subagent | undefined, u: SubagentUpdate): Subagent {
  const next: Subagent = {
    ...(prev ?? { taskId: u.taskId, description: "", status: "running", steps: [], depth: 1, turnsSinceEnd: 0, stepCount: 0 }),
  };
  if (u.toolUseId !== undefined) next.toolUseId = u.toolUseId;
  if (u.description !== undefined) next.description = u.description;
  if (u.subagentType !== undefined) next.subagentType = u.subagentType;
  // Un progress tardif ne ressuscite pas un agent déjà terminé.
  if (u.status !== undefined && !(next.status !== "running" && u.status === "running")) next.status = u.status;
  if (u.lastToolName !== undefined) next.lastToolName = u.lastToolName;
  if (u.usage !== undefined) next.usage = u.usage;
  if (u.prompt !== undefined) next.prompt = u.prompt;
  if (u.spawnDepth !== undefined) next.depth = u.spawnDepth;
  if (u.workflowName !== undefined) next.workflowName = u.workflowName;
  if (u.workflow !== undefined) next.workflow = u.workflow;
  // Workflow terminé : un agent resté queued/running dans le dernier snapshot ne le sera plus jamais.
  if (next.workflow && next.status !== "running") {
    const end = next.status === "completed" ? "done" : "failed";
    next.workflow = {
      ...next.workflow,
      agents: next.workflow.agents.map((a) => (a.state === "queued" || a.state === "running" ? { ...a, state: end } : a)),
    };
  }
  return next;
}

/** Le tool_use du parent précède le task_started de l'enfant ; un step évincé par le cap n'est plus retrouvable (accepté). */
function findParentTaskId(list: Subagents, taskId: string, toolUseId: string): string | undefined {
  return list.find(
    (s) => s.taskId !== taskId && s.steps.some((st) => st.kind === "tool_use" && st.toolUseId === toolUseId),
  )?.taskId;
}

function same(a: Subagent, b: Subagent): boolean {
  return (
    a.toolUseId === b.toolUseId &&
    a.description === b.description &&
    a.subagentType === b.subagentType &&
    a.status === b.status &&
    a.prompt === b.prompt &&
    a.depth === b.depth &&
    a.parentTaskId === b.parentTaskId &&
    a.lastToolName === b.lastToolName &&
    a.workflowName === b.workflowName &&
    // Snapshot rejoué à l'identique à chaque progress : comparaison par valeur.
    JSON.stringify(a.workflow) === JSON.stringify(b.workflow) &&
    a.usage?.totalTokens === b.usage?.totalTokens &&
    a.usage?.toolUses === b.usage?.toolUses &&
    a.usage?.durationMs === b.usage?.durationMs
  );
}

/** Au-delà du plafond, les plus anciens terminés partent ; un running n'est jamais retiré. */
function capAgents(list: Subagents): Subagents {
  let excess = list.length - MAX_SUBAGENTS;
  if (excess <= 0) return list;
  return list.filter((s) => {
    if (excess > 0 && s.status !== "running") {
      excess--;
      return false;
    }
    return true;
  });
}

function addStep(prev: Subagents, m: SubagentStep): Subagents {
  const i = prev.findIndex((s) => s.toolUseId === m.parentToolUseId);
  if (i === -1) return prev;
  const { type: _type, parentToolUseId: _parent, ...view } = m;
  const agent = prev[i];
  const steps = [...agent.steps, view].slice(-MAX_STEPS);
  return prev.map((s, j) => {
    if (j === i) return { ...s, steps, stepCount: s.stepCount + 1 };
    // Un tool_use Agent émis par cet agent désigne le sous-agent imbriqué.
    if (m.kind === "tool_use" && m.toolUseId !== undefined && s.toolUseId === m.toolUseId) {
      return { ...s, parentTaskId: agent.taskId };
    }
    return s;
  });
}

/** Sous-agents d'une session, déduits du flux de messages. */
export function nextSubagents(prev: Subagents, message: ConversationMessage): Subagents {
  switch (message.type) {
    case "subagent_update": {
      const i = prev.findIndex((s) => s.taskId === message.taskId);
      const merged = merge(prev[i], message);
      if (merged.toolUseId !== undefined && merged.parentTaskId === undefined && prev[i]?.toolUseId !== merged.toolUseId) {
        const parent = findParentTaskId(prev, merged.taskId, merged.toolUseId);
        if (parent !== undefined) merged.parentTaskId = parent;
      }
      if (i === -1) return capAgents([...prev, merged]);
      if (same(prev[i], merged)) return prev;
      return prev.map((s, j) => (j === i ? merged : s));
    }
    case "subagent_step":
      return addStep(prev, message);
    case "subagent_report": {
      const i = prev.findIndex((s) => s.toolUseId === message.toolUseId);
      if (i === -1 || prev[i].report === message.text) return prev;
      return prev.map((s, j) => (j === i ? { ...s, report: message.text } : s));
    }
    // Un tour utilisateur démarre : les agents terminés comptent un tour de plus (les `done` déclenchés par les rapports d'agents n'ont pas de user_echo).
    case "user_echo": {
      if (prev.every((s) => s.status === "running")) return prev;
      return prev.map((s) => (s.status === "running" ? s : { ...s, turnsSinceEnd: s.turnsSinceEnd + 1 }));
    }
    // Fin du tour utilisateur qui a vu l'agent terminé : il part.
    case "done": {
      if (prev.every((s) => s.status === "running" || s.turnsSinceEnd < 1)) return prev;
      return prev.filter((s) => s.status === "running" || s.turnsSinceEnd < 1);
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

/** Libellé d'un workflow (panneau Sessions et overlay) ; n/m absent avant le premier snapshot. */
export function workflowLine(s: Subagent): string {
  const counts = s.workflow
    ? `${s.workflow.agents.filter((a) => a.state === "done").length}/${s.workflow.agents.length} agents`
    : "";
  return ["workflow", s.workflowName ?? s.description, counts, STATUS_LABEL[s.status]].filter((p) => p).join(" · ");
}

/** Libellé court d'un sous-agent pour le panneau Sessions. */
export function subagentLine(s: Subagent): string {
  if (s.workflow || s.workflowName) return workflowLine(s);
  // Le dernier outil n'a de sens que pendant le run (en fin, c'est le SubagentHandback).
  const tool = s.status === "running" ? s.lastToolName : undefined;
  return [s.subagentType ?? "agent", s.description, STATUS_LABEL[s.status], tool]
    .filter((p) => p)
    .join(" · ");
}
