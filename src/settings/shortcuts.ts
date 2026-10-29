export interface Shortcut {
  id: string;
  label: string;
  /** Jetons séparés par "+" ; "Mod" = ⌘ sur Mac, Ctrl ailleurs. */
  combo: string;
  macOnly?: boolean;
}

// Inventaire vérifié dans layout/index.ts (B/J/L), sessionsPanel.ts (Shift+S), tabs/jump.ts, tabs/promptKeys.ts.
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "sidebar", label: "Toggle sidebar", combo: "Mod+B" },
  { id: "terminal", label: "Toggle terminal", combo: "Mod+J" },
  { id: "mods", label: "Toggle mods pane", combo: "Mod+L" },
  { id: "sessions", label: "Sessions panel", combo: "Mod+Shift+S" },
  { id: "project-n", label: "Go to project N", combo: "Mod+1-9", macOnly: true },
  { id: "tab-n", label: "Go to tab N", combo: "Ctrl+1-9" },
  { id: "send", label: "Send message", combo: "Enter" },
  { id: "newline", label: "New line", combo: "Mod+Enter" },
  { id: "settings", label: "Settings", combo: "Mod+," },
];

// Affichage seulement : les modules de raccourcis gardent leur propre détection.
export function detectMac(): boolean {
  return /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);
}

export function renderCombo(combo: string, isMac: boolean): string {
  const parts = combo.split("+").map((p) => {
    if (p === "Mod") return isMac ? "⌘" : "Ctrl";
    if (p === "Shift") return isMac ? "⇧" : "Shift";
    return p;
  });
  return isMac ? parts.join("") : parts.join("+");
}

export function visibleShortcuts(isMac: boolean): Shortcut[] {
  return SHORTCUTS.filter((s) => !s.macOnly || isMac);
}
