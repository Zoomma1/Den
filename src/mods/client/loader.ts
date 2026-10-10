import type { ClientModuleBundle } from "../../types/protocol";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 512;

// Un Worker n'a pas d'import-map : on réécrit les clés. Balayage linéaire (une regex à retour arrière était quadratique).
const TOKEN = /\b(import|export|from)\b|['"`;()]/g;
const MAX_SPECIFIER = 4096;

const bytes = (s: string) => new TextEncoder().encode(s).length;

const skipSpaces = (src: string, i: number): number => {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
};

/** Littéral 'k' ou "k" commençant en i : retourne les bornes du contenu. */
function literalAt(src: string, i: number): { start: number; end: number } | null {
  const q = src[i];
  if (q !== "'" && q !== '"') return null;
  const limit = Math.min(src.length, i + 1 + MAX_SPECIFIER);
  for (let j = i + 1; j < limit; j++) {
    const c = src[j];
    if (c === q) return j > i + 1 ? { start: i + 1, end: j } : null;
    if (c === "\n" || c === "'" || c === '"') return null;
  }
  return null;
}

/** import X from 'k', export ... from 'k', import 'k', import('k') : bornes de chaque spécificateur, dans l'ordre. */
// Exporté pour le test de complexité (les plafonds de loadBundle empêchent d'y passer 4 Mio).
export function specifiersOf(src: string): { start: number; end: number }[] {
  const hits: { start: number; end: number }[] = [];
  const re = new RegExp(TOKEN.source, "g");
  let clause = false;
  const take = (i: number): void => {
    const hit = literalAt(src, i);
    if (!hit) return;
    hits.push(hit);
    re.lastIndex = hit.end + 1;
    clause = false;
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const word = m[1];
    if (word === "export") clause = true;
    else if (word === "import") {
      clause = true;
      let i = skipSpaces(src, re.lastIndex);
      if (src[i] === "(") i = skipSpaces(src, i + 1);
      take(i);
    } else if (word === "from") {
      if (clause) take(skipSpaces(src, re.lastIndex));
    } else clause = false;
  }
  return hits;
}

function dependenciesOf(file: { key: string; source: string }, keys: Set<string>): string[] {
  const deps = new Set<string>();
  for (const { start, end } of specifiersOf(file.source)) {
    const spec = file.source.slice(start, end);
    if (spec.startsWith("surface-unlinked:")) {
      throw new Error(`import non résolu dans ${file.key} : ${spec}`);
    }
    if (keys.has(spec)) deps.add(spec);
    else if (/^(claude|surface):/.test(spec)) {
      throw new Error(`import absent du bundle dans ${file.key} : ${spec}`);
    }
  }
  return [...deps];
}

function rewrite(source: string, urls: Record<string, string>): string {
  let out = "";
  let prev = 0;
  for (const { start, end } of specifiersOf(source)) {
    const url = urls[source.slice(start, end)];
    if (url === undefined) continue;
    out += source.slice(prev, start) + url;
    prev = end;
  }
  return out + source.slice(prev);
}

/** Valide les plafonds, ordonne par dépendances et crée une URL par fichier (réécrite vers les URL des dépendances) ; retourne clé -> URL. */
export function loadBundle(
  bundle: ClientModuleBundle,
  createObjectURL: (source: string) => string,
  revokeObjectURL?: (url: string) => void,
): Record<string, string> {
  const { files } = bundle;
  if (files.length > MAX_FILES) throw new Error(`bundle de ${files.length} fichiers (plafond ${MAX_FILES})`);
  let total = 0;
  for (const f of files) {
    const size = bytes(f.source);
    if (size > MAX_FILE_BYTES) throw new Error(`fichier ${f.key} de ${size} octets (plafond 1 Mio)`);
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`bundle de ${total} octets (plafond 8 Mio)`);

  const byKey = new Map(files.map((f) => [f.key, f]));
  const keys = new Set(byKey.keys());
  const urls: Record<string, string> = Object.create(null);
  const state = new Map<string, "visiting" | "done">();

  const visit = (key: string, path: string[]): void => {
    const st = state.get(key);
    if (st === "done") return;
    if (st === "visiting") throw new Error(`cycle d'imports : ${[...path, key].join(" -> ")}`);
    state.set(key, "visiting");
    const file = byKey.get(key)!;
    for (const dep of dependenciesOf(file, keys)) visit(dep, [...path, key]);
    urls[key] = createObjectURL(rewrite(file.source, urls));
    state.set(key, "done");
  };

  try {
    for (const f of files) visit(f.key, []);
  } catch (e) {
    // Un échec en cours de route ne doit laisser aucune URL créée.
    for (const url of Object.values(urls)) revokeObjectURL?.(url);
    throw e;
  }
  return urls;
}
