/** Signatures figées pour le lot de repli ToolGroup (DEN-32 phase 3) : aucune logique ici. */

/** Appel d'outil tel que groupé par le moteur (ToolGroupCall réduit au nécessaire). */
export interface ToolGroupCall {
  tool: string;
  input: unknown;
  isErrored?: boolean;
  isRunning?: boolean;
}

/** Vrai si l'outil ne modifie rien (lecture, recherche, listing) et peut se replier dans un groupe. */
export function isReadOnlyTool(_name: string): boolean {
  throw new Error("not implemented");
}

/** Résumé d'une suite d'appels repliés, ex. « Read 3 files, ran 2 shell commands ». */
export function summarizeToolRun(_calls: readonly ToolGroupCall[]): string {
  throw new Error("not implemented");
}
