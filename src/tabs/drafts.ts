/** Brouillon par onglet (DEN-53) : texte + pièces jointes mis de côté au changement d'onglet. */
import type { AttachmentSnapshot } from "./attachments";

export interface Draft extends AttachmentSnapshot {
  text: string;
}

const isEmpty = (d: Draft): boolean => d.text === "" && d.files.length === 0 && d.images.length === 0;

export function createDrafts() {
  const drafts = new Map<string, Draft>();
  function restore(tabId: string): Draft {
    return drafts.get(tabId) ?? { text: "", files: [], images: [] };
  }
  function save(tabId: string, draft: Draft): void {
    if (isEmpty(draft)) drafts.delete(tabId);
    else drafts.set(tabId, draft);
  }
  return {
    /** Un brouillon vide est supprimé plutôt que stocké. */
    save,
    /** Onglet inconnu : brouillon vide. Ne retire rien (voir discard). */
    restore,
    /** Retire et renvoie le brouillon : l'appelant révoque les previewUrl de ses images. */
    discard(tabId: string): Draft | undefined {
      const draft = drafts.get(tabId);
      drafts.delete(tabId);
      return draft;
    },
    /** Remplace le texte seul, pièces jointes conservées (envoi depuis un onglet quitté). */
    setText(tabId: string, text: string): void {
      save(tabId, { ...restore(tabId), text });
    },
    /** Vide le texte seulement s'il est inchangé : un envoi terminé ne doit pas effacer ce qui a été retapé depuis. */
    clearTextIf(tabId: string, text: string): void {
      const draft = restore(tabId);
      if (draft.text === text) save(tabId, { ...draft, text: "" });
    },
    has: (tabId: string): boolean => drafts.has(tabId),
  };
}
export type Drafts = ReturnType<typeof createDrafts>;
