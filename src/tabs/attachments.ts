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

export const SLASH_BLOCKED_MESSAGE = "Slash commands can't be sent with attachments. Remove them or send the command alone.";

/** Commande slash avec pièce jointe refusée à l'envoi (les mentions `@` ou un tableau de blocs casseraient son parsing) ; un premier mot contenant un autre `/` est un chemin, pas une commande. */
export function blocksSlash(text: string, attachmentCount: number): boolean {
  const firstWord = text.trim().split(/\s/)[0] ?? "";
  return attachmentCount > 0 && /^\/[^/]+$/.test(firstWord);
}

/** Garde-fou avant `createImageBitmap` : le décodage d'un TIFF/BMP géant se paie sur le thread UI. */
export const MAX_CONVERT_BYTES = 25 * 1024 * 1024;
export function checkConvertible(file: { size: number }): { ok: true } | { ok: false; message: string } {
  return file.size > MAX_CONVERT_BYTES
    ? { ok: false, message: "Image too large to convert (max 25 MB)." }
    : { ok: true };
}

/** Formats image lisibles par le webview mais refusés par l'API (TIFF, BMP…) : convertis en PNG au collage. SVG exclu (pas décodable en bitmap). */
export function isConvertibleImage(type: string): boolean {
  return (
    type.startsWith("image/") &&
    type !== "image/svg+xml" &&
    !IMAGE_TYPES.some((t) => t === type)
  );
}

export function composeText(text: string, filePaths: readonly string[]): string {
  const trimmed = text.trim();
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
    /** Retire les images seules, sans bumper l'époque : ✎ n'est pas un changement d'onglet, un envoi en cours doit rester valide. */
    clearImages(): void {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
      images = [];
    },
  };
}
export type AttachmentState = ReturnType<typeof createAttachmentState>;

/** Bitmap décodé par le webview puis redessiné : le seul chemin sans dépendance pour passer de TIFF/BMP à PNG. */
export async function convertToPng(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("toBlob failed");
    return blob;
  } finally {
    bitmap.close();
  }
}

/** Reconstruit un Blob depuis le base64 d'un écho pour que ✎ puisse recréer une vignette. */
export function base64ToBlob(data: string, mediaType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

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
  /** Message temporaire dans la barre (refus d'envoi, image ignorée…). */
  notify(message: string): void;
  /** Remet les images d'un écho (bouton ✎) en pièces jointes, avec de nouvelles vignettes. */
  restoreImages(images: readonly ImageAttachment[]): void;
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
    void open({ multiple: true, directory: false })
      .then((result) => {
        const paths = result === null ? [] : Array.isArray(result) ? result : [result];
        for (const path of paths) {
          if (!state.addFile(path) && path.includes('"')) {
            showError(`Cannot attach "${baseName(path)}": path contains a double quote.`);
          }
        }
        render();
        textarea.focus();
      })
      .catch(() => showError("Could not open the file picker."));
  });

  textarea.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!data) return;
    const files = Array.from(data.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    // `convert` : format hors liste blanche, passé en PNG avant la lecture (la taille est alors contrôlée sur le PNG).
    const jobs: Array<{ file: Blob; convert: boolean }> = [];
    for (const file of files) {
      if (isConvertibleImage(file.type)) {
        const convertible = checkConvertible(file);
        if (convertible.ok) jobs.push({ file, convert: true });
        else showError(convertible.message);
        continue;
      }
      const check = validateImage(file);
      if (check.ok) jobs.push({ file, convert: false });
      else showError(check.message);
    }
    if (!shouldInterceptPaste(jobs.length, data.getData("text/plain"))) return;
    event.preventDefault();
    const epoch = state.epoch();
    // Tous les compteurs avant le premier await : le submit doit voir les lectures en attente tout de suite.
    const dones = jobs.map(() => pending.begin());
    // Séquentiel : une conversion lente ne doit pas faire passer une image collée après la suivante.
    void (async () => {
      for (const [index, job] of jobs.entries()) {
        let stage: "convert" | "read" = "read";
        try {
          let blob = job.file;
          if (job.convert) {
            stage = "convert";
            blob = await convertToPng(job.file);
            stage = "read";
          }
          const check = validateImage(blob);
          if (!check.ok) {
            showError(check.message);
            continue;
          }
          const b64 = await readFileAsBase64(blob);
          // Onglet changé pendant la lecture : l'image appartient à l'ancien onglet, on la jette.
          if (state.epoch() !== epoch) continue;
          state.addImage({ mediaType: check.mediaType, data: b64, previewUrl: URL.createObjectURL(blob) });
          render();
        } catch {
          showError(stage === "convert" ? "Could not convert this image to PNG." : "Could not read the pasted image.");
        } finally {
          dones[index]();
        }
      }
    })();
  });

  function restoreImages(images: readonly ImageAttachment[]): void {
    for (const image of images) {
      state.addImage({ ...image, previewUrl: URL.createObjectURL(base64ToBlob(image.data, image.mediaType)) });
    }
    render();
  }

  return { barEl, buttonEl, state, pending, render, notify: showError, restoreImages };
}
