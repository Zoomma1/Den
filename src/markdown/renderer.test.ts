import { describe, expect, it } from "vitest";
import { IncrementalMarkdownRenderer, createMarkdownEngine } from "./renderer";

/** Découpe un texte en fragments de taille fixe, comme un flux de deltas réel. */
function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

/** Fait rejouer `text` delta par delta et retourne le HTML final reconstruit. */
function replay(text: string, chunkSize: number): { html: string; maxPendingLength: number } {
  const renderer = new IncrementalMarkdownRenderer();
  let finalized = "";
  let maxPendingLength = 0;
  for (const delta of chunk(text, chunkSize)) {
    const { finalizedHtml } = renderer.feed(delta);
    finalized += finalizedHtml.join("");
    maxPendingLength = Math.max(maxPendingLength, renderer.pendingText.length);
  }
  finalized += renderer.finalize().join("");
  return { html: finalized, maxPendingLength };
}

describe("IncrementalMarkdownRenderer", () => {
  it("ne finalise rien tant qu'aucun bloc suivant ne confirme la fin du bloc courant", () => {
    const renderer = new IncrementalMarkdownRenderer();
    const r1 = renderer.feed("Bonjour");
    expect(r1.finalizedHtml).toEqual([]);
    expect(r1.currentHtml).toContain("Bonjour");

    const r2 = renderer.feed(" le monde");
    expect(r2.finalizedHtml).toEqual([]);
    expect(r2.currentHtml).toContain("Bonjour le monde");
  });

  it("finalise le premier paragraphe dès qu'un second bloc démarre", () => {
    const renderer = new IncrementalMarkdownRenderer();
    renderer.feed("Premier paragraphe.");
    const { finalizedHtml, currentHtml } = renderer.feed("\n\nSecond paragraphe");

    expect(finalizedHtml).toHaveLength(1);
    expect(finalizedHtml[0]).toContain("Premier paragraphe.");
    expect(finalizedHtml[0]).not.toContain("Second");
    expect(currentHtml).toContain("Second paragraphe");
  });

  it("borne la queue non finalisée à la taille du bloc en cours, pas au message entier", () => {
    // Beaucoup de paragraphes courts qui se finalisent au fur et à mesure :
    // la queue interne ne doit jamais grossir avec le nombre de paragraphes déjà streamés.
    const paragraphs = Array.from({ length: 50 }, (_, i) => `Paragraphe numéro ${i}.`);
    const fullText = paragraphs.join("\n\n");
    const { maxPendingLength } = replay(fullText, 5);

    // Un paragraphe individuel fait ~25 caractères ; si la queue grossissait
    // avec tout le message déjà streamé, elle dépasserait largement 200.
    expect(maxPendingLength).toBeLessThan(100);
  });

  it("finalize() flush le texte restant en fin de message", () => {
    const renderer = new IncrementalMarkdownRenderer();
    renderer.feed("Un dernier paragraphe sans rien après");
    const flushed = renderer.finalize();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toContain("Un dernier paragraphe sans rien après");
    // Idempotent une fois vidé.
    expect(renderer.finalize()).toEqual([]);
  });

  it("applique la coloration syntaxique highlight.js sur un bloc de code fermé", () => {
    const renderer = new IncrementalMarkdownRenderer();
    const { finalizedHtml } = renderer.feed(
      "```ts\nconst x: number = 1;\n```\n\nSuite du texte",
    );
    const html = finalizedHtml.join("") + renderer.finalize().join("");
    expect(html).toContain('<pre class="den-code">');
    expect(html).toContain("hljs");
  });

  it("ne colore pas le bloc de code COURANT (fence ouvert), seulement à la finalisation — mesure 1b.2", () => {
    const renderer = new IncrementalMarkdownRenderer();
    const { currentHtml } = renderer.feed("```ts\nconst x: number = 1;\n");
    expect(currentHtml).toContain('<pre class="den-code">');
    expect(currentHtml).toContain('class="den-copy"');
    expect(currentHtml).not.toContain("hljs");
    expect(currentHtml).toContain("const x: number = 1;");

    const finalized = renderer.feed("```\n\nsuite").finalizedHtml.join("");
    expect(finalized).toContain("hljs");
  });

  it("ne plante pas sur un langage de bloc de code inconnu", () => {
    const renderer = new IncrementalMarkdownRenderer();
    renderer.feed("```not-a-real-language\nsome text\n```\n\nsuite");
    expect(() => renderer.finalize()).not.toThrow();
  });

  it("échappe le HTML brut au lieu de le laisser passer tel quel (XSS)", () => {
    const renderer = new IncrementalMarkdownRenderer();
    const { finalizedHtml } = renderer.feed(
      "Texte <script>alert(1)</script> suite\n\nautre bloc",
    );
    const html = finalizedHtml.join("") + renderer.finalize().join("");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("cohérence du replay : la concaténation incrémentale reconstruit le même HTML qu'un parse en un seul appel", () => {
    const text =
      "Introduction avec du **gras** et de l'*italique*.\n\n" +
      "```js\nfunction hello() {\n  return 42;\n}\n```\n\n" +
      "- un\n- deux\n- trois\n\n" +
      "Conclusion avec un [lien](https://example.test).";

    const engine = createMarkdownEngine();
    const oneShotHtml = engine.parser(engine.lexer(text));

    for (const size of [1, 3, 7, 16, 64]) {
      const { html } = replay(text, size);
      expect(html).toBe(oneShotHtml);
    }
  });
});
