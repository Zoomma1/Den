/**
 * Logique pure du module `theme` — parsing/validation du JSON de thème et
 * mapping tokens -> variables CSS `--den-*`. Séparé de `index.ts` (qui fait
 * l'IPC + le DOM) pour rester testable sans DOM ni Tauri.
 *
 * Format attendu (cf. den-theme.json à la racine du repo) :
 * ```json
 * { "name": "...", "tokens": { "bg": "#1e1e1e", ... } }
 * ```
 * Chaque clé de `tokens` devient la variable CSS `--den-<clé>` sur
 * `document.documentElement` (cf. src/styles.css pour la liste des tokens
 * consommés par le reste de l'app).
 */

export interface ThemeFile {
  name?: string;
  tokens: Record<string, string>;
}

/**
 * Parse et valide le JSON brut d'un fichier de thème. Retourne `null` (jamais
 * ne lève) si le JSON est invalide ou ne respecte pas la forme attendue —
 * l'appelant doit alors conserver le thème courant.
 */
export function parseThemeJSON(raw: string): ThemeFile | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidThemeFile(data) ? data : null;
}

function isValidThemeFile(data: unknown): data is ThemeFile {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const tokens = (data as Record<string, unknown>).tokens;
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
    return false;
  }
  return Object.values(tokens as Record<string, unknown>).every(
    (value) => typeof value === "string",
  );
}

/** Mappe les tokens `{ bg: "#..." }` en variables CSS `{ "--den-bg": "#..." }`. */
export function tokensToCssVars(
  tokens: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    vars[`--den-${key}`] = value;
  }
  return vars;
}

/**
 * Sous-ensemble de `CSSStyleDeclaration` utilisé — permet de tester
 * `applyThemeVars` avec un simple mock plutôt qu'un vrai DOM.
 */
export interface CssPropertyTarget {
  setProperty(name: string, value: string): void;
}

/** Applique chaque variable CSS sur la cible (ex. `document.documentElement.style`). */
export function applyThemeVars(
  target: CssPropertyTarget,
  vars: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(vars)) {
    target.setProperty(name, value);
  }
}
