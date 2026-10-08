import { describe, expect, it } from "vitest";
import {
  applySelection,
  filterCommands,
  findSlashToken,
  highlightSegments,
  type SlashCommandInfo,
} from "./slash";

const cmds: SlashCommandInfo[] = [
  { name: "review", description: "Revue" },
  { name: "commit", description: "Commit" },
  { name: "preview", description: "Aperçu" },
  { name: "Refactor", description: "Refacto" },
  { name: "commit", description: "Doublon" },
];

describe("findSlashToken", () => {
  it("détecte un « / » en début de texte", () => {
    expect(findSlashToken("/re", 3)).toEqual({ start: 0, end: 3, query: "re" });
  });
  it("détecte un « / » après un espace", () => {
    expect(findSlashToken("hello /co", 9)).toEqual({ start: 6, end: 9, query: "co" });
  });
  it("détecte un « / » après un saut de ligne", () => {
    expect(findSlashToken("a\n/x", 4)).toEqual({ start: 2, end: 4, query: "x" });
  });
  it("query vide juste après le « / »", () => {
    expect(findSlashToken("/", 1)).toEqual({ start: 0, end: 1, query: "" });
  });
  it("ignore « src/foo »", () => {
    expect(findSlashToken("src/foo", 7)).toBeNull();
  });
  it("ignore les URL", () => {
    expect(findSlashToken("http://x", 8)).toBeNull();
  });
  it("caret au milieu d'un mot : end va jusqu'au prochain whitespace", () => {
    expect(findSlashToken("/review now", 3)).toEqual({ start: 0, end: 7, query: "re" });
  });
  it("whitespace entre le « / » et le caret", () => {
    expect(findSlashToken("/re view", 8)).toBeNull();
  });
  it("texte vide", () => {
    expect(findSlashToken("", 0)).toBeNull();
  });
  it("caret hors bornes", () => {
    expect(findSlashToken("/a", 5)).toBeNull();
  });
});

describe("filterCommands", () => {
  it("query vide renvoie tout, dédoublonné", () => {
    expect(filterCommands(cmds, "").map((c) => c.name)).toEqual([
      "review",
      "commit",
      "preview",
      "Refactor",
    ]);
  });
  it("garde la première occurrence d'un doublon", () => {
    const r = filterCommands(cmds, "commit");
    expect(r).toHaveLength(1);
    expect(r[0].description).toBe("Commit");
  });
  it("préfixes avant sous-chaînes", () => {
    expect(filterCommands(cmds, "re").map((c) => c.name)).toEqual([
      "review",
      "Refactor",
      "preview",
    ]);
  });
  it("insensible à la casse", () => {
    expect(filterCommands(cmds, "REF").map((c) => c.name)).toEqual(["Refactor"]);
  });
  it("filtre sur le nom uniquement", () => {
    expect(filterCommands(cmds, "doublon")).toEqual([]);
  });
});

describe("applySelection", () => {
  it("remplace le token par « /name » + espace", () => {
    const t = findSlashToken("/re", 3)!;
    expect(applySelection("/re", t, "review")).toEqual({ text: "/review ", caret: 8 });
  });
  it("remplace le mot entier sous le caret", () => {
    const text = "go /re|xx suite";
    const t = findSlashToken(text, 6)!;
    expect(applySelection(text, t, "review")).toEqual({
      text: "go /review suite",
      caret: 11,
    });
  });
  it("fin de texte : ajoute un espace", () => {
    const t = findSlashToken("go /re", 6)!;
    expect(applySelection("go /re", t, "review")).toEqual({ text: "go /review ", caret: 11 });
  });
  it("suivi d'un espace : pas de doublon, caret après l'espace", () => {
    const t = findSlashToken("/re x", 3)!;
    expect(applySelection("/re x", t, "review")).toEqual({ text: "/review x", caret: 8 });
  });
  it("suivi d'un saut de ligne : pas d'espace ajouté, caret en fin de « /nom »", () => {
    const t = findSlashToken("/re\nx", 3)!;
    expect(applySelection("/re\nx", t, "review")).toEqual({ text: "/review\nx", caret: 7 });
  });
});

describe("highlightSegments", () => {
  const known = new Set(["review", "commit"]);
  it("surligne un skill connu", () => {
    expect(highlightSegments("/review ok", known)).toEqual([
      { text: "/review", highlighted: true },
      { text: " ok", highlighted: false },
    ]);
  });
  it("ne surligne pas un nom inconnu", () => {
    expect(highlightSegments("/nope", known)).toEqual([
      { text: "/nope", highlighted: false },
    ]);
  });
  it("ne surligne pas un token collé à un autre texte", () => {
    expect(highlightSegments("src/review", known).every((s) => !s.highlighted)).toBe(true);
    expect(highlightSegments("/review,", known).every((s) => !s.highlighted)).toBe(true);
  });
  it("surligne après un saut de ligne", () => {
    expect(highlightSegments("a\n/commit", known).some((s) => s.highlighted)).toBe(true);
  });
  it("la concaténation redonne le texte", () => {
    for (const t of ["", " /review  x\n/commit\t/zz  ", "plain", "/", "//review"]) {
      expect(highlightSegments(t, known).map((s) => s.text).join("")).toBe(t);
    }
  });
});
