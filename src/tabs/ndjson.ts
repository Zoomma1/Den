/**
 * Découpage NDJSON incrémental.
 *
 * Le flux sidecar -> UI arrive via un `Channel<String>` Tauri : le contrat ne
 * garantit qu'un texte par appel `onmessage`, pas une ligne complète à
 * chaque fois (cf. `src-tauri/src/sidecar.rs`). Chaque tab possède sa propre
 * instance de ce buffer — un reliquat partiel d'un tab ne doit jamais fuiter
 * vers un autre tab (cf. `router.ts`, qui en garde une par tabId).
 */
export class NdjsonLineBuffer {
  private pending = "";

  /**
   * Ajoute un chunk et retourne les lignes désormais complètes, dans
   * l'ordre. Le reliquat sans `\n` final est conservé pour le prochain push.
   * Les lignes vides (chunk contenant `\n\n`, ou ligne blanche isolée) sont
   * ignorées : elles ne portent jamais de message NDJSON valide.
   */
  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0);
  }
}
