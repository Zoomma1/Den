/**
 * Pièces jointes de l'input (DEN-35). Fichiers du trombone = lignes
 * `@chemin` ajoutées au texte ; images collées = base64 dans `images`.
 * Logique pure en tête de fichier (testée), UI DOM en fin de fichier.
 */
import { open } from "@tauri-apps/plugin-dialog";
import type { ImageAttachment } from "../types/protocol";
import "./attachments.css";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: readonly ImageAttachment["mediaType"][] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export interface AttachedFile {
  path: string;
  name: string;
}
export interface AttachedImage extends ImageAttachment {
  previewUrl: string;
}
export interface AttachmentSnapshot {
  files: AttachedFile[];
  images: AttachedImage[];
}

/** null = chemin non mentionnable (guillemet double : pas d'échappement dans la syntaxe `@"…"`). */
export function formatMention(path: string): string | null {
  if (path.includes('"')) return null;
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** Une commande slash ne reçoit jamais de mentions : elles casseraient son parsing. */
export function composeText(text: string, filePaths: readonly string[]): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return trimmed;
  const mentions = filePaths
    .map(formatMention)
    .filter((m): m is string => m !== null);
  if (mentions.length === 0) return trimmed;
  return trimmed.length === 0 ? mentions.join("\n") : `${trimmed}\n${mentions.join("\n")}`;
}

export type ImageCheck =
  | { ok: true; mediaType: ImageAttachment["mediaType"] }
  | { ok: false; message: string };

export function validateImage(file: { type: string; size: number }): ImageCheck {
  const mediaType = IMAGE_TYPES.find((t) => t === file.type);
  if (!mediaType) {
    return { ok: false, message: `Image format not supported (${file.type || "unknown"}).` };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, message: "Image too large (max 5 MB)." };
  }
  return { ok: true, mediaType };
}

/** Le collage natif est conservé dès que du texte accompagne l'image (plage Excel, sélection web). */
export function shouldInterceptPaste(validImageCount: number, plainText: string): boolean {
  return validImageCount > 0 && plainText.trim().length === 0;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** Lectures async en cours : le submit attend `idle()` avant `take()`. */
export function createPendingTracker(): {
  begin(): () => void;
  count(): number;
  idle(): Promise<void>;
} {
  let pending = 0;
  let waiters: Array<() => void> = [];
  return {
    begin() {
      pending += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pending -= 1;
        if (pending === 0) {
          const ready = waiters;
          waiters = [];
          for (const w of ready) w();
        }
      };
    },
    count: () => pending,
    idle: () =>
      pending === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)),
  };
}

export function createAttachmentState() {
  let files: AttachedFile[] = [];
  let images: AttachedImage[] = [];
  // Incrémenté par clear() (changement d'onglet) : une opération async lancée avant ne doit plus toucher l'état.
  let epoch = 0;
  return {
    epoch: () => epoch,
    files: () => files,
    images: () => images,
    size: () => files.length + images.length,
    addFile(path: string): boolean {
      if (path.includes('"') || files.some((f) => f.path === path)) return false;
      files = [...files, { path, name: baseName(path) }];
      return true;
    },
    addImage(image: AttachedImage): void {
      images = [...images, image];
    },
    removeFile(path: string): void {
      files = files.filter((f) => f.path !== path);
    },
    removeImage(previewUrl: string): void {
      images = images.filter((i) => i.previewUrl !== previewUrl);
      URL.revokeObjectURL(previewUrl);
    },
    /** Vide l'état sans révoquer les URLs : `restore()` en a encore besoin si l'envoi échoue. */
    take(): AttachmentSnapshot {
      const snapshot = { files, images };
      files = [];
      images = [];
      return snapshot;
    },
    restore(snapshot: AttachmentSnapshot): void {
      files = [
        ...snapshot.files,
        ...files.filter((f) => !snapshot.files.some((s) => s.path === f.path)),
      ];
      images = [...snapshot.images, ...images];
    },
    /** À appeler après un envoi réussi : plus rien ne référence les previewUrl. */
    release(snapshot: AttachmentSnapshot): void {
      for (const image of snapshot.images) URL.revokeObjectURL(image.previewUrl);
    },
    clear(): void {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
      files = [];
      images = [];
      epoch += 1;
    },
  };
}
export type AttachmentState = ReturnType<typeof createAttachmentState>;

