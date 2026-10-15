import { describe, it, expect } from "vitest";
import { EMPTY_SUBAGENTS, MAX_STEPS, MAX_SUBAGENTS, nextSubagents, subagentLine } from "./subagents";
import type { ConversationMessage } from "../types/protocol";

const msg = (m: object) => m as ConversationMessage;
const started = msg({
  type: "subagent_update",
  taskId: "a1",
  toolUseId: "toolu_1",
  description: "Lire package.json",
  subagentType: "Explore",
  isBackgrounded: false,
});

describe("nextSubagents", () => {
  it("crée une entrée running avec les défauts", () => {
    const s = nextSubagents(EMPTY_SUBAGENTS, msg({ type: "subagent_update", taskId: "a1" }));
    expect(s).toEqual([
      { taskId: "a1", description: "", status: "running", steps: [], depth: 1, turnsSinceEnd: 0, stepCount: 0 },
    ]);
  });

  it("fusionne progress puis un task_updated qui n'a que le statut", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, started);
    s = nextSubagents(
      s,
      msg({
        type: "subagent_update",
        taskId: "a1",
        lastToolName: "Bash",
        usage: { totalTokens: 10, toolUses: 1, durationMs: 5 },
      }),
    );
    s = nextSubagents(s, msg({ type: "subagent_update", taskId: "a1", status: "completed" }));
    expect(s).toEqual([
      {
        taskId: "a1",
        toolUseId: "toolu_1",
        description: "Lire package.json",
        subagentType: "Explore",
        status: "completed",
        lastToolName: "Bash",
        usage: { totalTokens: 10, toolUses: 1, durationMs: 5 },
        steps: [],
        depth: 1,
        turnsSinceEnd: 0,
        stepCount: 0,
      },
    ]);
  });

  it("garde l'ordre d'arrivée", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, started);
    s = nextSubagents(s, msg({ type: "subagent_update", taskId: "a2", description: "B" }));
    s = nextSubagents(s, msg({ type: "subagent_update", taskId: "a1", status: "failed" }));
    expect(s.map((x) => x.taskId)).toEqual(["a1", "a2"]);
  });

  it("est immuable et renvoie prev si rien ne change", () => {
    const s1 = nextSubagents(EMPTY_SUBAGENTS, started);
    const snapshot = JSON.stringify(s1);
    const s2 = nextSubagents(s1, msg({ type: "subagent_update", taskId: "a1", status: "completed" }));
    expect(s2).not.toBe(s1);
    expect(JSON.stringify(s1)).toBe(snapshot);
    expect(nextSubagents(s2, msg({ type: "subagent_update", taskId: "a1", status: "completed" }))).toBe(s2);
    expect(nextSubagents(s1, msg({ type: "done" }))).toBe(s1);
  });

  it("user_echo ne purge rien", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, started);
    s = nextSubagents(s, msg({ type: "subagent_update", taskId: "a1", status: "completed" }));
    expect(nextSubagents(s, msg({ type: "user_echo", id: "u", text: "x" }))).toHaveLength(1);
  });

  it("conversation_reset vide", () => {
    const s = nextSubagents(EMPTY_SUBAGENTS, started);
    expect(nextSubagents(s, msg({ type: "conversation_reset" }))).toEqual([]);
    expect(nextSubagents(EMPTY_SUBAGENTS, msg({ type: "conversation_reset" }))).toBe(EMPTY_SUBAGENTS);
  });
});

describe("agent terminé", () => {
  it("un update « running » tardif ne le ressuscite pas", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, msg({ type: "subagent_update", taskId: "a", description: "Lire", status: "completed" }));
    s = nextSubagents(s, msg({ type: "subagent_update", taskId: "a", status: "running", lastToolName: "Bash" }));
    expect(s[0].status).toBe("completed");
  });
});

const upd = (taskId: string, extra: object = {}) =>
  msg({ type: "subagent_update", taskId, toolUseId: `tu_${taskId}`, ...extra });
const step = (parent: string, extra: object = {}) =>
  msg({ type: "subagent_step", parentToolUseId: parent, kind: "text", text: "t", truncated: false, ...extra });

