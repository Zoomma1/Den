import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// ---------------------------------------------------------------------------
// Sondes DEN-32 lot 0 : prismantis sur 7 surfaces, viewport, commandes, réécriture de props.
// Zéro tour modèle : commandes slash + ui_render direct. Sorties brutes dans src/mods/fixtures/.
// ---------------------------------------------------------------------------

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../src/mods/fixtures");
const PRISMANTIS_DIR = join(homedir(), ".claude/plugins/marketplaces/prismantis");
const haveRoots = existsSync(join(PRISMANTIS_DIR, ".claude-plugin"));

const until = async (done: () => boolean, ms = 15_000) => {
  for (let i = 0; i < ms / 100 && !done(); i++) await wait(100);
  return done();
};

interface Probe {
  surface: ModSurface;
  sent: SidecarToUIMessage[];
  raw: any[];
  sdk: { at: number; message: any }[];
  say(text: string): void;
  close(): Promise<void>;
}

async function openProbe(opts: { settings?: Record<string, unknown> } = {}): Promise<Probe> {
  const claude = await resolveClaudeBinary(process.env);
  if (!claude.ok) throw new Error(claude.reason);
  const sent: SidecarToUIMessage[] = [];
  const raw: any[] = [];
  const sdk: { at: number; message: any }[] = [];
  const t0 = Date.now();
  const surface = new ModSurface({ send: (m) => sent.push(m) });
  const original = surface.handleLine.bind(surface);
  surface.handleLine = (line: string) => {
    try {
      raw.push(JSON.parse(line));
    } catch {
      raw.push({ unparsable: line.slice(0, 200) });
    }
    original(line);
  };

  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      await new Promise<void>((r) => (wake = r));
    }
  })();

  // Les mods de l'utilisateur (settings.json) + prismantis chargé par répertoire, comme le test filetree.
  let userDirs = "";
  try {
    userDirs = JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8")).env?.CLAUDE_CODE_PLUGIN_DIRS ?? "";
  } catch {
    // pas de settings lisibles : prismantis seul
  }
  const pluginDirs = [userDirs, PRISMANTIS_DIR].filter(Boolean).join(":");

  const q = query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: claude.path,
      spawnClaudeCodeProcess: (o) => surface.spawn(o),
      env: { ...process.env, CLAUDE_CODE_PLUGIN_DIRS: pluginDirs },
      ...(opts.settings ? { settings: opts.settings as any } : {}),
    },
  });
  const drain = (async () => {
    try {
      for await (const message of q) sdk.push({ at: Date.now() - t0, message });
    } catch (e) {
      sdk.push({ at: Date.now() - t0, message: { drainError: String(e) } });
    }
  })();

  await until(() => surface.attached, 20_000);
  if (!surface.attached) throw new Error("surface not attached");
  // Laisse les modules de hooks finir de se charger avant la première demande.
  await wait(3_000);

  return {
    surface,
    sent,
    raw,
    sdk,
    say(text) {
      queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
      wake?.();
    },
    async close() {
      q.close();
      await drain;
    },
  };
}

interface RenderRecord {
  label: string;
  request: { component: string; instanceId: string; props: unknown; viewport?: unknown };
  engineResponse: unknown;
  denMessage: unknown;
}

// Requête ui_render écrite telle quelle (ModSurface.handleUiMessage n'envoie pas encore `viewport`).
async function renderRaw(
  p: Probe,
  label: string,
  component: string,
  instanceId: string,
  props: Record<string, unknown>,
  viewport?: { columns: number; rows: number; isFullscreen?: boolean },
): Promise<RenderRecord> {
  const s = p.surface as any;
  const engineId = `den-ui-${s.counter + 1}`;
  const before = p.sent.length;
  s.request(
    "render",
    label,
    {
      subtype: "ui_render",
      surface: "desktop",
      client_id: s.clientId,
      component,
      instance_id: instanceId,
      props,
      ...(viewport ? { viewport } : {}),
    },
    20_000,
  );
  await until(() => p.sent.slice(before).some((m) => m.type === "mod_tree" && m.requestId === label), 25_000);
  const denMessage = p.sent.slice(before).find((m) => m.type === "mod_tree" && m.requestId === label) ?? null;
  const envelope = p.raw.find((o) => o?.type === "control_response" && o.response?.request_id === engineId)?.response;
  // Succès : le résultat du moteur ; erreur : l'enveloppe verbatim (subtype "error" + message).
  const engineResponse = envelope ? (envelope.subtype === "error" ? envelope : envelope.response) : null;
  // Le tree de denMessage dupliquerait engineResponse : on ne garde que ce que ModSurface en fait.
  const den = denMessage as any;
  return {
    label,
    request: { component, instanceId, props, ...(viewport ? { viewport } : {}) },
    engineResponse,
    denMessage: den ? { hooked: den.hooked, rewritten: den.rewritten, ...(den.error ? { error: den.error } : {}), ...(den.clientModules ? { clientModules: den.clientModules } : {}) } : null,
  };
}

