import { describe, it, expect } from "vitest";
import { STATUSES, STATUS_META } from "./status";

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
