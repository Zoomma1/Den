import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { SidecarToUIMessage } from "../../src/types/protocol";
import { resolveClaudeBinary } from "./claudeBinary";
import { ModSurface } from "./modSurface";

// Plugin tiers installé sur la machine : jamais copié dans le dépôt, test sauté s'il manque.
const FILETREE_ROOT = join(homedir(), ".claude/plugins/cache/claude-code-filetree/filetree");
const filetreeDir = existsSync(FILETREE_ROOT)
  ? readdirSync(FILETREE_ROOT).sort().reverse().map((v) => join(FILETREE_ROOT, v)).find((d) => existsSync(join(d, ".claude-plugin")))
  : undefined;

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

      surface.handlePaneAction({ type: "mod_pane_action", requestId: "e2e-roster", action: "roster" });
      for (let i = 0; i < 100 && !sent.some((m) => m.type === "mod_result"); i++) await wait(100);
      const roster = sent.find((m) => m.type === "mod_result");
      console.log("roster:", JSON.stringify(roster), JSON.stringify(sent.find((m) => m.type === "mod_panes")));
      expect(roster).toMatchObject({ type: "mod_result", requestId: "e2e-roster", handled: true });

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

  it.skipIf(!filetreeDir)("charge le bundle Client d'un vrai plugin de panneau de fichiers", async () => {
    const claude = await resolveClaudeBinary(process.env);
    if (!claude.ok) throw new Error(claude.reason);

    const sent: SidecarToUIMessage[] = [];
    const surface = new ModSurface({ send: (m) => sent.push(m) });
    const command: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: "/filetree" },
      parent_tool_use_id: null,
      session_id: "",
    };
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      yield command;
      await new Promise<never>(() => {});
    })();
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: claude.path,
        spawnClaudeCodeProcess: (o) => surface.spawn(o),
        env: { ...process.env, CLAUDE_CODE_PLUGIN_DIRS: filetreeDir },
      },
    });
    const drain = (async () => {
      try {
        for await (const _ of q) void _;
      } catch {
        // fermeture en fin de test
      }
    })();
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 150 && !done(); i++) await wait(100);
    };

    try {
      await until(() => surface.attached);
      expect(surface.attached).toBe(true);

      await until(() => sent.some((m) => m.type === "mod_panes" && m.panes.some((p) => p.plugin === "filetree")));
      const panes = [...sent].reverse().find((m) => m.type === "mod_panes" && m.panes.some((p) => p.plugin === "filetree"));
      expect(panes).toBeDefined();
      const pane = (panes as any).panes.find((p: any) => p.plugin === "filetree");

      surface.handleUiMessage({
        type: "mod_render",
        requestId: "e2e-pane",
        component: "Pane",
        instanceId: pane.id,
        props: { title: pane.title, isFocused: true, bodyColumns: 60, placement: "dock", scroll: { offset: 0, bodyRows: 30 }, view: {} },
      });
      await until(() => sent.some((m) => m.type === "mod_tree"));
      const tree = sent.find((m) => m.type === "mod_tree") as any;
      console.log("clientModules:", JSON.stringify(tree?.clientModules), "error:", tree?.error);
      expect(tree.clientModules).toHaveProperty("filetree");

      surface.handleClientModule({ type: "mod_client_module", requestId: "e2e-bundle", plugin: "filetree" });
      await until(() => sent.some((m) => m.type === "mod_client_module_result"));
      const result = sent.find((m) => m.type === "mod_client_module_result") as any;
      console.log("bundle:", result.ok, result.bundle?.hash, result.bundle?.runtime, result.bundle?.files.map((f: any) => `${f.key} (${f.source.length})`), result.error);
      expect(result.ok).toBe(true);
      expect(result.bundle.files.length).toBeGreaterThanOrEqual(3);
      expect(result.bundle.files.map((f: any) => f.key)).toContain("claude:surface-runtime");
    } finally {
      q.close();
      await drain;
    }
  }, 40_000);
});
