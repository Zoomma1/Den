export interface JumpKeyEvent {
  /** `KeyboardEvent.code` : indépendant de la disposition (AZERTY produit `&` pour `1`). */
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface JumpTarget {
  kind: "tab" | "project";
  /** 0-based. */
  index: number;
}

/** Mac : Cmd+N = projet, Ctrl+N = tab. Ailleurs : Ctrl+N = tab, pas de raccourci projet. */
export function resolveJump(ev: JumpKeyEvent, isMac: boolean): JumpTarget | null {
  if (ev.shiftKey || ev.altKey) return null;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(ev.code);
  if (!m) return null;
  const index = Number(m[1]) - 1;
  if (isMac) {
    if (ev.metaKey && !ev.ctrlKey) return { kind: "project", index };
    if (ev.ctrlKey && !ev.metaKey) return { kind: "tab", index };
    return null;
  }
  if (ev.ctrlKey && !ev.metaKey) return { kind: "tab", index };
  return null;
}
