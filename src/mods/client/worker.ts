import type { ClientLimits } from "../../types/protocol";

export type HostToWorker =
  | { type: "init"; runtimeUrl: string; limits: ClientLimits }
  | { type: "mount"; id: string; entryUrl: string; component: string; props: unknown; columns: number; rows: number }
  | { type: "setProps"; id: string; props: unknown }
  | { type: "resize"; id: string; columns: number; rows: number }
  | { type: "input"; id: string; kind: "pointer" | "key" | "held"; payload: unknown }
  | { type: "dropHeld"; id: string; handles: number[] }
  | { type: "hasListener"; id: string; which: "pointer" | "key"; nonce: number }
  | { type: "unmount"; id: string };

export type WorkerToHost =
  | { type: "ready" }
  | { type: "tree"; id: string; tree: string }
  | { type: "post"; id: string; data: string }
  | { type: "fault"; id: string; reason: string }
  | { type: "listener"; nonce: number; value: boolean };

interface SurfaceApi {
  mount(id: string, fn: unknown, props: unknown): void;
  setProps(id: string, props: unknown): void;
  resize(id: string, columns: number, rows: number): void;
  stage(id: string, kind: string, payload?: unknown): void;
  dropHeld(id: string, handles: number[]): void;
  hasListener(id: string, which: string): boolean;
  unmount(id: string): void;
}

interface WorkerCoreDeps {
  post(msg: WorkerToHost): void;
  load(url: string): Promise<Record<string, unknown>>;
  scope: Record<string, unknown>;
}

// Le module n'a aucun autre canal que surface.post : tout accès réseau ou autre Worker est coupé.
const NEUTRALIZED = [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts",
  "indexedDB", "caches", "Worker", "SharedWorker", "BroadcastChannel",
];
const RENDER_DELAY_MS = 16;

const surfaceRun = (): unknown => (globalThis as unknown as { __surface__: { run(): unknown } }).__surface__.run();

function pickComponent(ns: Record<string, unknown>, name: string): unknown {
  if (typeof ns[name] === "function") return ns[name];
  const pascal = Object.keys(ns).filter((k) => /^[A-Z]/.test(k) && typeof ns[k] === "function");
  if (pascal.length === 1) return ns[pascal[0]];
  throw new Error(`composant introuvable : ${name}`);
}

export function createWorkerCore({ post, load, scope }: WorkerCoreDeps) {
  let api: SurfaceApi | null = null;
  const alive = new Set<string>();
  const timers = new Map<number, { id: string; handle: ReturnType<typeof setInterval> }>();
  const renders = new Map<string, ReturnType<typeof setTimeout>>();
  let timerSeq = 0;

  const run = (id: string, kind: string, payload?: unknown): unknown => {
    api!.stage(id, kind, payload);
    return surfaceRun();
  };

  const drop = (id: string): void => {
    alive.delete(id);
    for (const [tid, t] of timers) {
      if (t.id !== id) continue;
      clearInterval(t.handle);
      timers.delete(tid);
    }
    clearTimeout(renders.get(id));
    renders.delete(id);
    try {
      api?.unmount(id);
    } catch {
      // l'instance est déjà perdue : rien d'autre à nettoyer
    }
  };

  const fail = (id: string, e: unknown): void => {
    drop(id);
    post({ type: "fault", id, reason: e instanceof Error ? e.message : String(e) });
  };

  const guarded = (id: string, fn: () => void): void => {
    if (!alive.has(id)) return;
    try {
      fn();
    } catch (e) {
      fail(id, e);
    }
  };

  const render = (id: string): void =>
    guarded(id, () => {
      const tree = run(id, "render");
      if (typeof tree !== "string") throw new Error("le runtime n'a pas rendu d'arbre");
      post({ type: "tree", id, tree });
    });

  const host = {
    schedule(id: string): void {
      if (!alive.has(id) || renders.has(id)) return;
      renders.set(id, setTimeout(() => { renders.delete(id); render(id); }, RENDER_DELAY_MS));
    },
    startTimer(id: string, ms: number): number {
      const tid = ++timerSeq;
      timers.set(tid, { id, handle: setInterval(() => guarded(id, () => run(id, "tick", tid)), ms) });
      return tid;
    },
    stopTimer(_id: string, tid: number): void {
      const t = timers.get(tid);
      if (!t) return;
      clearInterval(t.handle);
      timers.delete(tid);
    },
    post: (id: string, data: string): void => post({ type: "post", id, data }),
    fault: (id: string, reason: string): void => fail(id, new Error(reason)),
  };

  async function dispatch(msg: HostToWorker): Promise<void> {
    switch (msg.type) {
      case "init": {
        for (const name of NEUTRALIZED) {
          Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false });
        }
        try {
          const runtime = await load(msg.runtimeUrl);
          Object.assign(globalThis, { h: runtime.h, Fragment: runtime.Fragment });
          api = (runtime.install as (h: unknown, l: ClientLimits) => SurfaceApi)(host, msg.limits);
          post({ type: "ready" });
        } catch (e) {
          post({ type: "fault", id: "", reason: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "mount": {
        if (!api) return fail(msg.id, new Error("runtime non initialisé"));
        if (alive.has(msg.id)) drop(msg.id);
        try {
          const fn = pickComponent(await load(msg.entryUrl), msg.component);
          alive.add(msg.id);
          api.mount(msg.id, fn, msg.props);
          api.resize(msg.id, msg.columns, msg.rows);
        } catch (e) {
          return fail(msg.id, e);
        }
        return render(msg.id);
      }
      case "setProps":
        return guarded(msg.id, () => { api!.setProps(msg.id, msg.props); host.schedule(msg.id); });
      case "resize":
        return guarded(msg.id, () => { api!.resize(msg.id, msg.columns, msg.rows); host.schedule(msg.id); });
      case "input":
        return guarded(msg.id, () => { run(msg.id, msg.kind, msg.payload); });
      case "dropHeld":
        return guarded(msg.id, () => api!.dropHeld(msg.id, msg.handles));
      case "hasListener": {
        const value = alive.has(msg.id) && api!.hasListener(msg.id, msg.which);
        return post({ type: "listener", nonce: msg.nonce, value });
      }
      case "unmount":
        return drop(msg.id);
    }
  }

  // Un dispatch qui lève devient une faute : la chaîne ne doit jamais être empoisonnée.
  const safeDispatch = async (msg: HostToWorker): Promise<void> => {
    try {
      await dispatch(msg);
    } catch (e) {
      try {
        if ("id" in msg) fail(msg.id, e);
        else post({ type: "fault", id: "", reason: e instanceof Error ? e.message : String(e) });
      } catch {
        // post lui-même en panne : rien de plus à faire
      }
    }
  };

  let chain: Promise<void> = Promise.resolve();
  // Les messages sont traités dans l'ordre : mount attend l'import du runtime lancé par init.
  return { handle: (msg: HostToWorker): Promise<void> => (chain = chain.then(() => safeDispatch(msg))) };
}

const isWorkerScope =
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === "function" &&
  globalThis instanceof (globalThis as unknown as { WorkerGlobalScope: new () => object }).WorkerGlobalScope;

if (isWorkerScope) {
  const self_ = globalThis as unknown as Record<string, unknown> & {
    postMessage(m: WorkerToHost): void;
    onmessage: ((e: { data: HostToWorker }) => void) | null;
  };
  const core = createWorkerCore({
    post: (m) => self_.postMessage(m),
    load: (url) => import(/* @vite-ignore */ url),
    scope: self_,
  });
  self_.onmessage = (e) => void core.handle(e.data);
}
