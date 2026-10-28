import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./attachments.css", () => ({}));

import {
  MAX_CONVERT_BYTES,
  MAX_IMAGE_BYTES,
  base64ToBlob,
  baseName,
  blocksSlash,
  checkConvertible,
  composeText,
  createAttachmentState,
  createPendingTracker,
  formatMention,
  isConvertibleImage,
  shouldInterceptPaste,
  validateImage,
  type AttachedImage,
} from "./attachments";

afterEach(() => vi.restoreAllMocks());

describe("bumpEpoch", () => {
  it("incrémente l'époque sans toucher aux images ni révoquer leurs URLs", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const state = createAttachmentState();
    state.addImage({ mediaType: "image/png", data: "d", previewUrl: "blob:b" });
    const before = state.epoch();
    state.bumpEpoch();
    expect(state.epoch()).toBe(before + 1);
    expect(state.images()).toHaveLength(1);
    expect(revoke).not.toHaveBeenCalled();
  });
});

const img = (n: number): AttachedImage => ({
  mediaType: "image/png",
  data: `d${n}`,
  previewUrl: `blob:${n}`,
});

describe("formatMention", () => {
  it("chemin simple", () => expect(formatMention("/a/b.ts")).toBe("@/a/b.ts"));
  it("guillemets si espaces", () => expect(formatMention("/a b/c.ts")).toBe('@"/a b/c.ts"'));
  it("refuse un guillemet double", () => expect(formatMention('/a"b')).toBeNull());
});

describe("composeText", () => {
  it("sans fichier : texte trimé", () => expect(composeText("  hi  ", [])).toBe("hi"));
  it("ajoute une ligne par fichier", () =>
    expect(composeText("look", ["/a", "/b c"])).toBe('look\n@/a\n@"/b c"'));
  it("texte vide : mentions seules", () => expect(composeText("", ["/a"])).toBe("@/a"));
  it("ignore les chemins avec guillemet", () =>
    expect(composeText("x", ['/a"b', "/c"])).toBe("x\n@/c"));
  it("tout refusé : texte seul", () => expect(composeText("x", ['/a"'])).toBe("x"));
});

describe("blocksSlash", () => {
  it("commande slash avec pièce jointe : bloqué", () => expect(blocksSlash("/compact", 1)).toBe(true));
  it("espaces avant le slash : bloqué", () => expect(blocksSlash("  /model x", 2)).toBe(true));
  it("commande slash seule : envoyée", () => expect(blocksSlash("/compact", 0)).toBe(false));
  it("texte normal avec pièce jointe : envoyé", () => expect(blocksSlash("regarde", 1)).toBe(false));
  it("slash au milieu du texte : envoyé", () => expect(blocksSlash("voir /tmp", 1)).toBe(false));
  it("chemin absolu en premier mot : envoyé", () =>
    expect(blocksSlash("/Users/me/app/foo.ts plante, voir l'image", 1)).toBe(false));
  it("commande avec argument : bloqué", () => expect(blocksSlash("/model claude-opus", 1)).toBe(true));
  it("slash seul : pas une commande, envoyé", () => expect(blocksSlash("/", 1)).toBe(false));
});

describe("checkConvertible", () => {
  it("accepte jusqu'à 25 Mo, refuse au-delà", () => {
    expect(checkConvertible({ size: MAX_CONVERT_BYTES }).ok).toBe(true);
    expect(checkConvertible({ size: MAX_CONVERT_BYTES + 1 }).ok).toBe(false);
  });
});

describe("isConvertibleImage", () => {
  it("TIFF et BMP sont convertis", () => {
    expect(isConvertibleImage("image/tiff")).toBe(true);
    expect(isConvertibleImage("image/bmp")).toBe(true);
  });
  it("formats natifs : pas de conversion", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isConvertibleImage(t)).toBe(false);
    }
  });
  it("SVG et non-images exclus", () => {
    expect(isConvertibleImage("image/svg+xml")).toBe(false);
    expect(isConvertibleImage("application/pdf")).toBe(false);
    expect(isConvertibleImage("")).toBe(false);
  });
});

