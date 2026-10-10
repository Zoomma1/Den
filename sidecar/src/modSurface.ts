/**
 * Surface "desktop" du moteur claude (DEN-32) : on enveloppe le process lancé
 * par le SDK pour lire son stdout en parallèle et y écrire des control_request
 * `den-ui-*` (le SDK ignore leurs réponses), puis on relaie mods <-> UI.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type {
  ModCopyResult,
  ModInput,
  ModPaneAction,
  ModPanes,
  ModPress,
  ModRender,
  ModSelect,
  SidecarToUIMessage,
} from "../../src/types/protocol";

type UiRequest = ModRender | ModPress | ModInput | ModSelect;
// requestId null = requête interne (roster à l'attache), aucune réponse à l'UI.
type Pending = {
  kind: "render" | "result" | "pane";
  requestId: string | null;
  action?: ModPaneAction["action"];
  timer: NodeJS.Timeout;
};

// Le moteur abandonne ui_copy à 5 s : on répond avant lui.
const COPY_TIMEOUT_MS = 4_000;
// La réponse de ui_press n'arrive qu'à la fin du handler du mod (peut durer des secondes).
const INTERACTION_TIMEOUT_MS = 120_000;

const ID_PREFIX = "den-ui-";
const ATTACH_ID = `${ID_PREFIX}attach`;
const NOT_ATTACHED = "surface not attached";

let clientCounter = 0;

export interface ModSurfaceDeps {
  send(message: SidecarToUIMessage): void;
  /** Écrit une ligne dans le stdin du moteur ; défaut : stdin du process spawné. */
  write?(line: string): void;
  /** Rendus et actions de pane. */
  timeoutMs?: number;
  /** Press / input / select. */
  interactionTimeoutMs?: number;
}

export class ModSurface {
  private readonly send: (message: SidecarToUIMessage) => void;
  private readonly timeoutMs: number;
  private readonly interactionTimeoutMs: number;
  private writeLine: (line: string) => void;
  private readonly clientId = `den-${++clientCounter}`;
  private readonly pending = new Map<string, Pending>();
  private readonly copies = new Map<string, NodeJS.Timeout>();
  private counter = 0;
  private attachStarted = false;
  private attachRetried = false;
  private isAttached = false;

  constructor(deps: ModSurfaceDeps) {
    this.send = deps.send;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.interactionTimeoutMs = deps.interactionTimeoutMs ?? INTERACTION_TIMEOUT_MS;
    this.writeLine = deps.write ?? (() => {});
  }

  get attached(): boolean {
    return this.isAttached;
  }

