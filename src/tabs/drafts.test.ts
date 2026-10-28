import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./attachments.css", () => ({}));

import { createDrafts } from "./drafts";
import { createAttachmentState, type AttachedImage } from "./attachments";

const img: AttachedImage = { mediaType: "image/png", data: "d", previewUrl: "blob:1" };

describe("drafts", () => {
  it("sauvegarde puis restaure texte et pièces jointes", () => {
    const d = createDrafts();
    d.save("a", { text: "hello", files: [{ path: "/x", name: "x" }], images: [img] });
    expect(d.restore("a")).toEqual({ text: "hello", files: [{ path: "/x", name: "x" }], images: [img] });
  });

  it("onglet inconnu : brouillon vide", () => {
    expect(createDrafts().restore("zz")).toEqual({ text: "", files: [], images: [] });
  });

  it("un brouillon vide n'est pas stocké et écrase l'ancien", () => {
    const d = createDrafts();
    d.save("a", { text: "x", files: [], images: [] });
    d.save("a", { text: "", files: [], images: [] });
    expect(d.has("a")).toBe(false);
  });

  it("discard retire et renvoie le brouillon", () => {
    const d = createDrafts();
    d.save("a", { text: "x", files: [], images: [img] });
    expect(d.discard("a")?.images).toEqual([img]);
    expect(d.has("a")).toBe(false);
    expect(d.discard("a")).toBeUndefined();
  });

  it("setText garde les pièces jointes", () => {
    const d = createDrafts();
    d.save("a", { text: "x", files: [], images: [img] });
    d.setText("a", "");
    expect(d.restore("a").images).toEqual([img]);
    d.setText("b", "new");
    expect(d.restore("b").text).toBe("new");
  });

  it("clearTextIf ne vide que si le texte est inchangé (rien d'effacé de ce qui a été retapé)", () => {
    const d = createDrafts();
    d.save("a", { text: "envoyé", files: [], images: [img] });
    d.clearTextIf("a", "autre");
    expect(d.restore("a").text).toBe("envoyé");
    d.clearTextIf("a", "envoyé");
    expect(d.restore("a")).toEqual({ text: "", files: [], images: [img] });
  });

  it("round-trip avec l'état d'attachements sans révoquer les URLs", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const state = createAttachmentState();
    state.addImage(img);
    const d = createDrafts();
    d.save("a", { text: "t", ...state.take() });
    state.bumpEpoch();
    expect(state.size()).toBe(0);
    state.restore(d.restore("a"));
    expect(state.images()).toEqual([img]);
    expect(revoke).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
