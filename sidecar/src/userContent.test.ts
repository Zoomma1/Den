import { describe, expect, it } from "vitest";
import { buildUserContent } from "./userContent";

const png = { mediaType: "image/png" as const, data: "AAA" };
const jpg = { mediaType: "image/jpeg" as const, data: "BBB" };
const img = (i: typeof png | typeof jpg) => ({
  type: "image",
  source: { type: "base64", media_type: i.mediaType, data: i.data },
});

describe("buildUserContent", () => {
  it("sans images : chaîne identique", () => {
    expect(buildUserContent({ text: "salut" })).toBe("salut");
    expect(buildUserContent({ text: "salut", images: [] })).toBe("salut");
  });
  it("une image + texte : image puis texte", () => {
    expect(buildUserContent({ text: "regarde", images: [png] })).toEqual([
      img(png),
      { type: "text", text: "regarde" },
    ]);
  });
  it("images + texte vide : pas de bloc texte", () => {
    expect(buildUserContent({ text: "", images: [png] })).toEqual([img(png)]);
  });
  it("plusieurs images : ordre conservé", () => {
    expect(buildUserContent({ text: "x", images: [png, jpg] })).toEqual([
      img(png),
      img(jpg),
      { type: "text", text: "x" },
    ]);
  });
});