  /** À passer à `spawnClaudeCodeProcess`. */
  spawn(options: SpawnOptions): SpawnedProcess {
    const child: ChildProcess = nodeSpawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    const stdin = child.stdin!;
    // Un EPIPE sur une écriture best-effort ne doit pas tuer le sidecar.
    stdin.on("error", () => {});
    this.writeLine = (line) => {
      if (!stdin.destroyed) stdin.write(`${line}\n`);
    };

    const decoder = new StringDecoder("utf8");
    let buffered = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += decoder.write(chunk);
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        this.handleLine(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
      }
    });
    // Le SDK ne vide pas stderr d'un processus fourni par spawnClaudeCodeProcess : plein (~64 Ko), claude se bloque. Rust relaie le stderr du sidecar.
    child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr!.on("error", () => {});
    child.once("exit", () => this.reset("engine exited"));
    return child as SpawnedProcess;
  }

  handleUiMessage(msg: UiRequest): void {
    const isRender = msg.type === "mod_render";
    if (!this.isAttached) {
      this.reply({ kind: isRender ? "render" : "result", requestId: msg.requestId }, NOT_ATTACHED);
      return;
    }
    this.request(
      isRender ? "render" : "result",
      msg.requestId,
      toEngineRequest(msg, this.clientId),
      isRender ? this.timeoutMs : this.interactionTimeoutMs,
    );
  }

  handlePaneAction(msg: ModPaneAction): void {
    if (!this.isAttached) {
      this.reply({ kind: "pane", requestId: msg.requestId }, NOT_ATTACHED);
      return;
    }
    this.request(
      "pane",
      msg.requestId,
      { subtype: PANE_SUBTYPES[msg.action], client_id: this.clientId, id: msg.id ?? undefined },
      this.timeoutMs,
      msg.action,
    );
  }

  handleCopyResult(msg: ModCopyResult): void {
    this.answerCopy(msg.requestId, msg.copied);
  }

  private answerCopy(requestId: string, copied: boolean): void {
    const timer = this.copies.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    this.copies.delete(requestId);
    this.writeLine(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: { copied } },
      }),
    );
  }

  private handleCopyRequest(requestId: string, text: unknown): void {
    this.copies.set(requestId, setTimeout(() => this.answerCopy(requestId, false), COPY_TIMEOUT_MS));
    this.send({ type: "mod_copy_request", requestId, text: String(text ?? "") });
  }

  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    // Premier signe de vie du process = stdin prêt à recevoir.
    if (!this.attachStarted) this.attach();

    if (obj.type === "control_response") {
      this.handleResponse(obj.response);
    } else if (obj.type === "control_request" && obj.request?.subtype === "ui_copy") {
      if (typeof obj.request_id === "string") this.handleCopyRequest(obj.request_id, obj.request.text);
    } else if (obj.type === "system") {
      this.handlePush(obj);
    }
  }

  private attach(): void {
    this.attachStarted = true;
    this.writeRequest(ATTACH_ID, {
      subtype: "ui_attach",
      surface: "desktop",
      client_id: this.clientId,
      answers: ["ui_copy"],
    });
  }

  private writeRequest(requestId: string, request: Record<string, unknown>): void {
    this.writeLine(JSON.stringify({ type: "control_request", request_id: requestId, request }));
  }

  private request(
    kind: Pending["kind"],
    requestId: string | null,
    request: Record<string, unknown>,
    timeoutMs: number,
    action?: Pending["action"],
  ): void {
    const id = `${ID_PREFIX}${++this.counter}`;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.reply({ kind, requestId }, "timeout");
    }, timeoutMs);
    this.pending.set(id, { kind, requestId, action, timer });
    this.writeRequest(id, request);
  }

  private handleResponse(response: any): void {
    const id: unknown = response?.request_id;
    if (typeof id !== "string" || !id.startsWith(ID_PREFIX)) return;
    const failure = response.subtype === "error" ? String(response.error ?? "unknown error") : null;

    if (id === ATTACH_ID) {
      if (!failure) {
        this.isAttached = true;
        // Un pane ouvert avant l'attache ne pousse rien : on lit le roster.
        this.request("pane", null, { subtype: PANE_SUBTYPES.roster, client_id: this.clientId }, this.timeoutMs, "roster");
      } else if (!this.attachRetried) {
        this.attachRetried = true;
        this.attach();
      }
      return;
    }

    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const r = response.response ?? {};
    if (entry.action === "roster" && !failure) this.send(toModPanes(r));
    this.reply(entry, failure, r);
  }

  private reply(
    target: { kind: Pending["kind"]; requestId: string | null; action?: Pending["action"] },
    error: string | null,
    r: any = {},
  ): void {
    if (target.requestId === null) return;
    if (target.kind === "pane") {
      const handled = !error && (target.action === "close" ? r.closed === true : true);
      const value = target.action === "show" ? r.shown_id : target.action === "focus" ? r.focused_id : undefined;
      this.send({
        type: "mod_result",
        requestId: target.requestId,
        handled,
        ...(!error && value !== undefined ? { value } : {}),
        ...(error ? { error } : {}),
      });
    } else if (target.kind === "render") {
      this.send({
        type: "mod_tree",
        requestId: target.requestId,
        tree: error ? null : (r.tree ?? null),
        hooked: !error && r.hooked === true,
        rewritten: !error && r.rewritten === true,
        ...(error ? { error } : {}),
      });
    } else {
      this.send({
        type: "mod_result",
        requestId: target.requestId,
        handled: !error && r.handled === true,
        ...(!error && r.element !== undefined ? { element: r.element } : {}),
        ...(!error && r.value !== undefined ? { value: r.value } : {}),
        ...(error ? { error } : {}),
      });
    }
  }

  private handlePush(obj: any): void {
    switch (obj.subtype) {
      case "ui_status":
        this.send({ type: "mod_status", plugin: obj.plugin, text: obj.text });
        break;
      case "ui_toast":
        this.send({
          type: "mod_toast",
          plugin: obj.plugin,
          text: obj.text,
          timeoutMs: obj.timeout_ms,
        });
        break;
      case "ui_panes":
        this.send(toModPanes(obj));
        break;
      case "ui_invalidate":
        this.send({
          type: "mod_invalidate",
          instances: (obj.instances ?? []).map((i: any) => ({
            component: i.component,
            instanceId: i.instance_id,
          })),
        });
        break;
    }
  }

  // Le moteur est mort : plus rien ne répondra aux requêtes en vol.
  private reset(error: string): void {
    this.isAttached = false;
    for (const timer of this.copies.values()) clearTimeout(timer);
    this.copies.clear();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      this.reply(entry, error);
    }
  }
}

const PANE_SUBTYPES = {
  show: "ui_pane_show",
  focus: "ui_pane_focus",
  close: "ui_close",
  roster: "ui_panes",
} as const;

// Le moteur parle snake_case, le protocole UI camelCase.
function toModPanes(r: any): ModPanes {
  return {
    type: "mod_panes",
    panes: (r.panes ?? []).map((p: any) => ({
      id: p.id,
      title: p.title,
      plugin: p.plugin,
      closeOnEscape: p.close_on_escape,
      rows: p.rows,
      columns: p.columns,
    })),
    shownId: r.shown_id ?? null,
    focusedId: r.focused_id ?? null,
    focusRequestedId: r.focus_requested_id ?? null,
  };
}

function toEngineRequest(msg: UiRequest, clientId: string): Record<string, unknown> {
  switch (msg.type) {
    case "mod_render":
      return {
        subtype: "ui_render",
        surface: "desktop",
        client_id: clientId,
        component: msg.component,
        instance_id: msg.instanceId,
        props: msg.props,
      };
    case "mod_press":
      return { subtype: "ui_press", plugin: msg.plugin, handle: msg.handle, key: msg.key, href: msg.href };
    case "mod_input":
      return {
        subtype: "ui_input",
        plugin: msg.plugin,
        handle: msg.handle,
        kind: msg.kind,
        value: msg.value,
        key: msg.key,
        component: msg.component,
        instance_id: msg.instanceId,
      };
    case "mod_select":
      return {
        subtype: "ui_select",
        plugin: msg.plugin,
        handle: msg.handle,
        value: msg.value,
        key: msg.key,
        component: msg.component,
        instance_id: msg.instanceId,
      };
  }
}