describe("base64ToBlob", () => {
  it("restitue les octets et le type", async () => {
    const blob = base64ToBlob(btoa("abc"), "image/png");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
    expect(await blob.text()).toBe("abc");
  });
});

describe("validateImage", () => {
  it("accepte png/jpeg/gif/webp", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(validateImage({ type, size: 10 }).ok).toBe(true);
    }
  });
  it("refuse un format inconnu", () => {
    const r = validateImage({ type: "image/svg+xml", size: 10 });
    expect(r.ok).toBe(false);
  });
  it("refuse > 5 Mo, accepte pile 5 Mo", () => {
    expect(validateImage({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }).ok).toBe(false);
    expect(validateImage({ type: "image/png", size: MAX_IMAGE_BYTES }).ok).toBe(true);
  });
});

describe("shouldInterceptPaste", () => {
  it("image valide sans texte : intercepte", () => expect(shouldInterceptPaste(1, "")).toBe(true));
  it("texte blanc seul : intercepte", () => expect(shouldInterceptPaste(1, "  \n")).toBe(true));
  it("image + texte : collage natif", () => expect(shouldInterceptPaste(1, "a\tb")).toBe(false));
  it("aucune image valide : collage natif", () => expect(shouldInterceptPaste(0, "")).toBe(false));
});

describe("baseName", () => {
  it("unix et windows", () => {
    expect(baseName("/a/b/c.txt")).toBe("c.txt");
    expect(baseName("C:\\a\\b.txt")).toBe("b.txt");
  });
});

describe("createPendingTracker", () => {
  it("idle résolu immédiatement sans lecture", async () => {
    await createPendingTracker().idle();
  });
  it("idle attend la fin de toutes les lectures", async () => {
    const t = createPendingTracker();
    const d1 = t.begin();
    const d2 = t.begin();
    let resolved = false;
    void t.idle().then(() => (resolved = true));
    d1();
    await Promise.resolve();
    expect(resolved).toBe(false);
    d2();
    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(t.count()).toBe(0);
  });
  it("done est idempotent", () => {
    const t = createPendingTracker();
    const d = t.begin();
    t.begin();
    d();
    d();
    expect(t.count()).toBe(1);
  });
});

describe("createAttachmentState", () => {
  it("addFile dédoublonne et refuse les guillemets", () => {
    const s = createAttachmentState();
    expect(s.addFile("/a/x.ts")).toBe(true);
    expect(s.addFile("/a/x.ts")).toBe(false);
    expect(s.addFile('/a/"x')).toBe(false);
    expect(s.files()).toEqual([{ path: "/a/x.ts", name: "x.ts" }]);
  });

  it("take vide sans révoquer ; restore remet en tête", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const s = createAttachmentState();
    s.addFile("/a");
    s.addImage(img(1));
    const snap = s.take();
    expect(s.size()).toBe(0);
    expect(revoke).not.toHaveBeenCalled();
    s.addImage(img(2));
    s.restore(snap);
    expect(s.images().map((i) => i.data)).toEqual(["d1", "d2"]);
    expect(s.files()).toHaveLength(1);
  });

  it("release révoque les previewUrl du snapshot", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const s = createAttachmentState();
    s.addImage(img(1));
    s.addImage(img(2));
    s.release(s.take());
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("removeImage révoque et retire", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const s = createAttachmentState();
    s.addImage(img(1));
    s.removeImage("blob:1");
    expect(s.images()).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("clear incrémente l'époque, take/restore non", () => {
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const s = createAttachmentState();
    const e0 = s.epoch();
    s.restore(s.take());
    expect(s.epoch()).toBe(e0);
    s.clear();
    expect(s.epoch()).toBe(e0 + 1);
  });

  it("clearImages révoque les images, garde les fichiers et l'époque", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const s = createAttachmentState();
    s.addFile("/a");
    s.addImage(img(1));
    const e0 = s.epoch();
    s.clearImages();
    expect(s.images()).toHaveLength(0);
    expect(s.files()).toHaveLength(1);
    expect(s.epoch()).toBe(e0);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });

  it("clear révoque les images courantes", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const s = createAttachmentState();
    s.addFile("/a");
    s.addImage(img(1));
    s.clear();
    expect(s.size()).toBe(0);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });
});