const TABLE_MD = "Voici le comparatif :\n\n| Outil | Version | Score |\n| --- | :---: | ---: |\n| vitest | 4.1.11 | 92 |\n| jest | 29.7.0 | 78 |\n\nFin du tableau.";
const CODE_MD = "Exemple :\n\n```ts\nexport function add(a: number, b: number): number {\n  return a + b; // somme\n}\n```\n\nEt du shell :\n\n```bash\nnpm run tauri dev --verbose\n```";
const MERMAID_MD = "Le flux :\n\n```mermaid\nflowchart LR\n  A[UI] --> B[Sidecar]\n  B --> C[Moteur claude]\n  C --> B\n```\n\nVoilà.";

const EDIT_OUTPUT = {
  filePath: "/tmp/den-probe/app.ts",
  oldString: "const total = a + b;",
  newString: "const total = add(a, b);",
  originalFile: "import { add } from './math';\n\nexport function sum(a: number, b: number) {\n  const total = a + b;\n  return total;\n}\n",
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: 6,
      newStart: 1,
      newLines: 6,
      lines: [" import { add } from './math';", " ", " export function sum(a: number, b: number) {", "-  const total = a + b;", "+  const total = add(a, b);", "   return total;", " }"],
    },
  ],
  userModified: false,
  replaceAll: false,
};
const BASH_OUTPUT = { stdout: "total 8\ndrwxr-xr-x  3 vico  staff   96 Oct 14 10:00 .\n-rw-r--r--  1 vico  staff  120 Oct 14 10:00 app.ts\n", stderr: "", interrupted: false };
const READ_OUTPUT = (n: number) => ({ type: "text", file: { filePath: `/tmp/den-probe/f${n}.ts`, content: `export const f${n} = ${n};\n`, numLines: 1, startLine: 1, totalLines: 1 } });
const call = (n: number) => ({ tool_use_id: `toolu_read${n}`, tool: "Read", input: { file_path: `/tmp/den-probe/f${n}.ts` }, isRunning: false, isErrored: false, isInterrupted: false, output: READ_OUTPUT(n) });

const WIDE_TABLE_MD =
  "| Colonne A longue | Colonne B longue | Colonne C longue | Colonne D longue | Colonne E longue |\n| --- | --- | --- | --- | --- |\n" +
  "| valeur assez longue 1 | valeur assez longue 2 | valeur assez longue 3 | valeur assez longue 4 | valeur assez longue 5 |\n" +
  "| autre valeur longue 1 | autre valeur longue 2 | autre valeur longue 3 | autre valeur longue 4 | autre valeur longue 5 |";
const WIDE_MERMAID_MD = "```mermaid\nflowchart LR\n  A[Premiere etape longue] --> B[Deuxieme etape longue] --> C[Troisieme etape longue] --> D[Quatrieme etape longue] --> E[Cinquieme etape longue]\n```";

const RICH_MD = [
  "# Titre H1", "## Titre H2", "### Titre H3", "",
  "Du **gras**, de l'*italique*, du ~~barré~~, du `code inline`, un [lien](https://example.com/a) et une URL https://example.com/b, 99.9% et 250ms, ~/src/app.ts.", "",
  "- item un", "  - sous-item", "- [x] fait", "- [ ] à faire", "", "1. premier", "2. second", "",
  "> citation simple", "", "> [!WARNING]", "> attention", "", "---", "",
  "Note[^1].", "", "[^1]: la note.", "",
  "```figure", "{dim:avant} -> {green:après}", "```", "",
  "```json", '{ "a": 1 }', "```",
].join("\n");
const DIAGRAMS_MD = [
  "```mermaid", "sequenceDiagram", "  participant U as You", "  participant C as Claude", "  U->>C: prompt", "  C-->>U: reply", "```", "",
  "```mermaid", "xychart-beta", '  title "Barres"', "  x-axis [a, b, c]", '  y-axis "n" 0 --> 8', "  bar [3, 5, 2]", "```", "",
  "$$", "\\int_0^1 x\\,dx = \\frac12", "$$",
].join("\n");

