/** Mode de permission initial d'une session, lu dans `settings.json` du dossier de config Den. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionModeId } from "../../src/types/protocol";

// Liste blanche stricte : bypassPermissions/dontAsk ne doivent jamais s'activer par fichier.
const ALLOWED: readonly PermissionModeId[] = ["default", "acceptEdits", "plan", "auto"];

export type ReadFile = (path: string) => string;

export const readFileUtf8: ReadFile = (path) => readFileSync(path, "utf8");

export function resolveInitialMode(
  env: NodeJS.ProcessEnv,
  readFile: ReadFile = readFileUtf8,
): PermissionModeId {
  const dir = env.DEN_CONFIG_DIR;
  if (!dir) return "default";
  const path = join(dir, "settings.json");

  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    // Fichier absent = cas normal, silencieux.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[den] ${path} illisible, mode initial "default": ${String(err)}`);
    }
    return "default";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[den] ${path} JSON invalide, mode initial "default": ${String(err)}`);
    return "default";
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`[den] ${path} doit contenir un objet JSON, mode initial "default"`);
    return "default";
  }
  const value = (parsed as Record<string, unknown>).defaultPermissionMode;
  if (value === undefined) return "default";
  if (typeof value === "string" && (ALLOWED as readonly string[]).includes(value)) {
    return value as PermissionModeId;
  }
  console.error(`[den] defaultPermissionMode invalide (${JSON.stringify(value)}), mode initial "default"`);
  return "default";
}
