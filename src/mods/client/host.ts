import type { ClientAddress, ClientModuleBundle } from "../../types/protocol";
import type { ClientBridge, CreateClientHost, ModOrigin, RenderOptions } from "../contracts";
import { renderTree, replaceKeepingFocus } from "../render";
import type { ElementNode, RenderNode } from "../tree";
import { loadBundle } from "./loader";
import type { HostToWorker, WorkerToHost } from "./worker";

export interface WorkerLike {
  postMessage(msg: HostToWorker): void;
  terminate(): void;
  onmessage: ((e: { data: WorkerToHost }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface ClientHostEnv {
  createWorker(): WorkerLike;
  createObjectURL(source: string): string;
  revokeObjectURL(url: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  measureCell(el: HTMLElement): { w: number; h: number };
  observeResize(el: HTMLElement, cb: (width: number, height: number) => void): () => void;
}

const BUDGET_MS = 1000;
const DETACH_MS = 2000;
const SWEEP_MS = 500;
const RETRY_MS = 5000;
const ABANDONED = new Error("chargement abandonné");
const INTERACTIVE = "input, select, textarea, button, [contenteditable]";
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

const realEnv = (): ClientHostEnv => ({
  createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
  createObjectURL: (source) => URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  measureCell: (el) => {
    const r = el.querySelector(".den-mod-client-probe")?.getBoundingClientRect();
    return { w: r?.width || 8, h: r?.height || 16 };
  },
  observeResize: (el, cb) => {
    if (typeof ResizeObserver === "undefined") return () => {};
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r) cb(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  },
});

// Approximation à valider en usage : noms de touches du runtime de surface.
const KEY_NAMES: Record<string, string> = {
  ArrowDown: "down", ArrowUp: "up", ArrowLeft: "left", ArrowRight: "right",
  Enter: "return", Backspace: "backspace", Delete: "delete", Home: "home", End: "end",
  PageUp: "pageUp", PageDown: "pageDown", " ": "space",
};

type Press = { plugin: string; handle: number };
type LoadRecord = { hash: string; promise: Promise<Entry>; entry?: Entry; failedAt?: number };
// tree.ts ne type pas encore `client` (porté par le noeud Client du moteur).
type ClientNode = ElementNode & { client?: { plugin: string } };

interface Entry {
  plugin: string;
  hash: string;
  bundle: ClientModuleBundle;
  urls: Record<string, string>;
  worker: WorkerLike;
  dead: boolean;
  instances: Map<string, Instance>;
}

interface Instance {
  id: string;
  tabId: string;
  plugin: string;
  hash: string;
  address: ClientAddress;
  props: unknown;
  propsJson: string;
  columns: number;
  rows: number;
  el: HTMLElement;
  body: HTMLElement;
  line: HTMLElement;
  stopResize: () => void;
  entry: Entry | null;
  starting: boolean;
  tree: RenderNode | null;
  handles: number[];
  hadTree: boolean;
  fatal: boolean;
  reported: boolean;
  faultText: string;
  listens: { pointer: boolean | null; key: boolean | null };
  watchdog: unknown;
  focused: boolean;
  refocus: boolean;
  lastSeen: number;
  opts: RenderOptions;
}

/** held:n (sortie du runtime) -> press:{plugin, handle:n} (forme que renderTree attend). */
function toRenderNode(node: unknown, plugin: string, handles: number[]): RenderNode {
  if (typeof node !== "object" || node === null) return node as RenderNode;
  const { held, children, ...rest } = node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (typeof held === "number") {
    out.press = { plugin, handle: held };
    handles.push(held);
  }
  if (Array.isArray(children)) out.children = children.map((c) => toRenderNode(c, plugin, handles));
  return out as unknown as RenderNode;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createClientHostWith(
  deps: Parameters<CreateClientHost>[0],
  envOverrides: Partial<ClientHostEnv> = {},
): ReturnType<CreateClientHost> {
  const env: ClientHostEnv = { ...realEnv(), ...envOverrides };
  const instances = new Map<string, Instance>();
  const loads = new Map<string, LoadRecord>();
  const listeners = new Map<number, { entry: Entry; cb: (value: boolean) => void }>();
  let nonceSeq = 0;
  let sweeper: unknown = null;
  let disposed = false;

  const send = (inst: Instance, msg: HostToWorker): void => {
    if (inst.entry && !inst.entry.dead) inst.entry.worker.postMessage(msg);
  };

  const disarm = (inst: Instance): void => {
    if (inst.watchdog === null) return;
    env.clearTimeout(inst.watchdog);
    inst.watchdog = null;
  };

  // Retourne les instances qui y étaient rattachées : à l'appelant de décider de les remonter.
  const killEntry = (entry: Entry): Instance[] => {
    if (entry.dead) return [];
    entry.dead = true;
    entry.worker.terminate();
    for (const url of Object.values(entry.urls)) env.revokeObjectURL(url);
    for (const [nonce, l] of listeners) if (l.entry === entry) listeners.delete(nonce);
    if (loads.get(entry.plugin)?.entry === entry) loads.delete(entry.plugin);
    const orphans = [...entry.instances.values()];
    for (const inst of orphans) {
      disarm(inst);
      inst.entry = null;
    }
    entry.instances.clear();
    return orphans;
  };

  const showLine = (inst: Instance): void => {
    inst.line.textContent = inst.faultText;
    inst.line.hidden = inst.faultText === "";
  };

  const show = (inst: Instance): void => {
    showLine(inst);
    if (inst.tree !== null && !inst.fatal) replaceKeepingFocus(inst.body, renderTree(inst.tree, inst.opts));
  };

  // retry : l'instance reste remontable au prochain rendu (échec de chargement), sinon elle est définitivement en panne.
  const fail = (inst: Instance, phase: "load" | "render" | "run", reason: string, retry = false): void => {
    disarm(inst);
    inst.fatal = !retry;
    inst.faultText = `Module en panne : ${reason}`;
    inst.entry?.instances.delete(inst.id);
    inst.tree = null;
    inst.body.replaceChildren();
    show(inst);
    if (inst.reported) return;
    inst.reported = true;
    void Promise.resolve(deps.bridge.fault(inst.tabId, inst.address, phase, reason)).catch(() => {});
  };

  // Les erreurs de bridge ne levent jamais : une ligne discrète, effacée au rendu suivant.
  const safe = async <T extends { error?: string }>(inst: Instance, call: () => Promise<T>): Promise<T | null> => {
    try {
      const res = await call();
      if (res.error) throw new Error(res.error);
      return res;
    } catch (e) {
      inst.faultText = errText(e);
      showLine(inst);
      return null;
    }
  };

  const relay = async (inst: Instance, press: Press, key: string | undefined, event: Parameters<ClientBridge["press"]>[3]) => {
    const element = key ?? String(press.handle);
    const res = await safe(inst, () => deps.bridge.press(inst.tabId, inst.address, element, event));
    if (res?.reached !== undefined && inst.hadTree) {
      send(inst, { type: "input", id: inst.id, kind: "held", payload: { handle: press.handle, event: res.reached } });
    }
  };

  const arm = (inst: Instance): void => {
    if (inst.watchdog !== null || inst.fatal || !inst.entry || instances.get(inst.id) !== inst) return;
    inst.watchdog = env.setTimeout(() => {
      inst.watchdog = null;
      const orphans = inst.entry ? killEntry(inst.entry) : [];
      fail(inst, "render", "depassement du budget de 1 s");
      // Le Worker est partagé : seules les sœurs saines sont remontées, la faute n'est imputée qu'à l'instance fautive.
      for (const sibling of orphans) if (sibling !== inst && !sibling.fatal && instances.get(sibling.id) === sibling) remount(sibling);
    }, BUDGET_MS);
  };

  const refreshListens = (inst: Instance): void => {
    if (!inst.entry || inst.entry.dead || inst.fatal) return;
    for (const which of ["pointer", "key"] as const) {
      const nonce = ++nonceSeq;
      listeners.set(nonce, { entry: inst.entry, cb: (value) => { inst.listens[which] = value; } });
      send(inst, { type: "hasListener", id: inst.id, which, nonce });
    }
  };

  const onTree = (inst: Instance, text: string): void => {
    disarm(inst);
    let tree: RenderNode;
    const handles: number[] = [];
    try {
      tree = toRenderNode(JSON.parse(text), inst.plugin, handles);
    } catch (e) {
      return fail(inst, "render", `arbre illisible : ${errText(e)}`);
    }
    const stale = inst.handles.filter((n) => !handles.includes(n));
    if (stale.length > 0) send(inst, { type: "dropHeld", id: inst.id, handles: stale });
    const first = !inst.hadTree;
    inst.tree = tree;
    inst.handles = handles;
    inst.hadTree = true;
    inst.faultText = "";
    show(inst);
    if (first) refreshListens(inst);
  };

  const onPost = async (inst: Instance, data: string): Promise<void> => {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const res = await safe(inst, () => deps.bridge.message(inst.tabId, inst.address, payload));
    if (res?.props !== undefined) setProps(inst, res.props);
  };

  function setProps(inst: Instance, props: unknown): void {
    inst.props = props;
    inst.propsJson = JSON.stringify(props ?? null);
    if (!inst.entry || inst.fatal) return;
    send(inst, { type: "setProps", id: inst.id, props });
    arm(inst);
  }

  const onMessage = (entry: Entry, msg: WorkerToHost): void => {
    if (msg.type === "listener") {
      listeners.get(msg.nonce)?.cb(msg.value);
      listeners.delete(msg.nonce);
    } else if (msg.type === "fault" && msg.id === "") {
      // Runtime en échec à l'init (ou erreur du Worker) : Worker jeté, nouvelle tentative après RETRY_MS.
      const record = loads.get(entry.plugin);
      const orphans = killEntry(entry);
      if (record && record.hash === entry.hash) {
        const promise = Promise.reject<Entry>(new Error(msg.reason));
        promise.catch(() => {});
        loads.set(entry.plugin, { hash: record.hash, promise, failedAt: env.now() });
      }
      for (const inst of orphans) fail(inst, "load", msg.reason, true);
    } else if (msg.type !== "ready") {
      const inst = entry.instances.get(msg.id);
      if (!inst || inst.fatal) return;
      if (msg.type === "tree") onTree(inst, msg.tree);
      else if (msg.type === "post") void onPost(inst, msg.data);
      else if (msg.type === "fault") fail(inst, inst.hadTree ? "run" : "render", msg.reason);
    }
  };

  function getEntry(tabId: string, plugin: string, hash: string): Promise<Entry> {
    const cached = loads.get(plugin);
    if (cached?.hash === hash && (cached.failedAt === undefined || env.now() - cached.failedAt < RETRY_MS)) {
      return cached.promise;
    }
    if (cached?.entry) killEntry(cached.entry);
    const record: LoadRecord = {
      hash,
      promise: deps.bridge.loadModule(tabId, plugin).then((bundle) => {
        // Abandonné (dispose ou remplacé par un autre hash) pendant le chargement : rien ne doit être créé.
        if (disposed || loads.get(plugin) !== record) throw ABANDONED;
        const urls = loadBundle(bundle, env.createObjectURL, env.revokeObjectURL);
        const worker = env.createWorker();
        const entry: Entry = { plugin, hash, bundle, urls, worker, dead: false, instances: new Map() };
        worker.onmessage = (e) => onMessage(entry, e.data);
        worker.onerror = (e) => onMessage(entry, { type: "fault", id: "", reason: errText(e) });
        worker.postMessage({ type: "init", runtimeUrl: urls[bundle.runtime], limits: bundle.limits });
        record.entry = entry;
        return entry;
      }),
    };
    // Un échec reste mémorisé RETRY_MS (pas de martèlement du moteur), puis le prochain rendu réessaie.
    record.promise = record.promise.catch((e) => {
      if (e !== ABANDONED && loads.get(plugin) === record) record.failedAt = env.now();
      throw e;
    });
    loads.set(plugin, record);
    return record.promise;
  }

  function remount(inst: Instance): void {
    inst.hadTree = false;
    inst.handles = [];
    inst.listens = { pointer: null, key: null };
    if (!inst.starting) void start(inst);
  }

  async function start(inst: Instance): Promise<void> {
    inst.starting = true;
    try {
      const entry = await getEntry(inst.tabId, inst.plugin, inst.hash);
      if (disposed || instances.get(inst.id) !== inst || entry.dead) return;
      const mod = entry.bundle.modules.find((m) => m.module === inst.address.module);
      if (!mod) throw new Error(`module de surface introuvable : ${inst.address.module}`);
      inst.entry = entry;
      entry.instances.set(inst.id, inst);
      arm(inst);
      entry.worker.postMessage({
        type: "mount",
        id: inst.id,
        entryUrl: entry.urls[mod.entry],
        component: mod.component,
        props: inst.props,
        columns: inst.columns,
        rows: inst.rows,
      });
    } catch (e) {
      if (e !== ABANDONED && instances.get(inst.id) === inst) fail(inst, "load", errText(e), true);
    } finally {
      inst.starting = false;
    }
  }

  function drop(inst: Instance): void {
    disarm(inst);
    inst.stopResize();
    send(inst, { type: "unmount", id: inst.id });
    inst.entry?.instances.delete(inst.id);
    inst.entry = null;
    instances.delete(inst.id);
  }

  // Le parent remplace le placeholder à chaque rendu : le focus clavier suit l'instance, sans voler un focus pris ailleurs.
  function restoreFocus(inst: Instance): void {
    if (!inst.refocus || !inst.el.isConnected) return;
    inst.refocus = false;
    const active = document.activeElement;
    if (!active || active === document.body) inst.el.focus({ preventScroll: true });
  }

  function sweep(): void {
    sweeper = null;
    const now = env.now();
    for (const inst of [...instances.values()]) {
      if (inst.el.isConnected) {
        inst.lastSeen = now;
        restoreFocus(inst);
      } else if (now - inst.lastSeen > DETACH_MS) drop(inst);
    }
    if (instances.size > 0 && !disposed) sweeper = env.setTimeout(sweep, SWEEP_MS);
  }

  const cellOf = (inst: Instance, clientX: number, clientY: number) => {
    const r = inst.el.getBoundingClientRect();
    const c = env.measureCell(inst.el);
    return { x: Math.floor((clientX - r.left) / c.w), y: Math.floor((clientY - r.top) / c.h) };
  };

  function wire(inst: Instance, el: HTMLElement): void {
    const pointer = (type: "down" | "move" | "up" | "enter" | "leave", e: MouseEvent) => {
      if (inst.listens.pointer === false) return;
      const payload: Record<string, unknown> = { type, ...cellOf(inst, e.clientX, e.clientY) };
      if (type === "down" || type === "up") payload.button = e.button === 1 ? "middle" : e.button === 2 ? "right" : "left";
      if (e.shiftKey) payload.shift = true;
      if (e.altKey) payload.alt = true;
      if (e.ctrlKey) payload.ctrl = true;
      send(inst, { type: "input", id: inst.id, kind: "pointer", payload });
    };
    el.addEventListener("pointerdown", (e) => {
      try { el.setPointerCapture?.(e.pointerId); } catch { /* pointeur synthétique : pas de capture */ }
      pointer("down", e);
    });
    el.addEventListener("pointerup", (e) => {
      pointer("up", e);
      try { el.releasePointerCapture?.(e.pointerId); } catch { /* idem */ }
    });
    el.addEventListener("pointermove", (e) => pointer("move", e));
    el.addEventListener("pointerenter", (e) => { refreshListens(inst); pointer("enter", e); });
    el.addEventListener("pointerleave", (e) => pointer("leave", e));
    el.addEventListener("contextmenu", (e) => { if (inst.listens.pointer) e.preventDefault(); });
    el.addEventListener("focus", () => { inst.focused = true; refreshListens(inst); });
    el.addEventListener("blur", () => { if (el.isConnected) inst.focused = false; });
    el.addEventListener("keydown", (e) => {
      // Les touches des éléments interactifs internes du module leur appartiennent ; un ancêtre hors du Client n'avale rien.
      const inner = e.target instanceof Element ? e.target.closest(INTERACTIVE) : null;
      if (e.target !== el && inner && el.contains(inner)) return;
      if (e.key === "Escape") {
        if (e.target === el) el.blur();
        return;
      }
      const key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key : null);
      if (key === null || inst.listens.key === false) return;
      const payload: Record<string, unknown> = { key };
      if (e.ctrlKey) payload.ctrl = true;
      if (e.shiftKey) payload.shift = true;
      if (e.metaKey) payload.meta = true;
      if (inst.listens.key) e.preventDefault();
      send(inst, { type: "input", id: inst.id, kind: "key", payload });
    });
    inst.stopResize();
    inst.stopResize = env.observeResize(el, (width, height) => {
      const c = env.measureCell(el);
      // Une mesure nulle (pas encore mise en page, corps vide) garde la valeur courante au lieu de tomber à 1.
      const columns = width > 0 ? Math.max(1, Math.floor(width / c.w)) : inst.columns;
      const rows = height > 0 ? Math.max(1, Math.floor(height / c.h)) : inst.rows;
      if (columns === inst.columns && rows === inst.rows) return;
      inst.columns = columns;
      inst.rows = rows;
      if (!inst.entry || inst.fatal) return;
      send(inst, { type: "resize", id: inst.id, columns, rows });
      arm(inst);
    });
  }

  function placeholder(node: ElementNode): { el: HTMLElement; body: HTMLElement; line: HTMLElement } {
    const el = document.createElement("div");
    el.className = "den-mod-client";
    el.tabIndex = 0;
    const probe = document.createElement("div");
    probe.className = "den-mod-client-probe";
    probe.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = "den-mod-client-body";
    const line = document.createElement("div");
    line.className = "den-mod-client-fault";
    line.hidden = true;
    el.append(probe, body, line);
    const { width, height } = node.props ?? {};
    if (typeof width === "number") el.style.width = `${width}ch`;
    if (typeof height === "number") el.style.height = `${height}lh`;
    return { el, body, line };
  }

  function createInstance(tabId: string, id: string, origin: ModOrigin, node: ClientNode, key: string, hash: string): Instance {
    const p = node.props ?? {};
    const props = p.props ?? {};
    const address: ClientAddress = {
      plugin: node.client!.plugin,
      component: origin.component,
      instanceId: origin.instanceId,
      client: key,
      module: typeof p.module === "string" ? p.module : "",
    };
    const inst: Instance = {
      id, tabId, plugin: address.plugin, hash, address, props, propsJson: JSON.stringify(props),
      columns: typeof p.width === "number" ? p.width : DEFAULT_COLUMNS,
      rows: typeof p.height === "number" ? p.height : DEFAULT_ROWS,
      ...placeholder(node),
      stopResize: () => {}, entry: null, starting: false, tree: null, handles: [], hadTree: false,
      fatal: false, reported: false, faultText: "", listens: { pointer: null, key: null },
      watchdog: null, focused: false, refocus: false, lastSeen: env.now(),
      opts: {
        onPress: (press, k) => void relay(inst, press, k, { type: "press" }),
        onInput: (press, kind, value, k) => void relay(inst, press, k, { type: "input", kind, value }),
        onSelect: (press, value, k) => void relay(inst, press, k, { type: "select", value }),
      },
    };
    return inst;
  }

  return {
    renderClient(tabId, origin, elementNode) {
      const node: ClientNode = elementNode;
      const key = typeof node.props?.key === "string" ? node.props.key : "";
      const id = `${tabId}|${origin.component}|${origin.instanceId}|${key}`;
      const plugin = node.client?.plugin ?? "";
      const hash = deps.clientModules?.()[plugin];
      let inst = instances.get(id);
      if (inst && inst.hash !== hash) {
        drop(inst);
        inst = undefined;
      }
      if (inst === undefined) {
        if (hash === undefined) {
          const ghost = placeholder(node);
          ghost.line.textContent = `Module de surface non chargé : ${plugin}`;
          ghost.line.hidden = false;
          return ghost.el;
        }
        inst = createInstance(tabId, id, origin, node, key, hash);
        instances.set(id, inst);
        if (sweeper === null && !disposed) sweeper = env.setTimeout(sweep, SWEEP_MS);
      } else {
        const next = node.props?.props ?? {};
        if (JSON.stringify(next) !== inst.propsJson) setProps(inst, next);
        const current = inst;
        const hadFocus = current.focused || document.activeElement === current.el;
        Object.assign(current, placeholder(node));
        current.focused = false;
        // Toujours réaffecté : un drapeau resté vrai (placeholder jamais rattaché) volerait le focus plus tard.
        current.refocus = hadFocus;
        if (hadFocus) queueMicrotask(() => restoreFocus(current));
      }
      wire(inst, inst.el);
      inst.lastSeen = env.now();
      show(inst);
      if (!inst.fatal && !inst.entry && !inst.starting) void start(inst);
      return inst.el;
    },
    dispose() {
      disposed = true;
      if (sweeper !== null) env.clearTimeout(sweeper);
      for (const inst of [...instances.values()]) {
        disarm(inst);
        inst.stopResize();
      }
      for (const record of loads.values()) if (record.entry) killEntry(record.entry);
      loads.clear();
      listeners.clear();
      instances.clear();
    },
  };
}

export const createClientHost: CreateClientHost = (deps) => createClientHostWith(deps);
