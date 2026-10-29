import { describe, it, expect } from "vitest";
import { SHORTCUTS, renderCombo, visibleShortcuts } from "./shortcuts";

describe("renderCombo", () => {
  it("Mac : symboles collés", () => {
    expect(renderCombo("Mod+B", true)).toBe("⌘B");
    expect(renderCombo("Mod+Shift+S", true)).toBe("⌘⇧S");
    expect(renderCombo("Mod+,", true)).toBe("⌘,");
  });

  it("hors Mac : Ctrl+...", () => {
    expect(renderCombo("Mod+B", false)).toBe("Ctrl+B");
    expect(renderCombo("Mod+Shift+S", false)).toBe("Ctrl+Shift+S");
    expect(renderCombo("Ctrl+1-9", false)).toBe("Ctrl+1-9");
  });
});

describe("visibleShortcuts", () => {
  it("⌘1-9 (projet) seulement sur Mac", () => {
    expect(visibleShortcuts(true).some((s) => s.id === "project-n")).toBe(true);
    expect(visibleShortcuts(false).some((s) => s.id === "project-n")).toBe(false);
  });

  it("l'inventaire contient les 9 raccourcis", () => {
    expect(SHORTCUTS).toHaveLength(9);
  });
});
