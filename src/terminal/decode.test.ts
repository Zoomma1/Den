import { describe, expect, it } from "vitest";
import { decodePtyChunk } from "./decode";

describe("decodePtyChunk", () => {
  it("passe un Uint8Array tel quel", () => {
    const input = new Uint8Array([104, 105]); // "hi"
    expect(decodePtyChunk(input)).toBe(input);
  });

  it("convertit un ArrayBuffer (forme réelle livrée par le Channel Tauri)", () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const result = decodePtyChunk(buffer);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it("convertit un tableau de nombres (mock de test)", () => {
    const result = decodePtyChunk([10, 20, 30]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([10, 20, 30]);
  });

  it("rejette un format inattendu", () => {
    // @ts-expect-error — on force un format hors contrat pour vérifier le garde-fou runtime.
    expect(() => decodePtyChunk("nope")).toThrow(TypeError);
  });

  it("préserve un flux vide", () => {
    expect(Array.from(decodePtyChunk(new ArrayBuffer(0)))).toEqual([]);
  });
});