describe("étapes, rapport, imbrication", () => {
  it("fusionne prompt et spawnDepth", () => {
    const s = nextSubagents(EMPTY_SUBAGENTS, upd("a", { prompt: "P", spawnDepth: 2 }));
    expect(s[0]).toMatchObject({ prompt: "P", depth: 2 });
  });

  it("ajoute les étapes et garde les MAX_STEPS dernières", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a"));
    for (let n = 0; n < MAX_STEPS + 5; n++) s = nextSubagents(s, step("tu_a", { text: String(n) }));
    expect(s[0].steps).toHaveLength(MAX_STEPS);
    expect(s[0].steps[0].text).toBe("5");
    expect(s[0].steps[0]).not.toHaveProperty("type");
  });

  it("ignore une étape ou un rapport d'agent inconnu", () => {
    const s = nextSubagents(EMPTY_SUBAGENTS, upd("a"));
    expect(nextSubagents(s, step("nope"))).toBe(s);
    expect(nextSubagents(s, msg({ type: "subagent_report", toolUseId: "nope", text: "r" }))).toBe(s);
  });

  it("pose le rapport", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a"));
    s = nextSubagents(s, msg({ type: "subagent_report", toolUseId: "tu_a", text: "R" }));
    expect(s[0].report).toBe("R");
  });

  it("un tool_use vers un autre agent pose son parentTaskId", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a"));
    s = nextSubagents(s, upd("b", { spawnDepth: 2 }));
    s = nextSubagents(s, step("tu_a", { kind: "tool_use", toolUseId: "tu_b", name: "Agent" }));
    expect(s[1].parentTaskId).toBe("a");
    expect(s[0].parentTaskId).toBeUndefined();
  });
});

describe("ordre réel du SDK et stepCount", () => {
  it("le tool_use du parent précède le subagent_update de l'enfant", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a"));
    s = nextSubagents(s, step("tu_a", { kind: "tool_use", toolUseId: "tu_b", name: "Agent" }));
    s = nextSubagents(s, upd("b", { spawnDepth: 2 }));
    expect(s[1].parentTaskId).toBe("a");
    expect(s[1].depth).toBe(2);
    expect(s[0].parentTaskId).toBeUndefined();
  });

  it("stepCount reste monotone au-delà de MAX_STEPS", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a"));
    for (let n = 0; n < MAX_STEPS + 7; n++) s = nextSubagents(s, step("tu_a"));
    expect(s[0].steps).toHaveLength(MAX_STEPS);
    expect(s[0].stepCount).toBe(MAX_STEPS + 7);
  });
});

describe("rétention et plafond", () => {
  const done = msg({ type: "done" });

  const echo = msg({ type: "user_echo", id: "u", text: "x" });

  it("un agent terminé survit aux done sans message utilisateur (rapports d'agents)", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a", { status: "completed" }));
    for (let n = 0; n < 3; n++) s = nextSubagents(s, done);
    expect(s.map((x) => x.taskId)).toEqual(["a"]);
    expect(s[0].turnsSinceEnd).toBe(0);
  });

  it("un agent terminé reste lisible pendant le tour utilisateur suivant et part à son done", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a", { status: "completed" }));
    s = nextSubagents(s, done);
    s = nextSubagents(s, echo);
    expect(s.map((x) => x.taskId)).toEqual(["a"]);
    expect(s[0].turnsSinceEnd).toBe(1);
    expect(nextSubagents(s, done)).toEqual([]);
  });

  it("un agent running n'est jamais purgé", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("a"));
    for (let n = 0; n < 5; n++) s = nextSubagents(nextSubagents(s, echo), done);
    expect(s).toHaveLength(1);
    expect(s[0].turnsSinceEnd).toBe(0);
  });

  it("plafonne à MAX_SUBAGENTS en retirant les plus anciens terminés", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd("run"));
    for (let n = 0; n < MAX_SUBAGENTS + 3; n++) {
      s = nextSubagents(s, upd(`d${n}`, { status: "completed" }));
    }
    expect(s).toHaveLength(MAX_SUBAGENTS);
    expect(s[0].taskId).toBe("run");
    expect(s[1].taskId).toBe("d4");
  });

  it("dépasse le plafond si tout est running", () => {
    let s = EMPTY_SUBAGENTS;
    for (let n = 0; n < MAX_SUBAGENTS + 2; n++) s = nextSubagents(s, upd(`r${n}`));
    expect(s).toHaveLength(MAX_SUBAGENTS + 2);
  });

  it("garde la référence quand rien ne change", () => {
    const s = nextSubagents(EMPTY_SUBAGENTS, upd("a", { prompt: "P", spawnDepth: 1 }));
    expect(nextSubagents(s, upd("a", { prompt: "P", spawnDepth: 1 }))).toBe(s);
    const r = nextSubagents(s, msg({ type: "subagent_report", toolUseId: "tu_a", text: "R" }));
    expect(nextSubagents(r, msg({ type: "subagent_report", toolUseId: "tu_a", text: "R" }))).toBe(r);
  });
});

