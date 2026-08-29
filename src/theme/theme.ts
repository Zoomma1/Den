/**
 * Logique pure du module `theme` — parsing/validation du CSS de thème et
 * application des variables `--den-*`. Séparé de `index.ts` (qui fait l'IPC
 * + le DOM) pour rester testable sans DOM ni Tauri.
 *
 * Format attendu (cf. `themes/default.css` à la racine du repo, thème
 * désigné par `.config`) : un unique bloc `:root { ... }` ne contenant que
 * des déclarations de custom properties `--den-*` (valeurs terminées par
 * `;`). Le fichier est tokens-only — pas d'autre sélecteur, pas de
 * propriété hors `--den-*`, pas de second bloc. Les commentaires CSS
 * `/* *\/` sont tolérés n'importe où (avant, après, dans le bloc). Le CSS
 * porte directement les noms finaux des variables : le retour de
 * `parseThemeCSS` est déjà la map `{ "--den-bg": "#1e1e1e", ... }`,
 * consommée telle quelle par `applyThemeVars`.
 */

/** Retire les commentaires CSS `/* ... *\/` (non gourmand, multi-lignes). */
function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Parse une déclaration `--den-xxx: valeur` (sans le `;` final, déjà
 * retiré par le split). Retourne `null` si la forme ne respecte pas le
 * contrat tokens-only (nom hors `--den-*`, valeur vide, pas de `:`).
 */
function parseDeclaration(part: string): [string, string] | null {
  const trimmed = part.trim();
  if (trimmed === "") {
    return null;
  }
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return null;
  }
  const name = trimmed.slice(0, colonIndex).trim();
  const value = trimmed.slice(colonIndex + 1).trim();
  if (!/^--den-[A-Za-z0-9-]+$/.test(name) || value === "") {
    return null;
  }
  return [name, value];
}

/** Parse le corps (contenu entre accolades) d'un bloc `:root`. */
function parseRootBody(body: string): Record<string, string> | null {
  const trimmed = body.trim();
  if (trimmed === "") {
    return {};
  }
  // Contrat : chaque déclaration se termine par `;` — y compris la dernière.
  if (!trimmed.endsWith(";")) {
    return null;
  }
  const declarations = trimmed.slice(0, -1).split(";");
  const vars: Record<string, string> = {};
  for (const declaration of declarations) {
    const parsed = parseDeclaration(declaration);
    if (!parsed) {
      return null;
    }
    const [name, value] = parsed;
    vars[name] = value;
  }
  return vars;
}

/**
 * Parse et valide le CSS brut d'un fichier de thème. Retourne `null`
 * (jamais ne lève) si le CSS ne respecte pas le contrat tokens-only décrit
 * en tête de fichier — l'appelant doit alors conserver le thème courant.
 * Le retour est directement la map `--den-*` -> valeur, prête pour
 * `applyThemeVars`.
 */
export function parseThemeCSS(raw: string): Record<string, string> | null {
  const withoutComments = stripComments(raw).trim();
  const match = /^:root\s*\{([\s\S]*)\}$/.exec(withoutComments);
  if (!match) {
    return null;
  }
  return parseRootBody(match[1]);
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
