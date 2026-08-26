import { describe, expect, it } from "vitest";
import { reduceTabLifecycle, type TabLifecycleState } from "./lifecycle";

const errorMsg = { type: "error" as const, message: "boom" };
const doneMsg = { type: "done" as const };
const assistantMsg = { type: "assistant_delta" as const, id: "1", text: "hi" };

describe("reduceTabLifecycle", () => {
  it("created -> idle", () => {
    expect(reduceTabLifecycle("idle", { kind: "created" })).toBe("idle");
  });

  it("idle + prompt_submitted -> running", () => {
    expect(reduceTabLifecycle("idle", { kind: "prompt_submitted" })).toBe(
      "running",
    );
  });

  it("running + done -> idle", () => {
    expect(
      reduceTabLifecycle("running", {
        kind: "sidecar_message",
        message: doneMsg,
      }),
    ).toBe("idle");
  });

  it("running + error -> error", () => {
    expect(
      reduceTabLifecycle("running", {
        kind: "sidecar_message",
        message: errorMsg,
      }),
    ).toBe("error");
  });

  it("running + message ni error ni done -> reste running", () => {
    expect(
      reduceTabLifecycle("running", {
        kind: "sidecar_message",
        message: assistantMsg,
      }),
    ).toBe("running");
  });

  it("error + done -> reste error (sticky)", () => {
    expect(
      reduceTabLifecycle("error", {
        kind: "sidecar_message",
        message: doneMsg,
      }),
    ).toBe("error");
  });

  it("error + prompt_submitted -> reste error (pas de respawn implicite)", () => {
    expect(reduceTabLifecycle("error", { kind: "prompt_submitted" })).toBe(
      "error",
    );
  });

  it("closed est terminal quel que soit l'événement", () => {
    const events: Array<Parameters<typeof reduceTabLifecycle>[1]> = [
      { kind: "created" },
      { kind: "prompt_submitted" },
      { kind: "sidecar_message", message: doneMsg },
      { kind: "sidecar_message", message: errorMsg },
      { kind: "closed" },
    ];
    for (const event of events) {
      expect(reduceTabLifecycle("closed", event)).toBe("closed");
    }
  });

  it("closed atteignable depuis idle, running et error", () => {
    const states: TabLifecycleState[] = ["idle", "running", "error"];
    for (const state of states) {
      expect(reduceTabLifecycle(state, { kind: "closed" })).toBe("closed");
    }
  });
});
