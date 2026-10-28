import { describe, expect, it } from "vitest";
import { describeToolInput } from "./toolInput";

describe("describeToolInput", () => {
  it("Bash : commande en principal, description en libellé", () => {
    const v = describeToolInput("Bash", { command: "ls -la", description: "Lister" });
    expect(v).toEqual({
      kind: "fields",
      main: "ls -la",
      extras: [{ label: "description", value: "Lister" }],
      summary: "ls -la",
    });
  });

  it("tronque le résumé d'une longue commande sur une ligne", () => {
    const v = describeToolInput("Bash", { command: `echo ${"a".repeat(200)}\nsecond` });
    expect(v.summary.length).toBeLessThanOrEqual(80);
    expect(v.summary).not.toContain("\n");
    expect(v.summary.endsWith("…")).toBe(true);
  });

  it.each(["Read", "Edit", "Write"])("%s : file_path", (name) => {
    const v = describeToolInput(name, { file_path: "/tmp/x.ts", old_string: "a" });
    expect(v).toMatchObject({ kind: "fields", main: "/tmp/x.ts", summary: "/tmp/x.ts" });
  });

  it("Edit : garde old_string et new_string en champs secondaires (on voit ce qui change)", () => {
    const v = describeToolInput("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" });
    expect(v).toMatchObject({
      main: "/a.ts",
      extras: [
        { label: "old_string", value: "x" },
        { label: "new_string", value: "y" },
      ],
    });
  });

  it("Bash : garde les autres options (timeout) en champs secondaires", () => {
    const v = describeToolInput("Bash", { command: "ls", timeout: 5000 });
    expect(v).toMatchObject({ extras: [{ label: "timeout", value: "5000" }] });
  });

  it("résumé : un retour à la ligne en tête ne donne pas un résumé vide", () => {
    expect(describeToolInput("Bash", { command: "\nls -la" }).summary).toBe("ls -la");
  });

  it("NotebookEdit : notebook_path", () => {
    expect(describeToolInput("NotebookEdit", { notebook_path: "/n.ipynb" })).toMatchObject({ main: "/n.ipynb" });
  });

  it("Grep / Glob : pattern + path", () => {
    expect(describeToolInput("Grep", { pattern: "foo", path: "src" })).toMatchObject({
      main: "foo",
      extras: [{ label: "path", value: "src" }],
    });
    expect(describeToolInput("Glob", { pattern: "**/*.ts" })).toMatchObject({ main: "**/*.ts", extras: [] });
  });

  it("WebFetch : url", () => {
    expect(describeToolInput("WebFetch", { url: "https://a.b" })).toMatchObject({ main: "https://a.b" });
  });

  it("ExitPlanMode : plan markdown", () => {
    const v = describeToolInput("ExitPlanMode", { plan: "# Titre\n- a" });
    expect(v).toMatchObject({ kind: "plan", markdown: "# Titre\n- a" });
  });

  it("outil inconnu ou champ manquant : repli JSON", () => {
    expect(describeToolInput("Mystère", { a: 1 })).toMatchObject({
      kind: "raw",
      json: JSON.stringify({ a: 1 }, null, 2),
    });
    expect(describeToolInput("Bash", {}).kind).toBe("raw");
    expect(describeToolInput("Read", null).kind).toBe("raw");
  });
});
