import { describe, expect, it } from "vitest";
import {
  type ConversationMessage,
  type DenProtocolMessage,
  isAssistantDelta,
  isCommands,
  isConversationReset,
  isDone,
  isErrorMessage,
  isInterruptMessage,
  isModeChanged,
  isModClientFault,
  isModClientModule,
  isModClientModuleResult,
  isModClientPress,
  isModMessage,
  isModMessageResult,
  isModClientPressResult,
  isModCopyRequest,
  isModCopyResult,
  isModInput,
  isModInvalidate,
  isModPaneAction,
  isModPanes,
  isModPress,
  isModRender,
  isModResult,
  isModSelect,
  isModStatus,
  isModToast,
  isModTree,
  isModsUnavailable,
  isCommandOutput,
  isPermissionRequest,
  isPermissionResponse,
  isQuestionRequest,
  isQuestionResponse,
  isSessionInfo,
  isSetModeMessage,
  isSidecarToUIMessage,
  isToolResult,
  isUserEcho,
  isToolUse,
  isUIToSidecarMessage,
  isUserMessage,
} from "./protocol";
import {
  MOD_EVENTS,
  type ClientBridge,
  type CreateAboveBand,
  type CreateClientHost,
  type ModClient,
  type ModOrigin,
  type RenderOptions,
  type CreatePaneHost,
  type ModPaneClient,
  type OpenClaudeShell,
  type PaneRoster,
} from "../mods/contracts";

const samples: DenProtocolMessage[] = [
  { type: "user_message", id: "1", text: "salut" },
  { type: "permission_response", requestId: "r1", approved: true },
  { type: "question_response", requestId: "r2", answer: "oui" },
  { type: "interrupt" },
  { type: "assistant_delta", id: "1", text: "bon" },
  { type: "tool_use", id: "t1", toolUseId: "toolu_1", name: "Read", input: {} },
  { type: "tool_result", id: "t1", toolUseId: "t1", output: "ok" },
  { type: "permission_request", requestId: "r1", toolName: "Read", input: {} },
  { type: "question_request", requestId: "r2", question: "?" },
  { type: "session_info", sessionId: "s1", model: "sonnet", apiKeySource: "none" },
  { type: "done" },
  { type: "error", message: "boom" },
  { type: "set_mode", mode: "acceptEdits" },
  { type: "mode_changed", mode: "plan" },
  { type: "conversation_reset", sessionId: "s1", newConversationId: "c2" },
  { type: "commands", commands: [{ name: "plugin:skill", description: "Un skill" }] },
  { type: "mod_status", plugin: "p", text: "ok" },
  { type: "mod_toast", plugin: "p", text: "hi", timeoutMs: 3000 },
  {
    type: "mod_panes",
    panes: [{ id: "a", title: "Files", plugin: "p", rows: 8 }],
    shownId: "a",
    focusedId: null,
  },
  { type: "mod_invalidate", instances: [{ component: "Pane", instanceId: "a" }] },
  { type: "mod_tree", requestId: "q1", tree: { type: "engine", ref: 0 }, hooked: true, rewritten: false },
  { type: "mod_result", requestId: "q2", handled: true, element: "Button" },
  { type: "mods_unavailable", reason: "claude introuvable" },
  { type: "command_output", id: "c1", command: "cost", args: "", text: "ok" },
  { type: "mod_render", requestId: "q1", component: "Pane", instanceId: "a", props: {} },
  { type: "mod_press", requestId: "q2", plugin: "p", handle: 42 },
  { type: "mod_input", requestId: "q3", plugin: "p", handle: 42, kind: "change", value: "x" },
  { type: "mod_select", requestId: "q4", plugin: "p", handle: 42, value: "y" },
  { type: "mod_copy_request", requestId: "c1", text: "à copier" },
  { type: "mod_pane_action", requestId: "q5", action: "show", id: "a" },
  { type: "mod_copy_result", requestId: "c1", copied: true },
  { type: "mod_client_module", requestId: "m1", plugin: "p" },
  { type: "mod_client_press", requestId: "m2", address: { plugin: "p", component: "Pane", instanceId: "r1", client: "k", module: "m.js" }, element: "b", event: { type: "press" } },
  { type: "mod_client_press", requestId: "m2", address: { plugin: "p", component: "Pane", instanceId: "r1", client: "k", module: "m.js" }, element: "i", event: { type: "input", kind: "submit", value: "v" } },
  { type: "mod_message", requestId: "m3", address: { plugin: "p", component: "Pane", instanceId: "r1", client: "k", module: "m.js" }, data: { a: 1 } },
  { type: "mod_client_fault", requestId: "m4", address: { plugin: "p", component: "Pane", instanceId: "r1", client: "k", module: "m.js" }, phase: "run", reason: "boom" },
  { type: "mod_client_module_result", requestId: "m1", ok: false, error: "x" },
  { type: "mod_message_result", requestId: "m3", handled: true, props: { n: 1 } },
  { type: "mod_client_press_result", requestId: "m2", handled: true, reached: { element: "b" } },
];

