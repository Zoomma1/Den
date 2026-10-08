import { describe, it, expect } from "vitest";
import { STATUSES, STATUS_META, rollupStatus, sessionStatus } from "./status";

describe("STATUS_META", () => {
  it("couvre les 4 statuts avec les libellés du contrat", () => {
    expect(STATUSES).toEqual(["running", "needs_input", "done", "error"]);
    expect(Object.keys(STATUS_META).sort()).toEqual([...STATUSES].sort());
    expect(STATUSES.map((s) => STATUS_META[s].label)).toEqual([
      "Running",
      "Needs input",
      "Done",
      "Error",
    ]);
  });

  it("utilise des tokens --den-status-* uniques", () => {
    const tokens = STATUSES.map((s) => STATUS_META[s].token);
    expect(new Set(tokens).size).toBe(4);
    for (const t of tokens) expect(t.startsWith("--den-status-")).toBe(true);
  });
});

describe("sessionStatus", () => {
  const none = { unseenDone: false, failed: false };

  it("error et failed donnent error, quelle que soit la suite", () => {
    expect(sessionStatus("error", none)).toBe("error");
    expect(sessionStatus("idle", { unseenDone: true, failed: true })).toBe("error");
    expect(sessionStatus("running", { unseenDone: false, failed: true })).toBe("error");
  });

  it("waiting -> needs_input, running -> running", () => {
    expect(sessionStatus("waiting", none)).toBe("needs_input");
    expect(sessionStatus("running", none)).toBe("running");
  });

  it("idle n'est done que si le tour fini n'a pas été vu", () => {
    expect(sessionStatus("idle", { unseenDone: true, failed: false })).toBe("done");
    expect(sessionStatus("idle", none)).toBeNull();
    expect(sessionStatus("closed", none)).toBeNull();
  });
});

describe("rollupStatus", () => {
  it("respecte needs_input > error > done > running > null", () => {
    expect(rollupStatus(["running", "done", "error", "needs_input"])).toBe("needs_input");
    expect(rollupStatus(["running", "done", "error"])).toBe("error");
    expect(rollupStatus(["running", null, "done"])).toBe("done");
    expect(rollupStatus([null, "running"])).toBe("running");
  });

  it("rend null sans statut", () => {
    expect(rollupStatus([])).toBeNull();
    expect(rollupStatus([null, null])).toBeNull();
  });
});
