import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientModuleBundle } from "../../types/protocol";
import { loadBundle } from "./loader";
import { createWorkerCore, type WorkerToHost } from "./worker";

const stub = (f: string) => readFileSync(new URL(`../fixtures/client-stub/${f}`, import.meta.url), "utf8");
const bundle = JSON.parse(readFileSync(new URL("../fixtures/client-module.json", import.meta.url), "utf8")).response
  .response as ClientModuleBundle;

// data: faute de blob: sous Node ; mêmes sources que celles que le host passe au Worker.
const dataUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const load = (url: string) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;

const files = [
  ...bundle.files,
  { key: "surface:///loop.js", source: stub("module-loop.js") },
  { key: "surface:///throw.js", source: stub("module-throw.js") },
];
const urls = loadBundle({ ...bundle, files }, dataUrl);
const rowsEntry = urls["surface:///hooks/rows.tsx"];
const props = { rows: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] };

describe("createWorkerCore avec le runtime factice", () => {
  let out: WorkerToHost[];
  let scope: Record<string, unknown>;
  let core: ReturnType<typeof createWorkerCore>;

  const of = <T extends WorkerToHost["type"]>(type: T) =>
    out.filter((m): m is Extract<WorkerToHost, { type: T }> => m.type === type);
  const lastTree = () => JSON.parse(of("tree").at(-1)!.tree);

  const boot = async () => {
    await core.handle({ type: "init", runtimeUrl: urls["claude:surface-runtime"], limits: bundle.limits });
  };
  const mount = (id = "i1", entryUrl = rowsEntry, component = "default") =>
    core.handle({ type: "mount", id, entryUrl, component, props, columns: 40, rows: 10 });

  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
    scope = {};
    core = createWorkerCore({ post: (m) => out.push(m), load, scope });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).h;
    delete (globalThis as Record<string, unknown>).Fragment;
  });

  it("neutralise le réseau et les Workers avant d'importer le runtime", async () => {
    await boot();
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "Worker", "SharedWorker", "BroadcastChannel"]) {
      expect(name in scope && scope[name]).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(scope, name)).toMatchObject({ writable: false, configurable: false });
    }
    expect(of("ready")).toHaveLength(1);
  });

  it("mount rend un arbre JSON dont les boutons portent held", async () => {
    await boot();
    await mount();
    const tree = lastTree();
    expect(tree.type).toBe("Box");
    const button = tree.children.at(-1);
    expect(button).toMatchObject({ type: "Button", props: { key: "more", label: "plus" } });
    expect(typeof button.held).toBe("number");
    expect(tree.children[0].children).toEqual(["Alpha"]);
  });

  it("pointer, key puis held produisent des post", async () => {
    await boot();
    await mount();
    await core.handle({ type: "input", id: "i1", kind: "pointer", payload: { type: "down", x: 0, y: 1 } });
    await core.handle({ type: "input", id: "i1", kind: "key", payload: { key: "down" } });
    const handle = lastTree().children.at(-1).held;
    await core.handle({ type: "input", id: "i1", kind: "held", payload: { handle, event: {} } });
    expect(of("post").map((p) => JSON.parse(p.data))).toEqual([{ press: "b" }, { key: "down" }, { more: true }]);
  });

  it("répond à hasListener", async () => {
    await boot();
    await mount();
    await core.handle({ type: "hasListener", id: "i1", which: "pointer", nonce: 7 });
    await core.handle({ type: "hasListener", id: "nope", which: "key", nonce: 8 });
    expect(of("listener")).toEqual([
      { type: "listener", nonce: 7, value: true },
      { type: "listener", nonce: 8, value: false },
    ]);
  });

  it("le timer fait un tick puis un rendu coalescé, setProps et resize re-rendent", async () => {
    await boot();
    await mount();
    await vi.advanceTimersByTimeAsync(16);
    const before = of("tree").length;
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(20);
    expect(of("tree").length).toBe(before + 1);
    expect(JSON.stringify(lastTree())).toContain("ticks:1");
    await core.handle({ type: "setProps", id: "i1", props: { rows: [{ id: "z", label: "Zed" }] } });
    await vi.advanceTimersByTimeAsync(16);
    expect(JSON.stringify(lastTree())).toContain("Zed");
    const n = of("tree").length;
    await core.handle({ type: "resize", id: "i1", columns: 10, rows: 3 });
    await vi.advanceTimersByTimeAsync(16);
    expect(of("tree").length).toBe(n + 1);
  });

  it("dropHeld ne casse pas l'instance puis unmount arrête timers et rendus", async () => {
    await boot();
    await mount();
    await core.handle({ type: "dropHeld", id: "i1", handles: [lastTree().children.at(-1).held] });
    await core.handle({ type: "unmount", id: "i1" });
    const n = out.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(out.length).toBe(n);
    await core.handle({ type: "input", id: "i1", kind: "key", payload: { key: "x" } });
    expect(out.length).toBe(n);
  });

  it("une exception du module devient un fault et l'instance est démontée", async () => {
    await boot();
    await mount("t1", urls["surface:///throw.js"]);
    expect(of("fault")).toEqual([{ type: "fault", id: "t1", reason: "boom du module" }]);
    expect(of("tree")).toHaveLength(0);
  });

  it("une exception dans un handler d'entrée devient un fault", async () => {
    await boot();
    await mount();
    await core.handle({ type: "input", id: "i1", kind: "pointer", payload: { type: "down", x: 0, y: 99 } });
    expect(of("fault")).toHaveLength(0);
    await core.handle({ type: "input", id: "i1", kind: "held", payload: { handle: -1, event: {} } });
    expect(of("fault")).toHaveLength(0);
    await core.handle({ type: "input", id: "i1", kind: "bogus" as "key", payload: null });
    expect(of("fault")).toEqual([{ type: "fault", id: "i1", reason: "unknown surface call bogus" }]);
  });

  it("un échec d'import du runtime remonte un fault sans id", async () => {
    await core.handle({ type: "init", runtimeUrl: "data:text/javascript,throw new Error('runtime cassé')", limits: bundle.limits });
    expect(of("fault")).toEqual([{ type: "fault", id: "", reason: expect.stringContaining("runtime cassé") }]);
  });

  it("un dispatch qui lève hors try devient un fault et la chaîne continue", async () => {
    const posted: WorkerToHost[] = [];
    core = createWorkerCore({
      post: (m) => { if (m.type === "listener") throw new Error("post en panne"); posted.push(m); },
      load,
      scope: {},
    });
    await boot();
    await mount();
    await core.handle({ type: "hasListener", id: "i1", which: "key", nonce: 1 });
    expect(posted.filter((m) => m.type === "fault")).toEqual([{ type: "fault", id: "i1", reason: "post en panne" }]);
    await core.handle({ type: "mount", id: "i2", entryUrl: rowsEntry, component: "default", props, columns: 40, rows: 10 });
    expect(posted.filter((m) => m.type === "tree" && m.id === "i2")).toHaveLength(1);
  });
});
