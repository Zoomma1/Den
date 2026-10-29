import { invoke } from "@tauri-apps/api/core";
import type { LayoutPreset } from "../workspace/store";

// bypassPermissions / dontAsk volontairement absents : jamais proposables depuis un fichier éditable.
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// Copie de LAYOUT_PRESETS (non exporté de workspace/store.ts, hors périmètre du lot).
export const SETTINGS_LAYOUT_PRESETS: readonly LayoutPreset[] = ["side-by-side", "stacked"];

export interface Settings {
  defaultPermissionMode?: PermissionMode;
  layoutPreset?: LayoutPreset;
  theme?: string;
}

function asObject(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Une valeur invalide est ignorée : la clé est traitée comme absente. */
export function parseSettings(raw: string): Settings {
  const obj = asObject(raw);
  const out: Settings = {};
  const mode = obj.defaultPermissionMode;
  if (typeof mode === "string" && (PERMISSION_MODES as readonly string[]).includes(mode)) {
    out.defaultPermissionMode = mode as PermissionMode;
  }
  const preset = obj.layoutPreset;
  if (typeof preset === "string" && (SETTINGS_LAYOUT_PRESETS as readonly string[]).includes(preset)) {
    out.layoutPreset = preset as LayoutPreset;
  }
  const theme = obj.theme;
  if (typeof theme === "string" && theme.trim() !== "") out.theme = theme;
  return out;
}

export function effectiveMode(settings: Settings): PermissionMode {
  return settings.defaultPermissionMode ?? "default";
}

// Contrairement à `asObject`, un JSON cassé fait échouer l'écriture : on n'écrase pas une édition manuelle.
function existingObject(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  const refuse = () => new Error("settings.json invalide : écriture refusée pour ne pas perdre ses clés");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw refuse();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw refuse();
  return parsed as Record<string, unknown>;
}

/** Fusionne le patch dans le JSON existant : clés inconnues préservées, objet complet. */
export function mergeSettings(existingRaw: string, patch: Settings): string {
  return JSON.stringify({ ...existingObject(existingRaw), ...patch }, null, 2) + "\n";
}

let current: Settings = {};

export function getSettings(): Settings {
  return current;
}

export async function load(): Promise<Settings> {
  const raw = await invoke<string>("settings_read");
  current = parseSettings(raw);
  return current;
}

// Lecture-fusion-écriture sérialisée : deux saves rapprochés ne doivent pas lire le même état périmé.
let saveQueue: Promise<void> = Promise.resolve();

export function save(patch: Settings): Promise<void> {
  const run = saveQueue.then(async () => {
    const raw = await invoke<string>("settings_read");
    await invoke("settings_write", { json: mergeSettings(raw, patch) });
    current = { ...current, ...patch };
  });
  saveQueue = run.catch(() => undefined);
  return run;
}

export function openThemesDir(): Promise<void> {
  return invoke<void>("theme_open_dir");
}

export function listThemes(): Promise<string[]> {
  return invoke<string[]>("theme_list");
}
