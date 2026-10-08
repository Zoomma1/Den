import { describe, it, expect } from "vitest";
import { EMPTY_ACTIVITY, displayActivity, nextActivity } from "./activity";
import type { ConversationMessage } from "../types/protocol";

const delta = (id: string, text: string) =>
  ({ type: "assistant_delta", id, text }) as ConversationMessage;

describe("nextActivity", () => {
  it("concatène les deltas d'un même tour", () => {
    let a = nextActivity(EMPTY_ACTIVITY, delta("t1", "Hello "));
    a = nextActivity(a, delta("t1", "world"));
    expect(a).toEqual({ turnId: "t1", text: "Hello world", waitingFor: null });
  });

  it("repart de zéro sur un nouveau tour", () => {
    let a = nextActivity(EMPTY_ACTIVITY, delta("t1", "old"));
    a = nextActivity(a, delta("t2", "new"));
    expect(a).toEqual({ turnId: "t2", text: "new", waitingFor: null });
  });

  it("écrase les espaces et garde les 120 derniers caractères", () => {
    const a = nextActivity(EMPTY_ACTIVITY, delta("t1", `a\n\n  b ${"x".repeat(200)}`));
    expect(a.text).toHaveLength(120);
    expect(a.text).toBe("x".repeat(120));
    expect(nextActivity(EMPTY_ACTIVITY, delta("t1", "a\n\n  b")).text).toBe("a b");
  });

  it("error affiche le message, conversation_reset vide", () => {
    const e = nextActivity(EMPTY_ACTIVITY, { type: "error", message: "boom" });
    expect(e.text).toBe("boom");
    const r = nextActivity(e, {
      type: "conversation_reset",
      sessionId: "s",
      newConversationId: "c",
    });
    expect(r).toEqual(EMPTY_ACTIVITY);
  });

  it("ignore les autres messages", () => {
    const prev = { turnId: "t1", text: "x", waitingFor: null };
    expect(nextActivity(prev, { type: "done" })).toBe(prev);
  });

  const perm = { type: "permission_request", requestId: "r", toolName: "Bash", input: {} } as const;

  it("borne error et Waiting à 120 caractères", () => {
    expect(nextActivity(EMPTY_ACTIVITY, { type: "error", message: "e".repeat(500) }).text).toHaveLength(120);
    expect(nextActivity(EMPTY_ACTIVITY, { ...perm, toolName: "T".repeat(500) }).waitingFor).toHaveLength(120);
  });

  const permBase = { type: "permission_request", requestId: "r", input: {} } as const;

  it("permission_request pose waitingFor sans toucher text ni turnId (displayName prioritaire)", () => {
    const prev = { turnId: "t1", text: "avant", waitingFor: null };
    expect(nextActivity(prev, perm)).toEqual({ turnId: "t1", text: "avant", waitingFor: "Bash" });
    expect(nextActivity(prev, { ...permBase, toolName: "Bash", displayName: "Run command" }).waitingFor).toBe("Run command");
  });

  it("question_request pose waitingFor = question sans toucher text", () => {
    const prev = { turnId: "t1", text: "avant", waitingFor: null };
    expect(nextActivity(prev, { type: "question_request", requestId: "r", question: "?" })).toEqual({
      turnId: "t1",
      text: "avant",
      waitingFor: "question",
    });
  });

  it("tool_use / tool_result / done / user_echo renvoient prev", () => {
    const prev = { turnId: "t1", text: "x", waitingFor: "Bash" };
    for (const type of ["tool_use", "tool_result", "done", "user_echo"]) {
      expect(nextActivity(prev, { type } as ConversationMessage)).toBe(prev);
    }
  });

  it("error puis done garde l'erreur", () => {
    const e = nextActivity(EMPTY_ACTIVITY, { type: "error", message: "boom" });
    expect(nextActivity(e, { type: "done" }).text).toBe("boom");
  });

  it("delta après error repart propre", () => {
    const e = nextActivity(EMPTY_ACTIVITY, { type: "error", message: "boom" });
    expect(nextActivity(e, delta("t2", "ok")).text).toBe("ok");
  });
});

describe("displayActivity", () => {
  const perm = (toolName: string) =>
    ({ type: "permission_request", requestId: "r", toolName, input: {} }) as ConversationMessage;

  it("needs_input avec waitingFor : Waiting: X", () => {
    const a = nextActivity({ turnId: "t1", text: "avant", waitingFor: null }, perm("Bash"));
    expect(displayActivity(a, "needs_input")).toBe("Waiting: Bash");
  });

  it("running après validation : texte précédent", () => {
    const a = nextActivity({ turnId: "t1", text: "avant", waitingFor: null }, perm("Bash"));
    expect(displayActivity(a, "running")).toBe("avant");
  });

  it("deux permissions : montre la dernière tant que needs_input", () => {
    let a = nextActivity(EMPTY_ACTIVITY, perm("Bash"));
    a = nextActivity(a, perm("Edit"));
    expect(displayActivity(a, "needs_input")).toBe("Waiting: Edit");
  });

  it("needs_input sans waitingFor : texte", () => {
    expect(displayActivity({ turnId: "t", text: "x", waitingFor: null }, "needs_input")).toBe("x");
  });
});