describe("subagentLine", () => {
  it("assemble les parties non vides", () => {
    const s = nextSubagents(
      EMPTY_SUBAGENTS,
      msg({ type: "subagent_update", taskId: "a", description: "Lire", subagentType: "Explore", lastToolName: "Bash" }),
    );
    expect(subagentLine(s[0])).toBe("Explore · Lire · Running · Bash");
  });

  it("n'affiche plus le dernier outil une fois terminé", () => {
    const s = nextSubagents(
      EMPTY_SUBAGENTS,
      msg({ type: "subagent_update", taskId: "a", description: "Lire", status: "completed", lastToolName: "SubagentHandback" }),
    );
    expect(subagentLine(s[0])).toBe("agent · Lire · Done");
  });

  it("omet les parties vides", () => {
    const s = nextSubagents(EMPTY_SUBAGENTS, msg({ type: "subagent_update", taskId: "a", status: "failed" }));
    expect(subagentLine(s[0])).toBe("agent · Failed");
  });
});

describe("workflow", () => {
  const wf = (states: string[]) => ({
    phases: [{ index: 1, title: "Alpha" }],
    agents: states.map((state, i) => ({ index: i + 1, label: `A${i + 1}`, phaseIndex: 1, state })),
  });
  const upd = (extra: object) => msg({ type: "subagent_update", taskId: "w", ...extra });

  it("merge conserve workflow quand un update ne le porte pas, et le remplace sinon", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd({ workflowName: "spike", workflow: wf(["running"]) }));
    s = nextSubagents(s, upd({ lastToolName: "x" }));
    expect(s[0].workflow).toEqual(wf(["running"]));
    expect(s[0].workflowName).toBe("spike");
    s = nextSubagents(s, upd({ workflow: wf(["done"]) }));
    expect(s[0].workflow).toEqual(wf(["done"]));
  });

  it("same détecte un changement de workflow, ignore un snapshot identique", () => {
    const s1 = nextSubagents(EMPTY_SUBAGENTS, upd({ workflow: wf(["running", "queued"]) }));
    const s2 = nextSubagents(s1, upd({ workflow: wf(["running", "queued"]) }));
    expect(s2).toBe(s1);
    const s3 = nextSubagents(s1, upd({ workflow: wf(["done", "queued"]) }));
    expect(s3).not.toBe(s1);
    expect(s3[0].workflow?.agents[0].state).toBe("done");
  });

  it("subagentLine : n/m agents, sans dernier outil", () => {
    const s = nextSubagents(
      EMPTY_SUBAGENTS,
      upd({ description: "desc", workflowName: "spike", lastToolName: "A1", workflow: wf(["done", "running", "queued"]) }),
    );
    expect(subagentLine(s[0])).toBe("workflow · spike · 1/3 agents · Running");
    const f = nextSubagents(s, upd({ status: "failed" }));
    expect(subagentLine(f[0])).toBe("workflow · spike · 1/3 agents · Failed");
  });

  it("fin de tâche : les agents queued/running sont rabattus (failed/stopped -> failed, completed -> done)", () => {
    const live = wf(["done", "running", "queued"]);
    for (const [status, end] of [["failed", "failed"], ["stopped", "failed"], ["completed", "done"]] as const) {
      let s = nextSubagents(EMPTY_SUBAGENTS, upd({ workflow: live }));
      s = nextSubagents(s, upd({ status }));
      expect(s[0].workflow?.agents.map((a) => a.state)).toEqual(["done", end, end]);
    }
  });

  it("progress tardif après fin : ni le statut ni les agents ne ressuscitent", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, upd({ workflow: wf(["running"]) }));
    s = nextSubagents(s, upd({ status: "failed" }));
    s = nextSubagents(s, upd({ status: "running", workflow: wf(["running", "queued"]) }));
    expect(s[0].status).toBe("failed");
    expect(s[0].workflow?.agents.map((a) => a.state)).toEqual(["failed", "failed"]);
  });

  it("subagentLine : avant le premier snapshot, pas de n/m", () => {
    const s = nextSubagents(EMPTY_SUBAGENTS, upd({ workflowName: "spike" }));
    expect(subagentLine(s[0])).toBe("workflow · spike · Running");
  });

  it("same prend en compte les nouveaux champs d'agent, et le rabattement les garde", () => {
    const agentWith = (extra: object) => ({ phases: [], agents: [{ index: 1, label: "A", phaseIndex: 1, state: "running", ...extra }] });
    const s1 = nextSubagents(EMPTY_SUBAGENTS, upd({ workflow: agentWith({ tokens: 1 }) }));
    expect(nextSubagents(s1, upd({ workflow: agentWith({ tokens: 2 }) }))).not.toBe(s1);
    const s2 = nextSubagents(s1, upd({ status: "failed" }));
    expect(s2[0].workflow?.agents[0]).toMatchObject({ state: "failed", tokens: 1 });
  });
});
