/**
 * `toolInput.ts` — lecture humaine de l'input d'un appel d'outil (DEN-46).
 * Module pur : le DOM reste dans conversationView.ts / interactive/blocks.ts.
 */

export interface ToolInputField {
  label: string;
  value: string;
}

export type ToolInputView =
  | { kind: "plan"; markdown: string; summary: string }
  | { kind: "fields"; main: string; extras: ToolInputField[]; summary: string }
  | { kind: "raw"; json: string; summary: string };

const SUMMARY_MAX = 80;

/** Champ principal et champs secondaires affichés en libellé, par outil. */
const FIELD_MAP: Record<string, { main: string; extras: string[] }> = {
  Bash: { main: "command", extras: ["description"] },
  Read: { main: "file_path", extras: [] },
  Edit: { main: "file_path", extras: [] },
  Write: { main: "file_path", extras: [] },
  NotebookEdit: { main: "notebook_path", extras: [] },
  Grep: { main: "pattern", extras: ["path"] },
  Glob: { main: "pattern", extras: ["path"] },
  WebFetch: { main: "url", extras: [] },
};

export function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function oneLine(text: string): string {
  const trimmed = text.trim();
  const line = trimmed.split("\n")[0].trim();
  const truncated = line.length < trimmed.length || line.length > SUMMARY_MAX;
  if (!truncated) return line;
  return `${line.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}

function str(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function describeToolInput(name: string, input: unknown): ToolInputView {
  if (name === "ExitPlanMode") {
    const plan = str(input, "plan");
    if (plan !== undefined) return { kind: "plan", markdown: plan, summary: oneLine(plan.replace(/^#+\s*/, "")) };
  }
  const spec = FIELD_MAP[name];
  const main = spec ? str(input, spec.main) : undefined;
  if (spec && main !== undefined) {
    const extras: ToolInputField[] = [];
    for (const label of spec.extras) {
      const value = str(input, label);
      if (value !== undefined) extras.push({ label, value });
    }
    // Les autres champs (old_string, new_string, content, timeout…) restent visibles : on ne perd pas ce qui change.
    for (const [label, raw] of Object.entries(input as Record<string, unknown>)) {
      if (label === spec.main || spec.extras.includes(label) || raw === undefined || raw === null) continue;
      const value = typeof raw === "string" ? raw : toJson(raw);
      if (value !== "") extras.push({ label, value });
    }
    return { kind: "fields", main, extras, summary: oneLine(main) };
  }
  return { kind: "raw", json: toJson(input), summary: "" };
}
