import { describe, expect, it } from "vitest";
import { isReadOnlyTool, summarizeToolRun, type ToolGroupCall } from "./toolGroup";

const calls = (...tools: string[]): ToolGroupCall[] => tools.map((tool) => ({ tool, input: {} }));

describe("isReadOnlyTool", () => {
  it.each(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"])("%s est en lecture seule", (n) => {
    expect(isReadOnlyTool(n)).toBe(true);
  });

  it.each(["Edit", "Write", "Bash", "NotebookEdit", "Task", "TaskCreate", "Inconnu", "", "read"])("%s ne l'est pas", (n) => {
    expect(isReadOnlyTool(n)).toBe(false);
  });

  it("MCP : vrai seulement si le verbe est évident", () => {
    expect(isReadOnlyTool("mcp__vault__get_note")).toBe(true);
    expect(isReadOnlyTool("mcp__vault__list_files")).toBe(true);
    expect(isReadOnlyTool("mcp__vault__search")).toBe(true);
    expect(isReadOnlyTool("mcp__vault__delete_note")).toBe(false);
    expect(isReadOnlyTool("mcp__vault__update_page")).toBe(false);
    expect(isReadOnlyTool("mcp__vault__getaway")).toBe(false);
    expect(isReadOnlyTool("mcp__notion__notion-fetch")).toBe(true);
    expect(isReadOnlyTool("mcp__notion__notion-get-users")).toBe(true);
  });

  it("MCP : un mot de mutation dans le nom refuse le repli", () => {
    expect(isReadOnlyTool("mcp__app__get_or_create_user")).toBe(false);
    expect(isReadOnlyTool("mcp__db__query_and_delete")).toBe(false);
    expect(isReadOnlyTool("mcp__notion__notion-update-page")).toBe(false);
  });
});

describe("summarizeToolRun", () => {
  it("un outil MCP est nommé sans son préfixe interne", () => {
    expect(summarizeToolRun(calls("mcp__vault__get_note", "mcp__vault__get_note"))).toBe("Ran 2 get_note calls");
  });

  it("liste vide -> chaîne vide", () => {
    expect(summarizeToolRun([])).toBe("");
  });

  it("singulier et pluriel", () => {
    expect(summarizeToolRun(calls("Read"))).toBe("Read 1 file");
    expect(summarizeToolRun(calls("Read", "Read", "Read"))).toBe("Read 3 files");
    expect(summarizeToolRun(calls("Grep"))).toBe("Searched 1 pattern");
    expect(summarizeToolRun(calls("Grep", "Glob"))).toBe("Searched 2 patterns");
    expect(summarizeToolRun(calls("LS"))).toBe("Listed 1 directory");
    expect(summarizeToolRun(calls("LS", "LS"))).toBe("Listed 2 directories");
    expect(summarizeToolRun(calls("WebFetch"))).toBe("Ran 1 WebFetch call");
    expect(summarizeToolRun(calls("WebFetch", "WebFetch"))).toBe("Ran 2 WebFetch calls");
  });

  it("exemple du moteur", () => {
    expect(summarizeToolRun(calls("Read", "Grep", "Read", "Read"))).toBe("Read 3 files, searched 1 pattern");
  });

  it("ordre d'apparition, majuscule en tête seulement", () => {
    expect(summarizeToolRun(calls("Grep", "Read", "LS", "Read"))).toBe(
      "Searched 1 pattern, Read 2 files, listed 1 directory",
    );
    expect(summarizeToolRun(calls("LS", "Grep"))).toBe("Listed 1 directory, searched 1 pattern");
  });

  it("autres outils : une entrée par outil", () => {
    expect(summarizeToolRun(calls("Read", "WebSearch", "NotebookRead", "WebSearch"))).toBe(
      "Read 1 file, ran 2 WebSearch calls, ran 1 NotebookRead call",
    );
    expect(summarizeToolRun(calls("Foo"))).toBe("Ran 1 Foo call");
  });
});
