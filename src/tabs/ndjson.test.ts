import { describe, expect, it } from "vitest";
import { NdjsonLineBuffer } from "./ndjson";

describe("NdjsonLineBuffer", () => {
  it("ne retourne rien tant qu'aucune ligne n'est complète", () => {
    const buf = new NdjsonLineBuffer();
    expect(buf.push('{"type":"done"')).toEqual([]);
  });

  it("retourne la ligne complète une fois le \\n reçu, dans un chunk séparé", () => {
    const buf = new NdjsonLineBuffer();
    expect(buf.push('{"type":"done"}')).toEqual([]);
    expect(buf.push("\n")).toEqual(['{"type":"done"}']);
  });

  it("retourne plusieurs lignes présentes dans un seul chunk", () => {
    const buf = new NdjsonLineBuffer();
    const lines = buf.push('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}', '{"type":"c"}']);
  });

  it("reconstruit une ligne éclatée caractère par caractère", () => {
    const buf = new NdjsonLineBuffer();
    const line = '{"type":"assistant_delta","id":"1","text":"salut"}';
    let collected: string[] = [];
    for (const ch of line + "\n") {
      collected = collected.concat(buf.push(ch));
    }
    expect(collected).toEqual([line]);
  });

  it("conserve le reliquat partiel après une ligne complète (chunk mixte)", () => {
    const buf = new NdjsonLineBuffer();
    const lines = buf.push('{"type":"a"}\n{"type":"b"');
    expect(lines).toEqual(['{"type":"a"}']);
    expect(buf.push('}\n')).toEqual(['{"type":"b"}']);
  });

  it("ignore les lignes vides", () => {
    const buf = new NdjsonLineBuffer();
    expect(buf.push("\n\n")).toEqual([]);
  });

  it("deux instances ne partagent aucun état", () => {
    const a = new NdjsonLineBuffer();
    const b = new NdjsonLineBuffer();
    expect(a.push('{"type":"a"')).toEqual([]);
    expect(b.push('{"type":"b"}\n')).toEqual(['{"type":"b"}']);
    expect(a.push('}\n')).toEqual(['{"type":"a"}']);
  });
});
