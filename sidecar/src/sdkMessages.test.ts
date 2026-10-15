import { describe, expect, it } from "vitest";
import { commandOutputOf, durationMsOf, subagentReportOf, subagentStepsOf, subagentUpdateOf, toolResultsOf } from "./sdkMessages";

const user = (blocks: any[], tool_use_result?: unknown) => ({
  message: { content: blocks },
  tool_use_result,
});
const tr = (id: string) => ({ type: "tool_result", tool_use_id: id, content: `out-${id}` });

describe("toolResultsOf", () => {
  it("un bloc : tool_use_result attaché", () => {
    expect(toolResultsOf(user([tr("a")], { x: 1 }))).toEqual([
      { toolUseId: "a", output: "out-a", structured: { x: 1 }, isError: undefined },
    ]);
  });
  it("un bloc sans tool_use_result : pas de structured", () => {
    expect(toolResultsOf(user([tr("a")]))[0]).not.toHaveProperty("structured");
  });
  it("N blocs + tableau de même longueur : par index", () => {
    const r = toolResultsOf(user([tr("a"), tr("b")], [{ n: 1 }, { n: 2 }]));
    expect(r.map((x) => x.structured)).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("N blocs sans tableau (ou longueur différente) : repli sur la sortie brute", () => {
    for (const t of [{ n: 1 }, [{ n: 1 }]]) {
      const r = toolResultsOf(user([tr("a"), tr("b")], t));
      expect(r).toHaveLength(2);
      expect(r[0]).not.toHaveProperty("structured");
      expect(r[1].output).toBe("out-b");
    }
  });
  it("contenu texte ou blocs non tool_result ignorés", () => {
    expect(toolResultsOf({ message: { content: "hi" } })).toEqual([]);
    expect(toolResultsOf(user([{ type: "text", text: "x" }]))).toEqual([]);
  });
});

describe("commandOutputOf", () => {
  const base = (extra: any) => ({
    type: "assistant",
    message: { model: "<synthetic>", content: [{ type: "text", text: "contenu" }] },
    ...extra,
  });
  it("retire l'enveloppe de local_command_source", () => {
    const m = base({
      local_command_source: "<local-command-stdout>sortie\nligne 2</local-command-stdout>",
      local_command_run: { command: "prismantis", args: "demo" },
    });
    expect(commandOutputOf(m)).toEqual({ command: "prismantis", args: "demo", text: "sortie\nligne 2" });
  });
  it("sans enveloppe : texte brut ; sans source : contenu du message", () => {
    const run = { command: "usage", args: "" };
    expect(commandOutputOf(base({ local_command_source: "brut", local_command_run: run }))?.text).toBe("brut");
    expect(commandOutputOf(base({ local_command_run: run }))?.text).toBe("contenu");
  });
  it("message non-commande -> null", () => {
    expect(commandOutputOf(base({}))).toBeNull();
    expect(commandOutputOf({ type: "user" })).toBeNull();
    expect(commandOutputOf({ type: "result" })).toBeNull();
  });
});

describe("durationMsOf", () => {
  it("renvoie la durée d'un tour qui a travaillé", () => {
    expect(durationMsOf({ duration_ms: 6340, num_turns: 2 })).toBe(6340);
  });

  it("pas de durée pour un result à 0 tour (commande slash)", () => {
    expect(durationMsOf({ duration_ms: 3, num_turns: 0 })).toBeUndefined();
  });

  it("pas de durée si duration_ms est absent", () => {
    expect(durationMsOf({ num_turns: 1 })).toBeUndefined();
  });
});

describe("subagentUpdateOf", () => {
  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "t1",
    tool_use_id: "toolu_A",
    description: "Lire package.json",
    subagent_type: "Explore",
    is_backgrounded: false,
    task_type: "local_agent",
  };

  it("task_started : running, mémorisé", () => {
    const known = new Set<string>();
    expect(subagentUpdateOf(started, known)).toEqual({
      type: "subagent_update",
      taskId: "t1",
      status: "running",
      toolUseId: "toolu_A",
      description: "Lire package.json",
      subagentType: "Explore",
      isBackgrounded: false,
    });
    expect(known.has("t1")).toBe(true);
  });
  it("task_started : prompt et spawnDepth relayés", () => {
    const u = subagentUpdateOf({ ...started, prompt: "do it", spawn_depth: 2 }, new Set());
    expect(u).toMatchObject({ prompt: "do it", spawnDepth: 2 });
  });
  it("task_started ambient, skip_transcript ou task_type étranger : ignoré et non mémorisé", () => {
    for (const extra of [{ ambient: true }, { skip_transcript: true }, { task_type: "local_bash" }]) {
      const known = new Set<string>();
      expect(subagentUpdateOf({ ...started, ...extra }, known)).toBeNull();
      expect(known.size).toBe(0);
    }
  });
  it("task_progress : sa description (« Running cat ») n'est jamais relayée", () => {
    const msg = {
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      description: "Running cat",
      usage: { total_tokens: 22066, tool_uses: 1, duration_ms: 2704 },
      last_tool_name: "Bash",
    };
    expect(subagentUpdateOf(msg, new Set(["t1"]))).toEqual({
      type: "subagent_update",
      taskId: "t1",
      status: "running",
      lastToolName: "Bash",
      usage: { totalTokens: 22066, toolUses: 1, durationMs: 2704 },
    });
  });
  it("task_progress de task_id inconnu : ignoré", () => {
    expect(subagentUpdateOf({ type: "system", subtype: "task_progress", task_id: "zz" }, new Set())).toBeNull();
  });
  it("task_updated : patch.status mappé, clés absentes omises", () => {
    const known = new Set(["t1"]);
    const upd = (status: string) =>
      subagentUpdateOf({ type: "system", subtype: "task_updated", task_id: "t1", patch: { status } }, known);
    expect(upd("completed")).toEqual({ type: "subagent_update", taskId: "t1", status: "completed" });
    expect(upd("killed")?.status).toBe("stopped");
    expect(upd("paused")?.status).toBe("running");
    expect(upd("failed")?.status).toBe("failed");
  });
  it("task_notification : status tel quel", () => {
    const msg = { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_A", status: "failed" };
    expect(subagentUpdateOf(msg, new Set(["t1"]))).toEqual({
      type: "subagent_update",
      taskId: "t1",
      status: "failed",
      toolUseId: "toolu_A",
    });
  });
  it("task_notification : statut hors table (ou « constructor ») -> clé status omise", () => {
    for (const status of ["killed-ish", "constructor"]) {
      const msg = { type: "system", subtype: "task_notification", task_id: "t1", status };
      expect(subagentUpdateOf(msg, new Set(["t1"]))).toEqual({ type: "subagent_update", taskId: "t1" });
    }
  });
});

describe("subagentUpdateOf : workflow (fixtures réelles trimées)", () => {
  const wfStarted = {
    type: "system",
    subtype: "task_started",
    task_id: "wgp3239m1",
    tool_use_id: "toolu_01T2",
    description: "Spike: deux phases",
    task_type: "local_workflow",
    workflow_name: "spike",
  };
  const phases = [
    { type: "workflow_phase", index: 1, title: "Alpha" },
    { type: "workflow_phase", index: 2, title: "Beta" },
  ];
  const agent = (over: object) => ({
    type: "workflow_agent",
    index: 1,
    label: "A1",
    phaseIndex: 1,
    phaseTitle: "Alpha",
    agentId: "ad09251e87010ae33",
    model: "claude-sonnet-5-5",
    state: "progress",
    startedAt: 1792052634047,
    queuedAt: 1792052634045,
    attempt: 1,
    promptPreview: 'Reply with the single word "ok-A1". Use no tools.',
    tokens: 30191,
    toolCalls: 0,
    ...over,
  });
  const progress = (workflow_progress: unknown) => ({
    type: "system",
    subtype: "task_progress",
    task_id: "wgp3239m1",
    description: "Alpha: A1",
    usage: { total_tokens: 30191, tool_uses: 0, duration_ms: 2619 },
    last_tool_name: "A1",
    workflow_progress,
  });
  const known = () => new Set(["wgp3239m1"]);

  it("task_started : workflowName relayé", () => {
    expect(subagentUpdateOf(wfStarted, new Set())).toMatchObject({ status: "running", workflowName: "spike" });
  });
  it("task_progress nominal (fixture réelle) : A1 démarré, A2 en file, B pas encore lancé", () => {
    const wip = progress([
      ...phases,
      agent({}),
      agent({ index: 2, label: "A2", agentId: "a604", state: "start", startedAt: undefined, toolCalls: undefined, model: "sonnet", promptPreview: 'Reply with the single word "ok-A2". Use no tools.', tokens: undefined }),
      agent({ index: 3, label: "B", phaseIndex: 2, phaseTitle: "Beta", state: "start", promptPreview: "ok-B" }),
    ]);
    expect(subagentUpdateOf(wip, known())?.workflow).toEqual({
      phases: [
        { index: 1, title: "Alpha" },
        { index: 2, title: "Beta" },
      ],
      agents: [
        { index: 1, label: "A1", phaseIndex: 1, state: "running", model: "claude-sonnet-5-5", promptPreview: 'Reply with the single word "ok-A1". Use no tools.', tokens: 30191, toolCalls: 0 },
        { index: 2, label: "A2", phaseIndex: 1, state: "queued", model: "sonnet", promptPreview: 'Reply with the single word "ok-A2". Use no tools.' },
        { index: 3, label: "B", phaseIndex: 2, state: "running", model: "claude-sonnet-5-5", promptPreview: "ok-B", tokens: 30191, toolCalls: 0 },
      ],
    });
  });
  it("task_progress final : tous done", () => {
    const u = subagentUpdateOf(progress([...phases, agent({ state: "done", durationMs: 2630, resultPreview: "ok-A1" })]), known());
    expect(u?.workflow?.agents.map((a) => a.state)).toEqual(["done"]);
    expect(u?.workflow?.agents[0]).toMatchObject({ durationMs: 2630, tokens: 30191, toolCalls: 0, resultPreview: "ok-A1" });
  });
  it("durée, tokens, appels d'outils et résultat invalides : omis", () => {
    const u = subagentUpdateOf(
      progress([...phases, agent({ durationMs: "12", tokens: NaN, toolCalls: Infinity, resultPreview: 5 })]),
      known(),
    );
    const a = u?.workflow?.agents[0] as object;
    for (const k of ["durationMs", "tokens", "toolCalls", "resultPreview"]) expect(a).not.toHaveProperty(k);
  });
  it("valeurs absurdes (négatives, 1e21, toolCalls non entier) : omises", () => {
    const u = subagentUpdateOf(progress([...phases, agent({ durationMs: -90000, tokens: 1e21, toolCalls: 2.5 })]), known());
    const a = u?.workflow?.agents[0] as object;
    for (const k of ["durationMs", "tokens", "toolCalls"]) expect(a).not.toHaveProperty(k);
    const n = subagentUpdateOf(progress([...phases, agent({ durationMs: 0, tokens: 5, toolCalls: -5 })]), known());
    expect(n?.workflow?.agents[0]).toMatchObject({ durationMs: 0, tokens: 5 });
    expect(n?.workflow?.agents[0]).not.toHaveProperty("toolCalls");
  });
  it("échec de script : task_updated failed relayé, derniers agents restent done", () => {
    const u = subagentUpdateOf(
      { type: "system", subtype: "task_updated", task_id: "wgp3239m1", patch: { status: "failed", error: "Error: boom" } },
      known(),
    );
    expect(u).toEqual({ type: "subagent_update", taskId: "wgp3239m1", status: "failed" });
    const n = subagentUpdateOf({ type: "system", subtype: "task_notification", task_id: "wgp3239m1", status: "failed" }, known());
    expect(n?.status).toBe("failed");
  });
  it("états d'erreur ou inconnus : failed / running", () => {
    const states = ["error", "failed", "killed", "stopped", "weird", "toString"];
    const u = subagentUpdateOf(progress(states.map((state, i) => agent({ index: i + 1, state }))), known());
    expect(u?.workflow?.agents.map((a) => a.state)).toEqual(["failed", "failed", "failed", "failed", "running", "running"]);
  });
  it("progress sans workflow_progress : pas de champ workflow", () => {
    expect(subagentUpdateOf(progress(undefined), known())).not.toHaveProperty("workflow");
  });
  it("entrées malformées : ignorées, pas de crash", () => {
    expect(subagentUpdateOf(progress("nope"), known())).not.toHaveProperty("workflow");
    expect(subagentUpdateOf(progress({}), known())).not.toHaveProperty("workflow");
    expect(subagentUpdateOf(progress([]), known())).not.toHaveProperty("workflow");
    expect(subagentUpdateOf(progress([null, 3, {}, { type: "workflow_agent", index: 1 }]), known())).not.toHaveProperty("workflow");
    const u = subagentUpdateOf(
      progress([null, 3, "x", {}, { type: "workflow_phase", index: "1", title: "x" }, { type: "workflow_phase", index: 1 }, { type: "workflow_agent", index: 1 }, { type: "other" }, ...phases, agent({ state: 42, promptPreview: 7, model: null })]),
      known(),
    );
    expect(u?.workflow).toEqual({
      phases: [
        { index: 1, title: "Alpha" },
        { index: 2, title: "Beta" },
      ],
      agents: [{ index: 1, label: "A1", phaseIndex: 1, state: "running", tokens: 30191, toolCalls: 0 }],
    });
  });
});

describe("subagentReportOf", () => {
  const handback = (extra: any = {}) => ({
    type: "assistant",
    parent_tool_use_id: "toolu_A",
    message: { content: [{ type: "tool_use", id: "x", name: "SubagentHandback", input: { message: "# Rapport" } }] },
    ...extra,
  });
  it("extrait le rapport rattaché au tool_use Agent parent", () => {
    expect(subagentReportOf(handback())).toEqual({ type: "subagent_report", toolUseId: "toolu_A", text: "# Rapport" });
  });
  it("null sans parent ou sans SubagentHandback", () => {
    expect(subagentReportOf(handback({ parent_tool_use_id: null }))).toBeNull();
    expect(
      subagentReportOf(handback({ message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } })),
    ).toBeNull();
  });
});

describe("subagentStepsOf", () => {
  const asst = (blocks: any[], parent: string | null = "P") => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: blocks },
  });
  const userMsg = (blocks: any[]) => ({ type: "user", parent_tool_use_id: "P", message: { content: blocks } });
  it("text", () => {
    expect(subagentStepsOf(asst([{ type: "text", text: "hi" }]))).toEqual([
      { type: "subagent_step", parentToolUseId: "P", kind: "text", text: "hi", truncated: false },
    ]);
  });
  it("tool_use : input en JSON", () => {
    expect(subagentStepsOf(asst([{ type: "tool_use", id: "u1", name: "Read", input: { a: 1 } }]))).toEqual([
      { type: "subagent_step", parentToolUseId: "P", kind: "tool_use", name: "Read", toolUseId: "u1", text: '{"a":1}', truncated: false },
    ]);
  });
  it("tool_result : string, blocs text, erreur", () => {
    const s = subagentStepsOf(
      userMsg([
        { type: "tool_result", tool_use_id: "a", content: "ok" },
        { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }], is_error: true },
      ]),
    );
    expect(s[0]).toMatchObject({ kind: "tool_result", toolUseId: "a", text: "ok", isError: false });
    expect(s[1]).toMatchObject({ toolUseId: "b", text: "xy", isError: true });
  });
  it("troncature 4000 (texte, résultat) / 2000 (input)", () => {
    const [t] = subagentStepsOf(asst([{ type: "text", text: "a".repeat(4001) }]));
    expect(t).toMatchObject({ truncated: true });
    expect(t.text).toHaveLength(4000);
    const [u] = subagentStepsOf(asst([{ type: "tool_use", id: "u", name: "X", input: { s: "b".repeat(3000) } }]));
    expect(u).toMatchObject({ truncated: true });
    expect(u.text).toHaveLength(2000);
    const [r] = subagentStepsOf(userMsg([{ type: "tool_result", tool_use_id: "a", content: "c".repeat(5000) }]));
    expect(r).toMatchObject({ truncated: true });
    expect(r.text).toHaveLength(4000);
  });
  it("SubagentHandback ignoré", () => {
    expect(subagentStepsOf(asst([{ type: "tool_use", id: "h", name: "SubagentHandback", input: { message: "m" } }]))).toEqual([]);
  });
  it("le tool_result du SubagentHandback (message suivant) est ignoré aussi", () => {
    const ids = new Set<string>();
    subagentStepsOf(asst([{ type: "tool_use", id: "h", name: "SubagentHandback", input: { message: "m" } }]), ids);
    expect(subagentStepsOf(userMsg([{ type: "tool_result", tool_use_id: "h", content: "ok" }]), ids)).toEqual([]);
    expect(subagentStepsOf(userMsg([{ type: "tool_result", tool_use_id: "other", content: "ok" }]), ids)).toHaveLength(1);
  });
  it("sans parent_tool_use_id : []", () => {
    expect(subagentStepsOf(asst([{ type: "text", text: "hi" }], null))).toEqual([]);
  });
});
