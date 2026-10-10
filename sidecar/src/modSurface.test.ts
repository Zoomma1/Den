import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarToUIMessage } from "../../src/types/protocol";
import { ModSurface } from "./modSurface";

const fixture = (name: string) =>
  readFileSync(new URL(`../../src/mods/fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);

const responses = [...fixture("responses-render.ndjson"), ...fixture("responses-pane-handoff.ndjson")];
const pushes = fixture("pushes.ndjson");
const panesLines = fixture("run2-panes.ndjson").map((l) => JSON.parse(l));
const [copyRequest] = fixture("run2-copy.ndjson").map((l) => JSON.parse(l));

const paneResponse = (id: string) => panesLines.find((o) => o.response?.request_id === id)!;

/** Ligne de fixture dont le request_id est remplacé par celui réellement émis. */
function respondLike(fixtureId: string, requestId: string): string {
  const line = responses.find((l) => l.includes(`"${fixtureId}"`))!;
  return line.replace(`"${fixtureId}"`, `"${requestId}"`);
}

function setup(attach = true) {
  const sent: SidecarToUIMessage[] = [];
  const written: any[] = [];
  const surface = new ModSurface({
    send: (m) => sent.push(m),
    write: (l) => written.push(JSON.parse(l)),
    timeoutMs: 1000,
  });
  if (attach) {
    surface.handleLine('{"type":"system","subtype":"init"}');
    surface.handleLine(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: written[0].request_id, response: { surfaces: ["desktop"] } },
      }),
    );
    // Lecture du roster à l'attache : hors du périmètre des tests de requêtes (indices written[1+]).
    expect(written[1].request.subtype).toBe("ui_panes");
    written.splice(1, 1);
  }
  return { surface, sent, written };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("attache", () => {
  it("envoie ui_attach à la première ligne, une seule fois", () => {
    const { surface, written } = setup(false);
    surface.handleLine('{"type":"system","subtype":"init"}');
    surface.handleLine('{"type":"system","subtype":"status"}');
    expect(written).toHaveLength(1);
    expect(written[0].request.subtype).toBe("ui_attach");
    expect(written[0].request.surface).toBe("desktop");
    expect(written[0].request.answers).toEqual(["ui_copy"]);
    expect(written[0].request.client_id).toMatch(/^den-\d+$/);
    expect(written[0].request_id).toMatch(/^den-ui-/);
  });

  it("réessaie une fois sur erreur puis abandonne", () => {
    const { surface, written } = setup(false);
    surface.handleLine("{}");
    const err = () =>
      surface.handleLine(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "error", request_id: written[0].request_id, error: "nope" },
        }),
      );
    err();
    expect(written).toHaveLength(2);
    err();
    expect(written).toHaveLength(2);
    expect(surface.attached).toBe(false);
  });

  it("répond en erreur sans surface attachée", () => {
    const { surface, sent, written } = setup(false);
    surface.handleUiMessage({ type: "mod_render", requestId: "r1", component: "Pane", instanceId: "p", props: {} });
    surface.handleUiMessage({ type: "mod_press", requestId: "r2", plugin: "x", handle: 1 });
    expect(sent).toEqual([
      { type: "mod_tree", requestId: "r1", tree: null, hooked: false, rewritten: false, error: "surface not attached" },
      { type: "mod_result", requestId: "r2", handled: false, error: "surface not attached" },
    ]);
    expect(written).toHaveLength(0);
  });
});

describe("requêtes UI -> moteur", () => {
  it("mod_render -> ui_render, réponse mod_tree avec l'id de l'UI", () => {
    const { surface, sent, written } = setup();
    surface.handleUiMessage({
      type: "mod_render",
      requestId: "ui-7",
      component: "AssistantMessage",
      instanceId: "m1",
      props: { text: "[risque] x", isFirstOfReply: true },
    });
    const req = written[1];
    expect(req.request_id).toMatch(/^den-ui-/);
    expect(req.request).toMatchObject({
      subtype: "ui_render",
      surface: "desktop",
      component: "AssistantMessage",
      instance_id: "m1",
      props: { text: "[risque] x", isFirstOfReply: true },
    });
    expect(req.request.client_id).toBe(written[0].request.client_id);

    surface.handleLine(respondLike("den-ui-assistant", req.request_id));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "mod_tree", requestId: "ui-7", hooked: true, rewritten: false });
    expect(JSON.stringify((sent[0] as any).tree)).toContain("RISQUE");
  });

  it("arbre moteur (ref) relayé tel quel, hooked absent -> false", () => {
    const { surface, sent, written } = setup();
    surface.handleUiMessage({ type: "mod_render", requestId: "a", component: "ToolResult", instanceId: "t", props: {} });
    surface.handleLine(respondLike("den-ui-toolres", written[1].request_id));
    expect(sent[0]).toMatchObject({ type: "mod_tree", requestId: "a", tree: { type: "engine", ref: 0 } });
  });

  it("mod_press -> ui_press, réponse mod_result", () => {
    const { surface, sent, written } = setup();
    surface.handleUiMessage({ type: "mod_press", requestId: "p1", plugin: "handoff-copy", handle: 42, key: "k" });
    expect(written[1].request).toMatchObject({ subtype: "ui_press", plugin: "handoff-copy", handle: 42, key: "k" });
    surface.handleLine(respondLike("den-ui-later", written[1].request_id));
    expect(sent).toEqual([{ type: "mod_result", requestId: "p1", handled: true, element: "later" }]);
  });

  it("mod_input -> ui_input avec instance_id", () => {
    const { surface, sent, written } = setup();
    surface.handleUiMessage({
      type: "mod_input",
      requestId: "i1",
      plugin: "p",
      handle: 3,
      kind: "submit",
      value: "mon focus",
      component: "Pane",
      instanceId: "files-pane",
    });
    expect(written[1].request).toMatchObject({
      subtype: "ui_input",
      kind: "submit",
      value: "mon focus",
      component: "Pane",
      instance_id: "files-pane",
    });
    surface.handleLine(respondLike("den-ui-in", written[1].request_id));
    expect(sent).toEqual([
      { type: "mod_result", requestId: "i1", handled: true, element: "focus", value: "mon focus" },
    ]);
  });

  it("mod_select -> ui_select", () => {
    const { surface, written } = setup();
    surface.handleUiMessage({ type: "mod_select", requestId: "s1", plugin: "p", handle: 9, value: "b" });
    expect(written[1].request).toMatchObject({ subtype: "ui_select", plugin: "p", handle: 9, value: "b" });
  });

  it("une erreur du moteur devient error sur mod_tree / mod_result", () => {
    const { surface, sent, written } = setup();
    surface.handleUiMessage({ type: "mod_render", requestId: "r", component: "Pane", instanceId: "p", props: {} });
    surface.handleUiMessage({ type: "mod_press", requestId: "q", plugin: "p", handle: 1 });
    for (const w of written.slice(1)) {
      surface.handleLine(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "error", request_id: w.request_id, error: "boom" },
        }),
      );
    }
    expect(sent).toEqual([
      { type: "mod_tree", requestId: "r", tree: null, hooked: false, rewritten: false, error: "boom" },
      { type: "mod_result", requestId: "q", handled: false, error: "boom" },
    ]);
  });

  it("timeout -> réponse en erreur, réponse tardive ignorée", () => {
    const { surface, sent, written } = setup();
    surface.handleUiMessage({ type: "mod_render", requestId: "t", component: "Pane", instanceId: "p", props: {} });
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([
      { type: "mod_tree", requestId: "t", tree: null, hooked: false, rewritten: false, error: "timeout" },
    ]);
    surface.handleLine(respondLike("den-ui-later", written[1].request_id));
    expect(sent).toHaveLength(1);
  });

  it("press/input/select attendent 120 s, les rendus 10 s", () => {
    const surface = new ModSurface({ send: (m) => sent.push(m), write: () => {} });
    const sent: SidecarToUIMessage[] = [];
    surface.handleLine("{}");
    surface.handleLine(
      JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "den-ui-attach" } }),
    );
    surface.handleUiMessage({ type: "mod_press", requestId: "p", plugin: "x", handle: 1 });
    surface.handleUiMessage({ type: "mod_render", requestId: "r", component: "Pane", instanceId: "p", props: {} });
    vi.advanceTimersByTime(10_000);
    expect(sent.map((m) => m.type)).toEqual(["mod_tree"]);
    vi.advanceTimersByTime(109_999);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent[1]).toEqual({ type: "mod_result", requestId: "p", handled: false, error: "timeout" });
  });

  it("corrèle plusieurs requêtes en vol dans le désordre", () => {
    const { surface, sent, written } = setup();
    surface.handleUiMessage({ type: "mod_press", requestId: "A", plugin: "p", handle: 1 });
    surface.handleUiMessage({ type: "mod_press", requestId: "B", plugin: "p", handle: 2 });
    surface.handleLine(respondLike("den-ui-in", written[2].request_id));
    surface.handleLine(respondLike("den-ui-later", written[1].request_id));
    expect(sent.map((m) => (m as any).requestId)).toEqual(["B", "A"]);
  });

  it("ignore les control_response qui ne sont pas des den-ui-*", () => {
    const { surface, sent } = setup();
    surface.handleLine('{"type":"control_response","response":{"subtype":"success","request_id":"sdk-1"}}');
    expect(sent).toEqual([]);
  });
});

describe("pushes moteur -> UI (fixtures réelles)", () => {
  it("mappe status, toast, panes, invalidate", () => {
    const { surface, sent } = setup();
    for (const l of pushes) surface.handleLine(l);
    expect(sent).toEqual([
      { type: "mod_status", plugin: "token-weather", text: "☀ Clear 2% · 19k ▁" },
      expect.objectContaining({ type: "mod_toast", plugin: "session-health", timeoutMs: 4000 }),
      {
        type: "mod_panes",
        panes: [{ id: "handoff-copy", title: "Handoff : contexte à 2%", plugin: "handoff-copy", rows: 8 }],
        shownId: "handoff-copy",
        focusedId: null,
        focusRequestedId: null,
      },
      {
        type: "mod_invalidate",
        instances: [{ component: "Pane", instanceId: "handoff-copy" }],
      },
      { type: "mod_panes", panes: [], shownId: null, focusedId: null, focusRequestedId: null },
    ]);
  });

  it("ignore lignes invalides et messages non-mods", () => {
    const { surface, sent } = setup();
    surface.handleLine("pas du json");
    surface.handleLine('{"type":"assistant"}');
    surface.handleLine('{"type":"system","subtype":"init"}');
    expect(sent).toEqual([]);
  });
});

describe("ModSurface.spawn", () => {
  it("vide stderr du processus : un flot > 64 Ko ne le bloque pas", async () => {
    const surface = new ModSurface({ send: () => {} });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const child = surface.spawn({
      command: process.execPath,
      args: ["-e", "process.stderr.write('x'.repeat(300000))"],
      env: process.env,
      signal: new AbortController().signal,
    });
    const exited = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 5000);
    });
    expect(await exited).toBe(true);
    stderr.mockRestore();
  });
});

describe("panes (fixtures run 2)", () => {
  const rosterResponse = (id: string) => JSON.stringify(paneResponse("den-ui-roster")).replace("den-ui-roster", id);

  it("mappe le roster en camelCase", () => {
    const { surface, sent, written } = setup();
    surface.handlePaneAction({ type: "mod_pane_action", requestId: "k", action: "roster" });
    expect(written[1].request).toMatchObject({ subtype: "ui_panes", client_id: written[0].request.client_id });
    surface.handleLine(rosterResponse(written[1].request_id));
    expect(sent).toEqual([
      {
        type: "mod_panes",
        panes: [
          { id: "files-pane", title: "Files touched", plugin: "files-pane" },
          { id: "daily-todos", title: "Plan du jour", plugin: "daily-todos", closeOnEscape: true },
          { id: "handoff-copy", title: "Handoff : contexte à 2%", plugin: "handoff-copy", rows: 8 },
        ],
        shownId: "handoff-copy",
        focusedId: null,
        focusRequestedId: "daily-todos",
      },
      { type: "mod_result", requestId: "k", handled: true },
    ]);
  });

  it("pousse le roster à l'attache", () => {
    const sent: SidecarToUIMessage[] = [];
    const written: any[] = [];
    const surface = new ModSurface({ send: (m) => sent.push(m), write: (l) => written.push(JSON.parse(l)) });
    surface.handleLine("{}");
    surface.handleLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: written[0].request_id } }));
    surface.handleLine(rosterResponse(written[1].request_id));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "mod_panes", shownId: "handoff-copy" });
  });

  it.each([
    ["show", "ui_pane_show", "den-ui-show", { handled: true, value: "files-pane" }],
    ["focus", "ui_pane_focus", "den-ui-focus", { handled: true, value: "files-pane" }],
    ["close", "ui_close", "den-ui-close", { handled: true }],
  ] as const)("%s -> %s", (action, subtype, fixtureId, expected) => {
    const { surface, sent, written } = setup();
    surface.handlePaneAction({ type: "mod_pane_action", requestId: "a", action, id: "files-pane" });
    expect(written[1].request).toMatchObject({ subtype, id: "files-pane" });
    surface.handleLine(JSON.stringify(paneResponse(fixtureId)).replace(fixtureId, written[1].request_id));
    expect(sent).toEqual([{ type: "mod_result", requestId: "a", ...expected }]);
  });

  it("close avec closed:false -> handled false ; erreur et non attaché propagés", () => {
    const { surface, sent, written } = setup();
    surface.handlePaneAction({ type: "mod_pane_action", requestId: "a", action: "close", id: "x" });
    surface.handleLine(
      JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: written[1].request_id, response: { closed: false } } }),
    );
    expect(sent).toEqual([{ type: "mod_result", requestId: "a", handled: false }]);

    const cold = setup(false);
    cold.surface.handlePaneAction({ type: "mod_pane_action", requestId: "b", action: "show", id: "x" });
    expect(cold.sent).toEqual([{ type: "mod_result", requestId: "b", handled: false, error: "surface not attached" }]);
  });

  it("timeout des actions de pane à 10 s", () => {
    const sent: SidecarToUIMessage[] = [];
    const surface = new ModSurface({ send: (m) => sent.push(m), write: () => {} });
    surface.handleLine("{}");
    surface.handleLine(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "den-ui-attach" } }));
    surface.handlePaneAction({ type: "mod_pane_action", requestId: "t", action: "show", id: "x" });
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([{ type: "mod_result", requestId: "t", handled: false, error: "timeout" }]);
  });
});

describe("ui_copy (fixtures run 2)", () => {
  const engineId = copyRequest.request_id;
  const copyReplies = (written: any[]) => written.filter((w) => w.type === "control_response");

  it("relaie en mod_copy_request puis répond au retour de l'UI", () => {
    const { surface, sent, written } = setup();
    surface.handleLine(JSON.stringify(copyRequest));
    expect(sent).toEqual([{ type: "mod_copy_request", requestId: engineId, text: "<texte du handoff>" }]);
    surface.handleCopyResult({ type: "mod_copy_result", requestId: engineId, copied: true });
    expect(copyReplies(written)).toEqual([fixture("run2-copy.ndjson").map((l) => JSON.parse(l))[1]]);
  });

  it("répond copied:false après 4 s sans réponse de l'UI, une seule fois", () => {
    const { surface, written } = setup();
    surface.handleLine(JSON.stringify(copyRequest));
    vi.advanceTimersByTime(3_999);
    expect(copyReplies(written)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(copyReplies(written)).toEqual([
      { type: "control_response", response: { subtype: "success", request_id: engineId, response: { copied: false } } },
    ]);
    surface.handleCopyResult({ type: "mod_copy_result", requestId: engineId, copied: true });
    expect(copyReplies(written)).toHaveLength(1);
  });

  it("ignore un mod_copy_result inconnu ou déjà traité", () => {
    const { surface, written } = setup();
    surface.handleCopyResult({ type: "mod_copy_result", requestId: "nope", copied: true });
    surface.handleLine(JSON.stringify(copyRequest));
    surface.handleCopyResult({ type: "mod_copy_result", requestId: engineId, copied: true });
    surface.handleCopyResult({ type: "mod_copy_result", requestId: engineId, copied: false });
    vi.advanceTimersByTime(10_000);
    expect(copyReplies(written)).toHaveLength(1);
  });

  it("ne touche à aucun autre control_request", () => {
    const { surface, sent, written } = setup();
    const before = written.length;
    surface.handleLine(
      JSON.stringify({ type: "control_request", request_id: "sdk-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }),
    );
    surface.handleLine(
      JSON.stringify({ type: "control_request", request_id: "sdk-2", request: { subtype: "ui_other", text: "x" } }),
    );
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    expect(written).toHaveLength(before);
  });
});
