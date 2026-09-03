// @vitest-environment happy-dom
/**
 * Test de replay — rejoue la fixture synthétique `transcript-synthetic.ndjson`
 * en passant par le vrai chemin d'intégration (contrat inter-lots :
 * `den:session-message` / `den:active-tab-changed` sur `window`, cf.
 * `src/markdown/index.ts`), et vérifie la cohérence du résultat final.
 *
 * Le rendu perceptif (fluidité du streaming) est validé au grill E2E — ici
 * on vérifie que rejouer tout le transcript ne plante pas et que la
 * structure DOM finale est cohérente avec le contenu de la fixture.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { init, mountCustomBlock } from "./index";
import type { SidecarToUIMessage } from "../types/protocol";
// Import brut (Vite `?raw`, cf. déclaration dans src/vite-env.d.ts) — évite
// toute dépendance à @types/node (absent des devDependencies du bootstrap).
import fixtureRaw from "./fixtures/transcript-synthetic.ndjson?raw";

function loadFixture(): SidecarToUIMessage[] {
  return fixtureRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SidecarToUIMessage);
}

function emitSessionMessage(tabId: string, message: SidecarToUIMessage): void {
  window.dispatchEvent(
    new CustomEvent("den:session-message", { detail: { tabId, message } }),
  );
}

function emitActiveTabChanged(tabId: string): void {
  window.dispatchEvent(
    new CustomEvent("den:active-tab-changed", { detail: { tabId, projectId: null } }),
  );
}

describe("replay du transcript synthétique", () => {
  let conversationMount: HTMLElement;

  beforeEach(() => {
    conversationMount = document.createElement("section");
    init({
      mounts: {
        tabs: document.createElement("nav"),
        conversation: conversationMount,
        terminal: document.createElement("section"),
        status: document.createElement("footer"),
      },
    });
  });

  it("rejoue tout le transcript sans erreur et produit une structure cohérente", () => {
    const fixture = loadFixture();
    const tabId = "tab-replay";
    emitActiveTabChanged(tabId);

    expect(() => {
      for (const message of fixture) {
        emitSessionMessage(tabId, message);
      }
    }).not.toThrow();

    const assistantIds = new Set(
      fixture
        .filter((m): m is Extract<SidecarToUIMessage, { type: "assistant_delta" }> =>
          m.type === "assistant_delta",
        )
        .map((m) => m.id),
    );
    const toolUses = fixture.filter(
      (m): m is Extract<SidecarToUIMessage, { type: "tool_use" }> => m.type === "tool_use",
    );
    const toolResults = fixture.filter(
      (m): m is Extract<SidecarToUIMessage, { type: "tool_result" }> => m.type === "tool_result",
    );
    const errors = fixture.filter((m) => m.type === "error");

    const view = conversationMount.querySelector<HTMLElement>(
      `.den-conversation-tab[data-tab-id="${tabId}"]`,
    );
    expect(view).not.toBeNull();

    // Un bloc de message assistant par id distinct de la fixture.
    const assistantBlocks = view!.querySelectorAll(".den-msg-assistant");
    expect(assistantBlocks).toHaveLength(assistantIds.size);

    // Tous les messages assistant sont finalisés (le tour se termine par
    // "done" dans la fixture) : aucun bloc "courant" ne doit rester non vide.
    for (const block of Array.from(assistantBlocks)) {
      const current = block.querySelector(".den-msg-current");
      expect(current?.innerHTML).toBe("");
    }

    // Chaque tool_use non orphelin a bien un bloc <details>, et ceux qui ont
    // reçu un tool_result affichent un .den-tool-result à l'intérieur.
    const toolUseIdsWithResult = new Set(toolResults.map((r) => r.toolUseId));
    for (const toolUse of toolUses) {
      const details = view!.querySelector(`details[data-tool-id="${toolUse.id}"]`);
      expect(details).not.toBeNull();
      if (toolUseIdsWithResult.has(toolUse.id)) {
        expect(details!.querySelector(".den-tool-result")).not.toBeNull();
      }
    }

    // Le tool_result orphelin de la fixture ne doit pas être perdu.
    const orphanResults = toolResults.filter(
      (r) => !toolUses.some((u) => u.id === r.toolUseId),
    );
    const orphanBlocks = view!.querySelectorAll(".den-tool-block-orphan");
    expect(orphanBlocks).toHaveLength(orphanResults.length);

    // Les blocs d'erreur de la fixture sont rendus.
    const errorBlocks = view!.querySelectorAll(".den-error-block");
    expect(errorBlocks).toHaveLength(errors.length);

    // Aucun HTML brut streamé n'a été laissé passer tel quel dans le DOM
    // (cf. échappement dans renderer.ts).
    expect(view!.innerHTML).not.toContain("<script>");
  });

  it("maintient un container par tabId et n'affiche que celui du tab actif", () => {
    const fixture = loadFixture().slice(0, 20);

    emitActiveTabChanged("tab-a");
    for (const message of fixture) {
      emitSessionMessage("tab-a", message);
    }
    emitActiveTabChanged("tab-b");
    for (const message of fixture) {
      emitSessionMessage("tab-b", message);
    }

    const viewA = conversationMount.querySelector<HTMLElement>(
      '.den-conversation-tab[data-tab-id="tab-a"]',
    );
    const viewB = conversationMount.querySelector<HTMLElement>(
      '.den-conversation-tab[data-tab-id="tab-b"]',
    );
    expect(viewA).not.toBeNull();
    expect(viewB).not.toBeNull();
    expect(viewA!.hidden).toBe(true);
    expect(viewB!.hidden).toBe(false);

    emitActiveTabChanged("tab-a");
    expect(viewA!.hidden).toBe(false);
    expect(viewB!.hidden).toBe(true);
  });

  it("mountCustomBlock (API exportée pour la surface interactive) s'intègre dans le flux du bon tab", () => {
    emitActiveTabChanged("tab-custom");
    emitSessionMessage("tab-custom", {
      type: "assistant_delta",
      id: "m1",
      text: "avant le bloc custom",
    });

    const el = mountCustomBlock("tab-custom", {
      id: "custom-1",
      kind: "demo-widget",
      payload: { hello: "world" },
    });
    el.textContent = "widget monté par l'appelant";

    const view = conversationMount.querySelector<HTMLElement>(
      '.den-conversation-tab[data-tab-id="tab-custom"]',
    );
    const block = view!.querySelector('.den-custom-block[data-block-id="custom-1"]');
    expect(block).not.toBeNull();
    expect(block!.textContent).toBe("widget monté par l'appelant");
  });
});
