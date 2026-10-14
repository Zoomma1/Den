import { describe, expect, it } from "vitest";
import { mergeCommands } from "./commands";

describe("mergeCommands", () => {
  it("dédoublonne sans tenir compte du / initial ni de la casse", () => {
    const out = mergeCommands([{ name: "review", description: "d" }], ["/Review", "compact", "/compact"], []);
    expect(out.map((c) => c.name)).toEqual(["review", "compact"]);
  });

  it("retire les commandes terminal-only, quelle que soit leur forme", () => {
    const out = mergeCommands(
      [{ name: "plugin", description: "x" }],
      ["/plugin", "help", "model"],
      ["plugin", "/HELP"],
    );
    expect(out.map((c) => c.name)).toEqual(["model"]);
  });

  it("préserve la description du SDK et laisse vide celle des built-ins", () => {
    const out = mergeCommands([{ name: "skill-a", description: "Fait A" }], ["skill-a", "compact"], []);
    expect(out).toEqual([
      { name: "skill-a", description: "Fait A" },
      { name: "compact", description: "" },
    ]);
  });

  it("place les skills d'abord puis les built-ins triés", () => {
    const out = mergeCommands([{ name: "zeta", description: "" }], ["model", "compact"], []);
    expect(out.map((c) => c.name)).toEqual(["zeta", "compact", "model"]);
  });

  it("gère les listes vides et les noms vides", () => {
    expect(mergeCommands([], [], [])).toEqual([]);
    expect(mergeCommands([], ["/", ""], [])).toEqual([]);
  });
});