const INPUTS: { name: string; component: string; props: Record<string, unknown> }[] = [
  { name: "assistant-table", component: "AssistantMessage", props: { text: TABLE_MD, isFirstOfReply: true } },
  { name: "assistant-code", component: "AssistantMessage", props: { text: CODE_MD, isFirstOfReply: false } },
  { name: "assistant-mermaid", component: "AssistantMessage", props: { text: MERMAID_MD, isFirstOfReply: true } },
  { name: "assistant-widetable", component: "AssistantMessage", props: { text: WIDE_TABLE_MD, isFirstOfReply: true } },
  { name: "assistant-widemermaid", component: "AssistantMessage", props: { text: WIDE_MERMAID_MD, isFirstOfReply: true } },
  { name: "assistant-rich", component: "AssistantMessage", props: { text: RICH_MD, isFirstOfReply: true } },
  { name: "assistant-diagrams", component: "AssistantMessage", props: { text: DIAGRAMS_MD, isFirstOfReply: false } },
  { name: "toolresult-edit", component: "ToolResult", props: { tool_use_id: "toolu_edit1", tool: "Edit", output: EDIT_OUTPUT, isErrored: false } },
  { name: "toolresult-bash", component: "ToolResult", props: { tool_use_id: "toolu_bash1", tool: "Bash", output: BASH_OUTPUT, isErrored: false } },
  { name: "usermessage", component: "UserMessage", props: { text: "Peux-tu corriger le bug de somme ?", origin: { kind: "composer" }, isExpanded: true } },
  { name: "tooluse-bash", component: "ToolUse", props: { tool_use_id: "toolu_bash1", tool: "Bash", input: { command: "ls -la", description: "Liste le dossier" }, isRunning: false, isErrored: false, isInterrupted: false, output: BASH_OUTPUT } },
  { name: "tooluse-edit", component: "ToolUse", props: { tool_use_id: "toolu_edit1", tool: "Edit", input: { file_path: "/tmp/den-probe/app.ts", old_string: "a + b", new_string: "add(a, b)" }, isRunning: false, isErrored: false, isInterrupted: false, output: EDIT_OUTPUT } },
  { name: "toolgroup-read3", component: "ToolGroup", props: { calls: [call(1), call(2), call(3)], isActive: false, isExpanded: false } },
  { name: "commandoutput", component: "CommandOutput", props: { command: "cost", args: "", text: "Total cost: $0.12\n\n| Modèle | Tokens |\n| --- | --- |\n| sonnet | 1200 |", isErrored: false } },
  { name: "turnduration", component: "TurnDuration", props: { word: "Baked", durationMs: 6340 } },
];

const VARIANTS: { id: string; viewport?: { columns: number; rows: number; isFullscreen?: boolean } }[] = [
  { id: "noviewport" },
  { id: "c96", viewport: { columns: 96, rows: 40, isFullscreen: false } },
  { id: "c120", viewport: { columns: 120, rows: 40, isFullscreen: false } },
  { id: "c60", viewport: { columns: 60, rows: 40, isFullscreen: false } },
  { id: "c120fs", viewport: { columns: 120, rows: 40, isFullscreen: true } },
];

// --- Analyse des arbres : types d'éléments et clés de props réellement vus -------------------------------
type Census = Record<string, { count: number; props: Record<string, { count: number; samples: string[] }>; hasPress: number; hasClient: number; childKinds: Record<string, number> }>;

