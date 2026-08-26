import { describe, expect, it } from "vitest";
import { TabRouter } from "./router";

describe("TabRouter", () => {
  it("route un message complet vers le bon tabId", () => {
    const router = new TabRouter();
    router.registerTab("tab-a");
    const routed = router.handleChunk("tab-a", '{"type":"done"}\n');
    expect(routed).toEqual([{ tabId: "tab-a", message: { type: "done" } }]);
  });

  it("isole les buffers partiels de deux tabs distincts", () => {
    const router = new TabRouter();
    router.registerTab("tab-a");
    router.registerTab("tab-b");

    // Reliquat partiel sur tab-a, ne doit jamais se combiner avec tab-b.
    expect(router.handleChunk("tab-a", '{"type":"done"')).toEqual([]);
    expect(
      router.handleChunk("tab-b", '{"type":"assistant_delta","id":"1","text":"hi"}\n'),
    ).toEqual([
      {
        tabId: "tab-b",
        message: { type: "assistant_delta", id: "1", text: "hi" },
      },
    ]);
    // Le reliquat de tab-a est toujours là, intact.
    expect(router.handleChunk("tab-a", "}\n")).toEqual([
      { tabId: "tab-a", message: { type: "done" } },
    ]);
  });

  it("ignore silencieusement une ligne JSON invalide sans affecter les suivantes", () => {
    const router = new TabRouter();
    router.registerTab("tab-a");
    const routed = router.handleChunk(
      "tab-a",
      'ceci n\'est pas du JSON\n{"type":"done"}\n',
    );
    expect(routed).toEqual([{ tabId: "tab-a", message: { type: "done" } }]);
  });

  it("ignore une ligne JSON valide mais hors protocole", () => {
    const router = new TabRouter();
    router.registerTab("tab-a");
    const routed = router.handleChunk("tab-a", '{"type":"not_a_den_message"}\n');
    expect(routed).toEqual([]);
  });

  it("un tabId non enregistré ne produit rien et ne jette pas", () => {
    const router = new TabRouter();
    expect(() => router.handleChunk("ghost", '{"type":"done"}\n')).not.toThrow();
    expect(router.handleChunk("ghost", '{"type":"done"}\n')).toEqual([]);
  });

  it("met à jour l'état du tab à error après un message error, et closeTab l'efface", () => {
    const router = new TabRouter();
    router.registerTab("tab-a");
    expect(router.getState("tab-a")).toBe("idle");
    router.handleChunk("tab-a", '{"type":"error","message":"boom"}\n');
    expect(router.getState("tab-a")).toBe("error");
    router.closeTab("tab-a");
    expect(router.getState("tab-a")).toBeUndefined();
  });

  it("markPromptSubmitted fait passer un tab idle à running", () => {
    const router = new TabRouter();
    router.registerTab("tab-a");
    router.markPromptSubmitted("tab-a");
    expect(router.getState("tab-a")).toBe("running");
  });
});
