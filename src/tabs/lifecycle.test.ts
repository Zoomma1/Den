import { describe, expect, it } from "vitest";
import {
  INITIAL_TAB_LIFECYCLE,
  reduceTabLifecycle,
  type TabLifecycle,
} from "./lifecycle";
import type { SidecarToUIMessage } from "../types/protocol";

const errorMsg = { type: "error" as const, message: "boom" };
const doneMsg = { type: "done" as const };
const assistantMsg = { type: "assistant_delta" as const, id: "1", text: "hi" };
const permissionMsg = {
  type: "permission_request" as const,
  requestId: "r1",
  toolName: "Bash",
  input: {},
};
const toolResultMsg = {
  type: "tool_result" as const,
  id: "m2",
  toolUseId: "t1",
  output: "ok",
};
const conversationResetMsg = {
  type: "conversation_reset" as const,
  sessionId: "s1",
  newConversationId: "c2",
};

function lifecycle(
  state: TabLifecycle["state"],
  pendingTurns = 0,
  pendingRequests = 0,
): TabLifecycle {
  return { state, pendingTurns, pendingRequests };
}

describe("reduceTabLifecycle", () => {
  // --- Cas repris tel quels (mêmes transitions, mêmes attentes sur .state) ---

  it("created -> idle", () => {
    expect(
      reduceTabLifecycle(lifecycle("idle"), { kind: "created" }).state,
    ).toBe("idle");
  });

  it("idle + prompt_submitted -> running", () => {
    expect(
      reduceTabLifecycle(lifecycle("idle"), { kind: "prompt_submitted" }).state,
    ).toBe("running");
  });

  it("running + done -> idle", () => {
    expect(
      reduceTabLifecycle(lifecycle("running", 1), {
        kind: "sidecar_message",
        message: doneMsg,
      }).state,
    ).toBe("idle");
  });

  it("running + error -> error", () => {
    expect(
      reduceTabLifecycle(lifecycle("running", 1), {
        kind: "sidecar_message",
        message: errorMsg,
      }).state,
    ).toBe("error");
  });

  it("running + message ni error ni done -> reste running", () => {
    expect(
      reduceTabLifecycle(lifecycle("running", 1), {
        kind: "sidecar_message",
        message: assistantMsg,
      }).state,
    ).toBe("running");
  });

  it("error + done -> reste error (sticky)", () => {
    expect(
      reduceTabLifecycle(lifecycle("error"), {
        kind: "sidecar_message",
        message: doneMsg,
      }).state,
    ).toBe("error");
  });

  it("error + prompt_submitted -> reste error (pas de respawn implicite)", () => {
    expect(
      reduceTabLifecycle(lifecycle("error"), { kind: "prompt_submitted" }).state,
    ).toBe("error");
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
      expect(reduceTabLifecycle(lifecycle("closed"), event).state).toBe("closed");
    }
  });

  it("closed atteignable depuis idle, running et error", () => {
    const states: TabLifecycle["state"][] = ["idle", "running", "error"];
    for (const state of states) {
      expect(reduceTabLifecycle(lifecycle(state), { kind: "closed" }).state).toBe(
        "closed",
      );
    }
  });

  // --- Nouveaux cas : compteur de tours + état waiting ---

  it("deux prompt_submitted puis un done -> running (pendingTurns 1)", () => {
    let lc = reduceTabLifecycle(INITIAL_TAB_LIFECYCLE, { kind: "prompt_submitted" });
    lc = reduceTabLifecycle(lc, { kind: "prompt_submitted" });
    lc = reduceTabLifecycle(lc, { kind: "sidecar_message", message: doneMsg });
    expect(lc).toEqual({ state: "running", pendingTurns: 1, pendingRequests: 0 });
  });

  it("puis un second done -> idle", () => {
    let lc = reduceTabLifecycle(INITIAL_TAB_LIFECYCLE, { kind: "prompt_submitted" });
    lc = reduceTabLifecycle(lc, { kind: "prompt_submitted" });
    lc = reduceTabLifecycle(lc, { kind: "sidecar_message", message: doneMsg });
    lc = reduceTabLifecycle(lc, { kind: "sidecar_message", message: doneMsg });
    expect(lc).toEqual({ state: "idle", pendingTurns: 0, pendingRequests: 0 });
  });

  it("running + permission_request -> waiting", () => {
    const lc = reduceTabLifecycle(lifecycle("running", 1), {
      kind: "sidecar_message",
      message: permissionMsg,
    });
    expect(lc.state).toBe("waiting");
  });

  it("waiting + mode_changed / session_info -> reste waiting (début de tour ou sélecteur de mode, pas une reprise)", () => {
    const afterMode = reduceTabLifecycle(lifecycle("waiting", 1), {
      kind: "sidecar_message",
      message: { type: "mode_changed", mode: "plan" },
    });
    expect(afterMode.state).toBe("waiting");
    const afterInfo = reduceTabLifecycle(lifecycle("waiting", 1), {
      kind: "sidecar_message",
      message: { type: "session_info", sessionId: "s", model: "m", apiKeySource: "none" },
    });
    expect(afterInfo.state).toBe("waiting");
  });

  it("waiting + commands -> reste waiting (liste poussée hors tour, pas une reprise)", () => {
    const lc = reduceTabLifecycle(lifecycle("waiting", 1), {
      kind: "sidecar_message",
      message: { type: "commands", commands: [{ name: "commit", description: "d" }] },
    });
    expect(lc.state).toBe("waiting");
  });

  it.each<SidecarToUIMessage>([
    { type: "mod_status", plugin: "p", text: "t" },
    { type: "mod_toast", plugin: "p", text: "t", timeoutMs: 4000 },
    { type: "mod_panes", panes: [], shownId: null, focusedId: null },
    { type: "mod_invalidate", instances: [] },
    { type: "mod_tree", requestId: "r", tree: null, hooked: false, rewritten: false },
    { type: "mod_result", requestId: "r", handled: true },
    { type: "mods_unavailable", reason: "absent" },
    { type: "mod_copy_request", requestId: "c1", text: "t" },
  ])("waiting sans requête en attente + $type -> reste waiting (poussé hors progression du tour)", (message) => {
    const lc = reduceTabLifecycle(lifecycle("waiting", 0), { kind: "sidecar_message", message });
    expect(lc.state).toBe("waiting");
  });

  it("waiting + assistant_delta -> running", () => {
    const lc = reduceTabLifecycle(lifecycle("waiting", 1), {
      kind: "sidecar_message",
      message: assistantMsg,
    });
    expect(lc.state).toBe("running");
  });

  it("running + conversation_reset -> idle, 0", () => {
    const lc = reduceTabLifecycle(lifecycle("running", 2), {
      kind: "sidecar_message",
      message: conversationResetMsg,
    });
    expect(lc).toEqual({ state: "idle", pendingTurns: 0, pendingRequests: 0 });
  });

  it("idle (0) + done -> reste idle, 0 (clamp)", () => {
    const lc = reduceTabLifecycle(lifecycle("idle", 0), {
      kind: "sidecar_message",
      message: doneMsg,
    });
    expect(lc).toEqual({ state: "idle", pendingTurns: 0, pendingRequests: 0 });
  });

  it("error non-recoverable -> pendingTurns 0", () => {
    const lc = reduceTabLifecycle(lifecycle("running", 3), {
      kind: "sidecar_message",
      message: errorMsg,
    });
    expect(lc).toEqual({ state: "error", pendingTurns: 0, pendingRequests: 0 });
  });

  it("closed terminal sur tous les événements y compris conversation_reset/permission_request", () => {
    const events: Array<Parameters<typeof reduceTabLifecycle>[1]> = [
      { kind: "sidecar_message", message: conversationResetMsg },
      { kind: "sidecar_message", message: permissionMsg },
    ];
    for (const event of events) {
      expect(reduceTabLifecycle(lifecycle("closed"), event).state).toBe("closed");
    }
  });

  describe("pendingRequests (DEN-05)", () => {
    const sidecar = (message: (typeof assistantMsg) | (typeof toolResultMsg) | (typeof permissionMsg) | (typeof doneMsg)) =>
      ({ kind: "sidecar_message" as const, message });

    function threePending(): TabLifecycle {
      let lc = lifecycle("running", 1);
      for (let i = 0; i < 3; i++) {
        lc = reduceTabLifecycle(lc, sidecar(permissionMsg));
        lc = reduceTabLifecycle(lc, sidecar(i % 2 ? assistantMsg : toolResultMsg));
      }
      return lc;
    }

    it("3 permission_request avec progression intercalée -> reste waiting (3)", () => {
      expect(threePending()).toEqual(lifecycle("waiting", 1, 3));
    });

    it("request_resolved un par un -> running seulement après le dernier", () => {
      let lc = threePending();
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      expect(lc).toEqual(lifecycle("waiting", 1, 2));
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      expect(lc).toEqual(lifecycle("waiting", 1, 1));
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      expect(lc).toEqual(lifecycle("running", 1, 0));
    });

    it("done remet pendingRequests à 0", () => {
      const lc = reduceTabLifecycle(threePending(), sidecar(doneMsg));
      expect(lc).toEqual(lifecycle("idle", 0, 0));
    });

    it("request_resolved en running est ignoré", () => {
      const lc = lifecycle("running", 1, 0);
      expect(reduceTabLifecycle(lc, { kind: "request_resolved" })).toEqual(lc);
    });

    it("3 demandes, une réponse partielle puis de la progression -> reste waiting (2), running après la dernière", () => {
      let lc = threePending();
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      lc = reduceTabLifecycle(lc, sidecar(toolResultMsg));
      lc = reduceTabLifecycle(lc, sidecar(assistantMsg));
      expect(lc).toEqual(lifecycle("waiting", 1, 2));
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      lc = reduceTabLifecycle(lc, sidecar(assistantMsg));
      expect(lc).toEqual(lifecycle("waiting", 1, 1));
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      expect(lc).toEqual(lifecycle("running", 1, 0));
    });

    it("prompt de suivi pendant waiting : request_resolved décrémente en running, pas de blocage ensuite", () => {
      let lc = reduceTabLifecycle(lifecycle("running", 1), sidecar(permissionMsg));
      expect(lc).toEqual(lifecycle("waiting", 1, 1));
      lc = reduceTabLifecycle(lc, { kind: "prompt_submitted" });
      expect(lc).toEqual(lifecycle("running", 2, 1));
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      expect(lc).toEqual(lifecycle("running", 2, 0));
      lc = reduceTabLifecycle(lc, sidecar(permissionMsg));
      expect(lc).toEqual(lifecycle("waiting", 2, 1));
      lc = reduceTabLifecycle(lc, { kind: "request_resolved" });
      expect(lc).toEqual(lifecycle("running", 2, 0));
    });

    it("error et conversation_reset avec compteur > 0 remettent pendingRequests à 0", () => {
      const withPending = lifecycle("waiting", 1, 2);
      expect(
        reduceTabLifecycle(withPending, { kind: "sidecar_message", message: errorMsg })
          .pendingRequests,
      ).toBe(0);
      expect(
        reduceTabLifecycle(withPending, { kind: "sidecar_message", message: conversationResetMsg })
          .pendingRequests,
      ).toBe(0);
    });

    it("request_resolved reste inerte en closed", () => {
      const lc = lifecycle("closed", 0, 2);
      expect(reduceTabLifecycle(lc, { kind: "request_resolved" })).toEqual(lc);
    });
  });
});
