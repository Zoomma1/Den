import { describe, expect, it } from "vitest";
import { groupKey, nextActiveIndex, shellLabel } from "./group";
import type { Owner } from "../tabs/owner";

describe("groupKey", () => {
  it("utilise ownerKey pour un owner project", () => {
    const owner: Owner = { kind: "project", id: "proj-1" };
    expect(groupKey(owner)).toBe("project:proj-1");
  });
});

describe("shellLabel", () => {
  it("index 0-based -> libellé 1-based", () => {
    expect(shellLabel(0)).toBe("shell 1");
    expect(shellLabel(1)).toBe("shell 2");
    expect(shellLabel(4)).toBe("shell 5");
  });
});

describe("nextActiveIndex", () => {
  it("retire le seul onglet -> groupe vide, null", () => {
    expect(nextActiveIndex(1, 0)).toBeNull();
  });

  it("retire un onglet au milieu -> le même index (le suivant a glissé dessus)", () => {
    expect(nextActiveIndex(3, 1)).toBe(1);
  });

  it("retire le premier onglet -> reste à l'index 0 (le suivant a glissé)", () => {
    expect(nextActiveIndex(3, 0)).toBe(0);
  });

  it("retire le dernier onglet -> le nouveau dernier (index décalé)", () => {
    expect(nextActiveIndex(3, 2)).toBe(1);
  });

  it("retire l'un des deux derniers onglets -> le seul restant, index 0", () => {
    expect(nextActiveIndex(2, 1)).toBe(0);
    expect(nextActiveIndex(2, 0)).toBe(0);
  });
});