const guards: Record<
  DenProtocolMessage["type"],
  (msg: DenProtocolMessage) => boolean
> = {
  user_message: isUserMessage,
  permission_response: isPermissionResponse,
  question_response: isQuestionResponse,
  interrupt: isInterruptMessage,
  assistant_delta: isAssistantDelta,
  tool_use: isToolUse,
  tool_result: isToolResult,
  permission_request: isPermissionRequest,
  question_request: isQuestionRequest,
  session_info: isSessionInfo,
  done: isDone,
  error: isErrorMessage,
  set_mode: isSetModeMessage,
  mode_changed: isModeChanged,
  conversation_reset: isConversationReset,
  commands: isCommands,
  mod_status: isModStatus,
  mod_toast: isModToast,
  mod_panes: isModPanes,
  mod_invalidate: isModInvalidate,
  mod_tree: isModTree,
  mod_result: isModResult,
  mods_unavailable: isModsUnavailable,
  command_output: isCommandOutput,
  mod_render: isModRender,
  mod_press: isModPress,
  mod_input: isModInput,
  mod_select: isModSelect,
  mod_copy_request: isModCopyRequest,
  mod_pane_action: isModPaneAction,
  mod_copy_result: isModCopyResult,
  mod_client_module: isModClientModule,
  mod_client_press: isModClientPress,
  mod_message: isModMessage,
  mod_client_fault: isModClientFault,
  mod_client_module_result: isModClientModuleResult,
  mod_message_result: isModMessageResult,
  mod_client_press_result: isModClientPressResult,
};

describe("protocol type guards", () => {
  it.each(samples)("le guard de $type le reconnaît, aucun autre ne le reconnaît", (msg) => {
    for (const [type, guard] of Object.entries(guards)) {
      if (type === msg.type) {
        expect(guard(msg)).toBe(true);
      } else {
        expect(guard(msg)).toBe(false);
      }
    }
  });

  it("user_echo est un écho local UI, hors wire : reconnu par isUserEcho, par aucun guard wire", () => {
    const echo: ConversationMessage = {
      type: "user_echo",
      id: "u1",
      text: "mon prompt",
    };
    expect(isUserEcho(echo)).toBe(true);
    for (const guard of Object.values(guards)) {
      expect(guard(echo as unknown as DenProtocolMessage)).toBe(false);
    }
  });

  it("distingue le sens UI->sidecar du sens sidecar->UI", () => {
    const uiToSidecarTypes = new Set([
      "user_message",
      "permission_response",
      "question_response",
      "interrupt",
      "set_mode",
      "mod_render",
      "mod_press",
      "mod_input",
      "mod_select",
      "mod_pane_action",
      "mod_copy_result",
      "mod_client_module",
      "mod_client_press",
      "mod_message",
      "mod_client_fault",
    ]);

    for (const msg of samples) {
      if (uiToSidecarTypes.has(msg.type)) {
        expect(isUIToSidecarMessage(msg)).toBe(true);
        expect(isSidecarToUIMessage(msg)).toBe(false);
      } else {
        expect(isUIToSidecarMessage(msg)).toBe(false);
        expect(isSidecarToUIMessage(msg)).toBe(true);
      }
    }
  });

  it("une PermissionResponse avec destination reste reconnue par isPermissionResponse", () => {
    const alwaysAllow: DenProtocolMessage = {
      type: "permission_response",
      requestId: "r1",
      approved: true,
      destination: "localSettings",
    };
    expect(isPermissionResponse(alwaysAllow)).toBe(true);
  });
});

describe("contrats run 2", () => {
  it("accepte les champs optionnels de mod_panes et tool_result.structured", () => {
    const panes: DenProtocolMessage = {
      type: "mod_panes",
      panes: [{ id: "a", title: "T", plugin: "p", closeOnEscape: true, rows: 5, columns: 40 }],
      shownId: "a",
      focusedId: "a",
      focusRequestedId: "a",
    };
    const result: DenProtocolMessage = {
      type: "tool_result",
      id: "t",
      toolUseId: "t",
      output: "x",
      structured: { type: "text", file: { filePath: "/f" } },
    };
    expect(isModPanes(panes)).toBe(true);
    expect(isToolResult(result)).toBe(true);
  });
});

