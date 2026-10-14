import { describe, it, expect } from "vitest";
import { resolveJump, type JumpKeyEvent } from "./jump";

function ev(over: Partial<JumpKeyEvent>): JumpKeyEvent {
  return { code: "Digit1", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe("resolveJump", () => {
  it("Mac : Cmd+3 -> projet index 2", () =>
    expect(resolveJump(ev({ code: "Digit3", metaKey: true }), true)).toEqual({ kind: "project", index: 2 }));
  it("Mac : Ctrl+9 -> tab index 8", () =>
    expect(resolveJump(ev({ code: "Digit9", ctrlKey: true }), true)).toEqual({ kind: "tab", index: 8 }));
  it("Mac : Cmd+Ctrl -> null", () =>
    expect(resolveJump(ev({ metaKey: true, ctrlKey: true }), true)).toBeNull());
  it("non-Mac : Ctrl+2 -> tab", () =>
    expect(resolveJump(ev({ code: "Digit2", ctrlKey: true }), false)).toEqual({ kind: "tab", index: 1 }));
  it("non-Mac : Meta+1 -> null, pas de raccourci projet", () =>
    expect(resolveJump(ev({ metaKey: true }), false)).toBeNull());
  it("AZERTY : le code physique Digit1 suffit, quel que soit le caractère produit", () =>
    expect(resolveJump({ ...ev({ metaKey: true }), code: "Digit1" }, true)).toEqual({ kind: "project", index: 0 }));
  it("shift ou alt -> null", () => {
    expect(resolveJump(ev({ metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(resolveJump(ev({ metaKey: true, altKey: true }), true)).toBeNull();
  });
  it("0, lettre, sans modifier -> null", () => {
    expect(resolveJump(ev({ code: "Digit0", metaKey: true }), true)).toBeNull();
    expect(resolveJump(ev({ code: "KeyA", metaKey: true }), true)).toBeNull();
    expect(resolveJump(ev({}), true)).toBeNull();
  });
});
