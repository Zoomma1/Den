/**
 * Décodage défensif des chunks de sortie PTY reçus sur le `Channel<Vec<u8>>`
 * Tauri (cf. `src-tauri/src/pty.rs`).
 *
 * Selon le chemin IPC emprunté par Tauri pour sérialiser un `Vec<u8>`, le
 * `Channel` peut livrer côté JS soit un `ArrayBuffer` (payload "raw"), soit
 * un tableau de nombres (payload JSON classique) — ce module reste tolérant
 * aux deux (et à `Uint8Array`, pratique pour les mocks de test) plutôt que
 * de figer une hypothèse sur le transport.
 */

/** Formes possibles d'un chunk de sortie PTY tel que livré par le transport. */
export type PtyChunk = ArrayBuffer | Uint8Array | number[];

/** Normalise un chunk de sortie PTY en `Uint8Array`, prêt pour `term.write`. */
export function decodePtyChunk(chunk: PtyChunk): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (Array.isArray(chunk)) {
    return Uint8Array.from(chunk);
  }
  throw new TypeError("Den/terminal: format de chunk PTY inattendu");
}