describe("contrats mods (compilation)", () => {
  it("des objets factices satisfont les interfaces", () => {
    const client: ModPaneClient = {
      requestRender: async () => ({ tree: null, hooked: false, rewritten: false }),
      paneAction: async () => ({ handled: true }),
    };
    const host: CreatePaneHost = () => ({ dispose() {} });
    const band: CreateAboveBand = () => ({ dispose() {} });
    const shell: OpenClaudeShell = async () => {};
    const roster: PaneRoster = { panes: [], shownId: null, focusedId: null };
    expect(host({ mount: {} as HTMLElement, client, renderTree: () => ({}) as HTMLElement })).toBeTruthy();
    expect(band({ client, renderTree: () => ({}) as HTMLElement })).toBeTruthy();
    expect(shell).toBeTypeOf("function");
    expect(roster.panes).toEqual([]);
    expect(MOD_EVENTS.panes).toBe("den:mod-panes");
    expect(MOD_EVENTS.invalidate).toBe("den:mod-invalidate");
  });
});

describe("contrats Client (compilation)", () => {
  it("des objets factices satisfont ClientBridge, ModClient, CreateClientHost et ModOrigin", () => {
    const bridge: ClientBridge = {
      loadModule: async (_t, plugin) => ({
        plugin,
        hash: "h",
        modules: [],
        runtime: "",
        limits: { nodes: 1, depth: 1, chars: 1, values: 1, dataDepth: 1 },
        files: [],
      }),
      press: async () => ({ handled: true, reached: 1 }),
      message: async () => ({ handled: false }),
      fault: async () => {},
    };
    const client: ModClient = {
      ...bridge,
      requestRender: async () => ({ tree: null, hooked: false, rewritten: false }),
      paneAction: async () => ({ handled: true }),
    };
    const origin: ModOrigin = { component: "Pane", instanceId: "r1" };
    const createHost: CreateClientHost = () => ({
      renderClient: () => ({}) as HTMLElement,
      dispose() {},
    });
    const options: RenderOptions = { renderClient: () => ({}) as HTMLElement };
    const poolOptions: (tabId: string, o?: ModOrigin) => RenderOptions = () => options;
    expect(createHost({ bridge }).renderClient("t", origin, { type: "Client" } as never)).toBeTruthy();
    expect(client.press).toBe(bridge.press);
    expect(poolOptions("t", origin)).toBe(options);
  });
});

describe("gardes Client : formes malformées rejetées", () => {
  const address = { plugin: "p", component: "Pane", instanceId: "r1", client: "k", module: "m.js" };
  const bad = (o: Record<string, unknown>) => o as unknown as DenProtocolMessage;

  it("mod_client_press : adresse, événement ou élément invalides", () => {
    const ok = { type: "mod_client_press", requestId: "q", address, element: "b", event: { type: "press" } };
    expect(isModClientPress(bad(ok))).toBe(true);
    expect(isModClientPress(bad({ ...ok, address: undefined }))).toBe(false);
    expect(isModClientPress(bad({ ...ok, address: { ...address, component: "Inconnu" } }))).toBe(false);
    expect(isModClientPress(bad({ ...ok, event: { type: "drag" } }))).toBe(false);
    expect(isModClientPress(bad({ ...ok, event: { type: "input", kind: "oops", value: "x" } }))).toBe(false);
    expect(isModClientPress(bad({ ...ok, element: 3 }))).toBe(false);
  });

  it("mod_client_fault : phase inconnue ; mod_message : adresse absente ; mod_client_module : plugin absent", () => {
    expect(isModClientFault(bad({ type: "mod_client_fault", requestId: "q", address, phase: "boot", reason: "x" }))).toBe(false);
    expect(isModMessage(bad({ type: "mod_message", requestId: "q", data: 1 }))).toBe(false);
    expect(isModClientModule(bad({ type: "mod_client_module", requestId: "q" }))).toBe(false);
  });

  it("résultats : requestId et booléens obligatoires", () => {
    expect(isModClientModuleResult(bad({ type: "mod_client_module_result", requestId: "q" }))).toBe(false);
    expect(isModMessageResult(bad({ type: "mod_message_result", handled: true }))).toBe(false);
    expect(isModClientPressResult(bad({ type: "mod_client_press_result", requestId: "q" }))).toBe(false);
  });
});
