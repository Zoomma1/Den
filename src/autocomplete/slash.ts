// Logique pure de l'autocomplete « / » (sans DOM, testable sous vitest node).

export type SlashCommandInfo = { name: string; description: string };
export type SlashToken = { start: number; end: number; query: string };

const WS = /\s/;

export function findSlashToken(text: string, caret: number): SlashToken | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0 && text[i] !== "/") {
    if (WS.test(text[i])) return null;
    i--;
  }
  if (i < 0) return null;
  // « src/foo » et les URL ne sont pas des commandes : le « / » doit ouvrir un mot.
  if (i > 0 && !WS.test(text[i - 1])) return null;
  let end = caret;
  while (end < text.length && !WS.test(text[end])) end++;
  return { start: i, end, query: text.slice(i + 1, caret) };
}

export function filterCommands(
  commands: SlashCommandInfo[],
  query: string,
): SlashCommandInfo[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const prefix: SlashCommandInfo[] = [];
  const inner: SlashCommandInfo[] = [];
  for (const c of commands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(c);
    else if (n.includes(q)) inner.push(c);
  }
  return [...prefix, ...inner];
}

export function applySelection(
  text: string,
  token: SlashToken,
  name: string,
): { text: string; caret: number } {
  const insert = `/${name}`;
  const next = text[token.end];
  // Un espace ou saut de ligne déjà présent sert de séparateur : pas de doublon.
  const sep = next === " " || next === "\n" ? "" : " ";
  // Devant un saut de ligne, le caret reste en fin de « /nom » au lieu de sauter à la ligne suivante.
  const caret = token.start + insert.length + (next === "\n" ? 0 : 1);
  return {
    text: text.slice(0, token.start) + insert + sep + text.slice(token.end),
    caret,
  };
}

export function highlightSegments(
  text: string,
  knownNames: ReadonlySet<string>,
): { text: string; highlighted: boolean }[] {
  const out: { text: string; highlighted: boolean }[] = [];
  // Le split avec groupe capturant conserve les séparateurs : la concaténation reste exacte.
  for (const piece of text.split(/(\s+)/)) {
    if (piece === "") continue;
    const highlighted =
      piece.length > 1 && piece[0] === "/" && knownNames.has(piece.slice(1));
    const last = out[out.length - 1];
    if (last && !last.highlighted && !highlighted) {
      last.text += piece;
    } else {
      out.push({ text: piece, highlighted });
    }
  }
  return out;
}
