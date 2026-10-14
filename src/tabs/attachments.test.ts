import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./attachments.css", () => ({}));

import {
  MAX_IMAGE_BYTES,
  baseName,
  composeText,
  createAttachmentState,
  createPendingTracker,
  formatMention,
  shouldInterceptPaste,
  validateImage,
  type AttachedImage,
} from "./attachments";

afterEach(() => vi.restoreAllMocks());

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
  it("commande slash : mentions ignorées", () =>
    expect(composeText("/compact", ["/a"])).toBe("/compact"));
  it("ignore les chemins avec guillemet", () =>
    expect(composeText("x", ['/a"b', "/c"])).toBe("x\n@/c"));
  it("tout refusé : texte seul", () => expect(composeText("x", ['/a"'])).toBe("x"));
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