function censusOf(tree: unknown, into: Census): void {
  if (typeof tree === "string" || tree === null || typeof tree !== "object") return;
  const node = tree as any;
  if (typeof node.type !== "string") return;
  const entry = (into[node.type] ??= { count: 0, props: {}, hasPress: 0, hasClient: 0, childKinds: {} });
  entry.count++;
  if (node.press) entry.hasPress++;
  if (node.client) entry.hasClient++;
  for (const [k, v] of Object.entries(node.props ?? {})) {
    const slot = (entry.props[k] ??= { count: 0, samples: [] });
    slot.count++;
    const sample = JSON.stringify(v)?.slice(0, 60) ?? "undefined";
    if (slot.samples.length < 4 && !slot.samples.includes(sample)) slot.samples.push(sample);
  }
  for (const c of node.children ?? []) {
    const kind = typeof c === "string" ? "string" : Array.isArray(c) ? "array" : (c?.type ?? "?");
    entry.childKinds[kind] = (entry.childKinds[kind] ?? 0) + 1;
    if (Array.isArray(c)) c.forEach((x) => censusOf(x, into));
    else censusOf(c, into);
  }
}

const summarize = (r: RenderRecord) => {
  const resp = r.engineResponse as any;
  const tree = resp?.tree;
  return {
    label: r.label,
    hooked: resp?.hooked ?? null,
    rewritten: resp?.rewritten ?? null,
    treeType: tree ? (tree.type === "engine" ? `engine#${tree.ref}` : tree.type) : tree === null ? "null" : "absent",
    propsReturned: resp && "props" in resp ? "yes" : "no",
    error: resp?.subtype === "error" || !resp ? (r.denMessage as any)?.error ?? resp ?? "no engine response" : undefined,
  };
};

