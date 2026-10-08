import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { SidecarToUIMessage } from "../../src/types/protocol";
import { resolveClaudeBinary } from "./claudeBinary";
import { ModSurface } from "./modSurface";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Contre le vrai claude : lancer avec DEN_E2E_MODS=1 (zéro tour modèle, zéro token).
describe.skipIf(process.env.DEN_E2E_MODS !== "1")("modSurface e2e", () => {
  it("attache la surface et rend un AssistantMessage via les mods utilisateur", async () => {
    const claude = await resolveClaudeBinary(process.env);
    if (!claude.ok) throw new Error(claude.reason);

    const sent: SidecarToUIMessage[] = [];
    const surface = new ModSurface({ send: (m) => sent.push(m) });
    // Prompt qui ne rend jamais la main : aucun tour modèle.
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<never>(() => {});
    })();
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: claude.path,
        spawnClaudeCodeProcess: (o) => surface.spawn(o),
      },
    });
    const drain = (async () => {
      try {
        for await (const _ of q) void _;
      } catch {
        // fermeture en fin de test
      }
    })();

    try {
      for (let i = 0; i < 100 && !surface.attached; i++) await wait(100);
      expect(surface.attached).toBe(true);

      surface.handleUiMessage({
        type: "mod_render",
        requestId: "e2e-1",
        component: "AssistantMessage",
        instanceId: "m1",
        props: { text: "[risque] Test", isFirstOfReply: true },
      });
      for (let i = 0; i < 100 && !sent.some((m) => m.type === "mod_tree"); i++) await wait(100);

      const tree = sent.find((m) => m.type === "mod_tree");
      console.log("mod_tree:", JSON.stringify(tree));
      expect(tree).toMatchObject({ type: "mod_tree", requestId: "e2e-1", hooked: true });
      expect(JSON.stringify((tree as any).tree)).toContain("RISQUE");
    } finally {
      q.close();
      await drain;
    }
  }, 30_000);
});
