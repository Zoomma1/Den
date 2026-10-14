import { describe, it, expect } from "vitest";
import { promptKeyAction, type PromptKeyEvent } from "./promptKeys";

function ev(over: Partial<PromptKeyEvent> = {}): PromptKeyEvent {
  return { key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe("promptKeyAction", () => {
  it("Entrée seule envoie", () => expect(promptKeyAction(ev())).toBe("send"));
  it("Cmd+Entrée -> saut de ligne", () => expect(promptKeyAction(ev({ metaKey: true }))).toBe("newline"));
  it("Ctrl+Entrée -> saut de ligne", () => expect(promptKeyAction(ev({ ctrlKey: true }))).toBe("newline"));
  it("Shift+Entrée reste natif", () => expect(promptKeyAction(ev({ shiftKey: true }))).toBeNull());
  it("Cmd+Shift+Entrée reste natif", () =>
    expect(promptKeyAction(ev({ shiftKey: true, metaKey: true }))).toBeNull());
  it("Alt+Entrée reste natif", () => expect(promptKeyAction(ev({ altKey: true }))).toBeNull());
  it("IME isComposing -> rien", () => expect(promptKeyAction(ev({ isComposing: true }))).toBeNull());
  it("keyCode 229 -> rien", () => expect(promptKeyAction(ev({ keyCode: 229 }))).toBeNull());
  it("autre touche -> rien", () => expect(promptKeyAction(ev({ key: "a" }))).toBeNull());
});
