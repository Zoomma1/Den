import { describe, it, expect } from "vitest";
import { EMPTY_SUBAGENTS, nextSubagents, subagentLine } from "./subagents";
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
    expect(s).toEqual([{ taskId: "a1", description: "", status: "running" }]);
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
    expect(nextSubagents(s2, msg({ type: "done" }))).toBe(s2);
  });

  it("user_echo retire les non-running", () => {
    let s = nextSubagents(EMPTY_SUBAGENTS, started);
    s = nextSubagents(s, msg({ type: "subagent_update", taskId: "a2", description: "B" }));
    s = nextSubagents(s, msg({ type: "subagent_update", taskId: "a1", status: "completed" }));
    s = nextSubagents(s, msg({ type: "user_echo", id: "u", text: "x" }));
    expect(s.map((x) => x.taskId)).toEqual(["a2"]);
    expect(nextSubagents(s, msg({ type: "user_echo", id: "u2", text: "y" }))).toBe(s);
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
