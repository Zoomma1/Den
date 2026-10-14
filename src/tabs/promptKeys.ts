export type PromptKeyAction = "send" | "newline" | null;

export interface PromptKeyEvent {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Entrée envoie, Cmd/Ctrl+Entrée insère un saut de ligne ; Shift+Entrée reste natif (null). */
export function promptKeyAction(ev: PromptKeyEvent): PromptKeyAction {
  if (ev.key !== "Enter") return null;
  // keyCode 229 : Entrée de validation IME que certains navigateurs ne marquent pas isComposing.
  if (ev.isComposing || ev.keyCode === 229) return null;
  if (ev.shiftKey || ev.altKey) return null;
  if (ev.metaKey || ev.ctrlKey) return "newline";
  return "send";
}