export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export interface AttachmentsUi {
  /** Barre de puces/vignettes à placer au-dessus du textarea. */
  barEl: HTMLElement;
  /** Bouton trombone. */
  buttonEl: HTMLButtonElement;
  state: AttachmentState;
  pending: ReturnType<typeof createPendingTracker>;
  /** À rappeler après toute mutation de `state` faite hors UI (restore, clear). */
  render(): void;
}

export function mountAttachments(textarea: HTMLTextAreaElement): AttachmentsUi {
  const state = createAttachmentState();
  const pending = createPendingTracker();

  const barEl = document.createElement("div");
  barEl.className = "den-attachments";
  barEl.hidden = true;
  const errorEl = document.createElement("span");
  errorEl.className = "den-attachments__error";
  errorEl.setAttribute("role", "status");
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  const buttonEl = document.createElement("button");
  buttonEl.type = "button";
  buttonEl.className = "den-attachments__button";
  buttonEl.title = "Attach files";
  buttonEl.textContent = "\u{1F4CE}";

  function showError(message: string): void {
    errorEl.textContent = message;
    render();
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorEl.textContent = "";
      render();
    }, 4000);
  }

  function chip(label: string, onRemove: () => void, thumbUrl?: string): HTMLElement {
    const el = document.createElement("span");
    el.className = "den-attachments__chip";
    if (thumbUrl) {
      const img = document.createElement("img");
      img.className = "den-attachments__thumb";
      img.src = thumbUrl;
      img.alt = label;
      el.append(img);
    }
    const name = document.createElement("span");
    name.className = "den-attachments__name";
    name.textContent = label;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "den-attachments__remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${label}`);
    remove.addEventListener("click", () => {
      onRemove();
      render();
    });
    el.append(name, remove);
    return el;
  }

  function render(): void {
    const chips: HTMLElement[] = [
      ...state.files().map((f) => chip(f.name, () => state.removeFile(f.path))),
      ...state.images().map((i, n) =>
        chip(`image ${n + 1}`, () => state.removeImage(i.previewUrl), i.previewUrl),
      ),
    ];
    barEl.replaceChildren(...chips, errorEl);
    barEl.hidden = chips.length === 0 && errorEl.textContent === "";
  }

  buttonEl.addEventListener("click", () => {
    void open({ multiple: true, directory: false }).then((result) => {
      const paths = result === null ? [] : Array.isArray(result) ? result : [result];
      for (const path of paths) {
        if (!state.addFile(path) && path.includes('"')) {
          showError(`Cannot attach "${baseName(path)}": path contains a double quote.`);
        }
      }
      render();
      textarea.focus();
    });
  });

  textarea.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const files = Array.from(data.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    const valid: Array<{ file: File; mediaType: ImageAttachment["mediaType"] }> = [];
    for (const file of files) {
      const check = validateImage(file);
      if (check.ok) valid.push({ file, mediaType: check.mediaType });
      else showError(check.message);
    }
    if (!shouldInterceptPaste(valid.length, data.getData("text/plain"))) return;
    event.preventDefault();
    const epoch = state.epoch();
    for (const { file, mediaType } of valid) {
      const done = pending.begin();
      readFileAsBase64(file)
        .then((b64) => {
          // Onglet changé pendant la lecture : l'image appartient à l'ancien onglet, on la jette.
          if (state.epoch() !== epoch) return;
          state.addImage({ mediaType, data: b64, previewUrl: URL.createObjectURL(file) });
          render();
        })
        .catch(() => showError("Could not read the pasted image."))
        .finally(done);
    }
  });

  return { barEl, buttonEl, state, pending, render };
}