const writeNdjson = (name: string, rows: unknown[]) => writeFileSync(join(FIXTURES, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

describe.skipIf(process.env.DEN_E2E_MODS !== "1" || !haveRoots)("sondes prismantis (DEN-32 lot 0)", () => {
  it("matrice des 7 surfaces x viewport, TurnDuration, seuil files-pane 143/144", async () => {
    const p = await openProbe();
    const records: RenderRecord[] = [];
    try {
      for (const input of INPUTS) {
        for (const v of VARIANTS) {
          records.push(await renderRaw(p, `${input.name}:${v.id}`, input.component, `${input.name}-${v.id}`, input.props, v.viewport));
        }
      }
      // Seuil files-pane : ToolResult Edit à 143 puis 144 colonnes (fichier hors vault).
      for (const columns of [143, 144]) {
        records.push(
          await renderRaw(p, `toolresult-edit:c${columns}`, "ToolResult", `toolresult-edit-c${columns}`, INPUTS.find((i) => i.name === "toolresult-edit")!.props, { columns, rows: 40, isFullscreen: false }),
        );
      }
      // Même Edit avec un fichier du vault : files-pane doit garder le diff même à 144.
      records.push(
        await renderRaw(p, "toolresult-edit-vault:c144", "ToolResult", "toolresult-edit-vault-c144", {
          ...INPUTS.find((i) => i.name === "toolresult-edit")!.props,
          output: { ...EDIT_OUTPUT, filePath: join(homedir(), "Vaults/Tha vault/note.md") },
        }, { columns: 144, rows: 40, isFullscreen: false }),
      );

      const roster = p.sent.filter((m) => m.type === "mod_panes").length;
      writeNdjson("prismantis-render-matrix.ndjson", records);
      const summaries = records.map(summarize);
      console.log("MATRIX\n" + summaries.map((s) => JSON.stringify(s)).join("\n"));

      const census: Census = {};
      for (const r of records) censusOf((r.engineResponse as any)?.tree, census);
      const sorted = Object.fromEntries(Object.entries(census).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(join(FIXTURES, "prismantis-element-types.json"), JSON.stringify({ source: "prismantis-render-matrix.ndjson", panesPushes: roster, census: sorted }, null, 2) + "\n");
      console.log("ELEMENTS", Object.entries(sorted).map(([t, e]) => `${t}(${e.count}): ${Object.keys(e.props).join(",")}`).join(" | "));

      expect(records.length).toBeGreaterThan(30);
    } finally {
      await p.close();
    }
  }, 300_000);

  it("/prismantis demo (commande de mod) et /cost (commande locale native) : forme des messages SDK", async () => {
    const p = await openProbe();
    try {
      const run = async (cmd: string) => {
        const startSdk = p.sdk.length;
        const startRaw = p.raw.length;
        p.say(cmd);
        // Pas de tour modèle attendu : on attend un result, sinon 25 s de silence.
        const gotResult = await until(() => p.sdk.slice(startSdk).some((e) => e.message?.type === "result"), 25_000);
        await wait(2_000);
        return { cmd, gotResult, sdk: p.sdk.slice(startSdk), raw: p.raw.slice(startRaw) };
      };
      const results = [await run("/prismantis demo"), await run("/cost")];

      const shape = (e: { at: number; message: any }) => {
        const m = e.message;
        return { at: e.at, type: m?.type, subtype: m?.subtype, keys: Object.keys(m ?? {}), contentLen: typeof m?.content === "string" ? m.content.length : undefined };
      };
      for (const r of results) {
        console.log(`CMD ${r.cmd} result=${r.gotResult}\n` + r.sdk.map((e) => JSON.stringify(shape(e))).join("\n"));
      }
      // Fixture brute : on retire les messages `system/init` (chemins, outils) et on tronque les gros contenus.
      // /cost porte les quotas et l'activité du compte : on ne garde que sa forme, pas son texte.
      const redact = (cmd: string, m: any) =>
        cmd === "/cost"
          ? JSON.parse(JSON.stringify(m, (k, v) => (k === "usage_report" ? "[redacted]" : typeof v === "string" && v.length > 40 ? `[redacted ${v.length} chars]` : v)))
          : m;
      const clip = (m: any) => JSON.parse(JSON.stringify(m, (_k, v) => (typeof v === "string" && v.length > 6000 ? `${v.slice(0, 6000)}…[tronqué ${v.length}]` : v)));
      writeNdjson(
        "prismantis-commands.ndjson",
        results.flatMap((r) =>
          r.sdk
            .filter((e) => !(e.message?.type === "system" && e.message?.subtype === "init"))
            .map((e) => ({ command: r.cmd, atMs: e.at, message: redact(r.cmd, clip(e.message)) })),
        ),
      );
      expect(results.length).toBe(2);
    } finally {
      await p.close();
    }
  }, 120_000);

  it("réécriture de props {engine ref:N, props} : UserMessage avec promptStyle off", async () => {
    const p = await openProbe({ settings: { pluginConfigs: { "prismantis@prismantis": { options: { promptStyle: "off", clock: "24h" } } } } });
    try {
      // Le mod mémorise l'heure d'envoi sur prompt.submit : on soumet une commande, puis on redessine ce texte.
      p.say("/prismantis demo");
      await until(() => p.sdk.some((e) => e.message?.type === "result"), 25_000);
      await wait(1_500);
      const records: RenderRecord[] = [];
      for (const [i, text] of ["/prismantis demo", "Peux-tu corriger le bug de somme ?"].entries()) {
        records.push(
          await renderRaw(p, `usermessage-rewrite:${i}`, "UserMessage", `usermessage-rewrite-${i}`, { text, origin: { kind: "composer" }, isExpanded: true }),
        );
      }
      // Chemins qui finissent par `next(e)` dans prismantis : on mesure ce que le moteur renvoie pour un passage sans dessin.
      const passthrough: [string, string, Record<string, unknown>][] = [
        ["toolresult-read", "ToolResult", { tool_use_id: "toolu_read1", tool: "Read", output: READ_OUTPUT(1), isErrored: false }],
        ["toolresult-edit-errored", "ToolResult", { tool_use_id: "toolu_edit9", tool: "Edit", output: "Error: string not found", isErrored: true }],
        ["commandoutput-errored", "CommandOutput", { command: "cost", args: "", text: "Boom", isErrored: true }],
        ["usermessage-peer", "UserMessage", { text: "Message d'une autre session", origin: { kind: "peer" }, isExpanded: false }],
        ["toolgroup-expanded", "ToolGroup", { calls: [call(1), call(2), call(3)], isActive: false, isExpanded: true }],
        ["tooluse-read-after-expanded", "ToolUse", { tool_use_id: "toolu_read1", tool: "Read", input: { file_path: "/tmp/den-probe/f1.ts" }, isRunning: false, isErrored: false, isInterrupted: false, output: READ_OUTPUT(1) }],
        ["assistant-plain", "AssistantMessage", { text: "Bonjour.", isFirstOfReply: true }],
      ];
      for (const [name, component, props] of passthrough) records.push(await renderRaw(p, `passthrough:${name}`, component, `passthrough-${name}`, props));
      writeNdjson("prismantis-props-rewrite.ndjson", records);
      console.log("REWRITE\n" + records.map((r) => JSON.stringify({ summary: summarize(r), response: r.engineResponse })).join("\n"));
    } finally {
      await p.close();
    }
  }, 120_000);
});
