import { describe, expect, it } from "vitest";
import { commandOutputOf, durationMsOf, toolResultsOf } from "./sdkMessages";

const user = (blocks: any[], tool_use_result?: unknown) => ({
  message: { content: blocks },
  tool_use_result,
});
const tr = (id: string) => ({ type: "tool_result", tool_use_id: id, content: `out-${id}` });

describe("toolResultsOf", () => {
  it("un bloc : tool_use_result attaché", () => {
    expect(toolResultsOf(user([tr("a")], { x: 1 }))).toEqual([
      { toolUseId: "a", output: "out-a", structured: { x: 1 }, isError: undefined },
    ]);
  });
  it("un bloc sans tool_use_result : pas de structured", () => {
    expect(toolResultsOf(user([tr("a")]))[0]).not.toHaveProperty("structured");
  });
  it("N blocs + tableau de même longueur : par index", () => {
    const r = toolResultsOf(user([tr("a"), tr("b")], [{ n: 1 }, { n: 2 }]));
    expect(r.map((x) => x.structured)).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("N blocs sans tableau (ou longueur différente) : repli sur la sortie brute", () => {
    for (const t of [{ n: 1 }, [{ n: 1 }]]) {
      const r = toolResultsOf(user([tr("a"), tr("b")], t));
      expect(r).toHaveLength(2);
      expect(r[0]).not.toHaveProperty("structured");
      expect(r[1].output).toBe("out-b");
    }
  });
  it("contenu texte ou blocs non tool_result ignorés", () => {
    expect(toolResultsOf({ message: { content: "hi" } })).toEqual([]);
    expect(toolResultsOf(user([{ type: "text", text: "x" }]))).toEqual([]);
  });
});

describe("commandOutputOf", () => {
  const base = (extra: any) => ({
    type: "assistant",
    message: { model: "<synthetic>", content: [{ type: "text", text: "contenu" }] },
    ...extra,
  });
  it("retire l'enveloppe de local_command_source", () => {
    const m = base({
      local_command_source: "<local-command-stdout>sortie\nligne 2</local-command-stdout>",
      local_command_run: { command: "prismantis", args: "demo" },
    });
    expect(commandOutputOf(m)).toEqual({ command: "prismantis", args: "demo", text: "sortie\nligne 2" });
  });
  it("sans enveloppe : texte brut ; sans source : contenu du message", () => {
    const run = { command: "usage", args: "" };
    expect(commandOutputOf(base({ local_command_source: "brut", local_command_run: run }))?.text).toBe("brut");
    expect(commandOutputOf(base({ local_command_run: run }))?.text).toBe("contenu");
  });
  it("message non-commande -> null", () => {
    expect(commandOutputOf(base({}))).toBeNull();
    expect(commandOutputOf({ type: "user" })).toBeNull();
    expect(commandOutputOf({ type: "result" })).toBeNull();
  });
});

describe("durationMsOf", () => {
  it("renvoie la durée d'un tour qui a travaillé", () => {
    expect(durationMsOf({ duration_ms: 6340, num_turns: 2 })).toBe(6340);
  });

  it("pas de durée pour un result à 0 tour (commande slash)", () => {
    expect(durationMsOf({ duration_ms: 3, num_turns: 0 })).toBeUndefined();
  });

  it("pas de durée si duration_ms est absent", () => {
    expect(durationMsOf({ num_turns: 1 })).toBeUndefined();
  });
});
