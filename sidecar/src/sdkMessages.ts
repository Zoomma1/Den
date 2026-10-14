// Fonctions pures extraites de main.ts : lecture des messages du SDK.

export interface ToolResultOf {
  toolUseId: string;
  output: unknown;
  structured?: unknown;
  isError?: boolean;
}

/**
 * Résultats d'outils d'un message SDK `user`. `tool_use_result` est porté par le
 * message, pas par bloc : un seul bloc -> on l'attache ; plusieurs blocs -> seulement
 * si c'est un tableau de même longueur (association par index, forme non mesurée
 * contre le vrai SDK). Sinon on ne devine pas : pas de `structured`, repli sur la sortie brute.
 */
export function toolResultsOf(msg: { message?: { content?: unknown }; tool_use_result?: unknown }): ToolResultOf[] {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];
  const blocks = content.filter((b: any) => b?.type === "tool_result");
  const tur = msg.tool_use_result;
  return blocks.map((b: any, i: number) => {
    let structured: unknown;
    if (blocks.length === 1) structured = tur;
    else if (Array.isArray(tur) && tur.length === blocks.length) structured = tur[i];
    return {
      toolUseId: b.tool_use_id,
      output: b.content,
      ...(structured !== undefined ? { structured } : {}),
      isError: b.is_error,
    };
  });
}

export interface CommandOutputOf {
  command: string;
  args: string;
  text: string;
  isError?: boolean;
}

const ENVELOPE = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

/** Sortie d'une commande slash : message `assistant` synthétique portant `local_command_run`, sinon null. */
export function commandOutputOf(msg: any): CommandOutputOf | null {
  if (msg?.type !== "assistant" || !msg.local_command_run) return null;
  const { command, args } = msg.local_command_run;
  const raw: unknown =
    typeof msg.local_command_source === "string"
      ? msg.local_command_source
      : msg.message?.content?.find?.((b: any) => b?.type === "text")?.text;
  if (typeof raw !== "string") return null;
  const m = ENVELOPE.exec(raw);
  return { command: String(command ?? ""), args: String(args ?? ""), text: m ? m[1] : raw };
}

/** Durée du tour pour le pied « Worked for » : absente d'un result à 0 tour (commande slash, aucun travail). */
export function durationMsOf(result: any): number | undefined {
  return typeof result?.duration_ms === "number" && result.num_turns > 0 ? result.duration_ms : undefined;
}
