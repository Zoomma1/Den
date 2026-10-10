// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientModuleBundle } from "../../types/protocol";
import fixture from "../fixtures/client-module.json";
import type { ClientBridge, ModOrigin } from "../contracts";
import type { ElementNode } from "../tree";
import { createClientHostWith, type WorkerLike } from "./host";
import type { HostToWorker, WorkerToHost } from "./worker";

const bundle = fixture.response.response as ClientModuleBundle;

class FakeWorker implements WorkerLike {
  posted: HostToWorker[] = [];
  terminated = false;
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  postMessage(msg: HostToWorker) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
  emit(msg: WorkerToHost) { this.onmessage?.({ data: msg }); }
  of<T extends HostToWorker["type"]>(type: T) {
    return this.posted.filter((m): m is Extract<HostToWorker, { type: T }> => m.type === type);
  }
}

const origin: ModOrigin = { component: "Pane", instanceId: "p1" };
const nodeOf = (props: unknown = { rows: [] }, key = "k"): ElementNode & { client: { plugin: string } } => ({
  type: "Client",
  props: { key, module: "hooks/rows.tsx", props },
  client: { plugin: "demo" },
});
const button = (held = 5) => ({ type: "Button", props: { key: "more", label: "plus" }, held });
const tree = (...children: unknown[]) => JSON.stringify({ type: "Box", children });

describe("createClientHostWith", () => {
  let workers: FakeWorker[];
  let bridge: { [K in keyof ClientBridge]: ReturnType<typeof vi.fn> };
  let hash: string;
  let created: string[];
  let revoked: string[];
  let resizeCb: ((w: number, h: number) => void) | null;
  let host: ReturnType<typeof createClientHostWith>;

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const attach = (el: HTMLElement) => { document.body.append(el); return el; };
  const mountOne = async (props?: unknown) => {
    const el = attach(host.renderClient("t1", origin, nodeOf(props)));
    await settle();
    return el;
  };
  const sent = (w: FakeWorker, kind: string) =>
    w.of("input").filter((m) => m.kind === kind).map((m) => m.payload);

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    workers = [];
    created = [];
    revoked = [];
    hash = bundle.hash;
    resizeCb = null;
    bridge = {
      loadModule: vi.fn(async () => bundle),
      press: vi.fn(async () => ({ handled: true, reached: { type: "press" } })),
      message: vi.fn(async () => ({ handled: true })),
      fault: vi.fn(async () => {}),
    };
    host = createClientHostWith(
      { bridge: bridge as unknown as ClientBridge, clientModules: () => ({ demo: hash }) },
      {
        createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; },
        createObjectURL: (s) => { const u = `blob:fake/${s.length}/${Math.random()}`; created.push(u); return u; },
        revokeObjectURL: (u) => { revoked.push(u); },
        measureCell: () => ({ w: 10, h: 20 }),
        observeResize: (_el, cb) => { resizeCb = cb; return () => {}; },
      },
    );
  });

  afterEach(() => {
    host.dispose();
    vi.useRealTimers();
  });

  it("rend tout de suite un placeholder focalisable puis init et monte dans un Worker", async () => {
    const el = host.renderClient("t1", origin, nodeOf({ rows: [1] }));
    expect(el.className).toBe("den-mod-client");
    expect(el.tabIndex).toBe(0);
    await settle();
    expect(bridge.loadModule).toHaveBeenCalledWith("t1", "demo");
    const [w] = workers;
    expect(w.posted[0]).toMatchObject({ type: "init", limits: bundle.limits });
    expect(w.of("mount")[0]).toMatchObject({
      id: "t1|Pane|p1|k", component: "default", props: { rows: [1] }, columns: 80, rows: 24,
    });
  });

  it("un seul Worker et un seul chargement pour deux instances du même bundle", async () => {
    host.renderClient("t1", origin, nodeOf({}, "a"));
    host.renderClient("t1", origin, nodeOf({}, "b"));
    await settle();
    expect(bridge.loadModule).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(1);
    expect(workers[0].of("mount").map((m) => m.id)).toEqual(["t1|Pane|p1|a", "t1|Pane|p1|b"]);
  });

  it("transforme held en press et rend l'arbre reçu", async () => {
    const el = await mountOne();
    workers[0].emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree("Alpha", button()) });
    expect(el.textContent).toContain("Alpha");
    expect(el.querySelector("button.den-mod-btn")?.textContent).toBe("plus");
  });

  it("réconciliation : même instance, nouveau placeholder rattaché avec le dernier arbre, setProps seulement si les props changent", async () => {
    const first = await mountOne({ rows: [1] });
    workers[0].emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree("Alpha") });
    first.remove();
    const second = attach(host.renderClient("t1", origin, nodeOf({ rows: [1] })));
    expect(second).not.toBe(first);
    expect(second.textContent).toContain("Alpha");
    await settle();
    expect(workers).toHaveLength(1);
    expect(workers[0].of("mount")).toHaveLength(1);
    expect(workers[0].of("setProps")).toHaveLength(0);
    attach(host.renderClient("t1", origin, nodeOf({ rows: [2] })));
    expect(workers[0].of("setProps")).toEqual([{ type: "setProps", id: "t1|Pane|p1|k", props: { rows: [2] } }]);
  });

  it("press : bridge.press avec l'adresse, puis held avec reached", async () => {
    const el = await mountOne();
    const w = workers[0];
    w.emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree(button(7)) });
    el.querySelector("button")!.click();
    await settle();
    expect(bridge.press).toHaveBeenCalledWith(
      "t1",
      { plugin: "demo", component: "Pane", instanceId: "p1", client: "k", module: "hooks/rows.tsx" },
      "more",
      { type: "press" },
    );
    expect(sent(w, "held")).toEqual([{ handle: 7, event: { type: "press" } }]);
  });

  it("press bloqué par un hook (pas de reached) : aucun held", async () => {
    bridge.press.mockResolvedValue({ handled: true });
    const el = await mountOne();
    workers[0].emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree(button()) });
    el.querySelector("button")!.click();
    await settle();
    expect(sent(workers[0], "held")).toEqual([]);
  });

  it("input et select passent par bridge.press puis held", async () => {
    bridge.press.mockResolvedValue({ handled: true, reached: "ok" });
    const el = await mountOne();
    const w = workers[0];
    const input = { type: "Input", props: { key: "q", value: "" }, held: 3 };
    const select = { type: "Select", props: { key: "s", options: ["a", "b"] }, held: 4 };
    w.emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree(input, select) });
    const field = el.querySelector("input")!;
    field.value = "abc";
    field.dispatchEvent(new Event("input"));
    el.querySelector("select")!.value = "b";
    el.querySelector("select")!.dispatchEvent(new Event("change"));
    await settle();
    expect(bridge.press.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ["q", { type: "input", kind: "change", value: "abc" }],
      ["s", { type: "select", value: "b" }],
    ]);
    expect(sent(w, "held")).toEqual([{ handle: 3, event: "ok" }, { handle: 4, event: "ok" }]);
  });

  it("libère les handles disparus d'un redessin", async () => {
    await mountOne();
    const w = workers[0];
    w.emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree(button(1)) });
    w.emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree(button(2)) });
    expect(w.of("dropHeld")).toEqual([{ type: "dropHeld", id: "t1|Pane|p1|k", handles: [1] }]);
  });

  it("post -> bridge.message ; une réponse avec props rappelle setProps", async () => {
    bridge.message.mockResolvedValue({ handled: true, props: { rows: [9] } });
    await mountOne();
    workers[0].emit({ type: "post", id: "t1|Pane|p1|k", data: '{"press":"a"}' });
    await settle();
    expect(bridge.message).toHaveBeenCalledWith("t1", expect.objectContaining({ client: "k" }), { press: "a" });
    expect(workers[0].of("setProps")[0].props).toEqual({ rows: [9] });
    // le rendu suivant avec les mêmes props ne renvoie rien
    attach(host.renderClient("t1", origin, nodeOf({ rows: [9] })));
    expect(workers[0].of("setProps")).toHaveLength(1);
  });

  it("une erreur de bridge ne lève pas et laisse une ligne discrète", async () => {
    bridge.press.mockRejectedValue(new Error("moteur absent"));
    const el = await mountOne();
    workers[0].emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree(button()) });
    el.querySelector("button")!.click();
    await settle();
    const line = el.querySelector<HTMLElement>(".den-mod-client-fault")!;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("moteur absent");
  });

  it("pointeur : coordonnées en cellules, bouton et modificateurs", async () => {
    const el = await mountOne();
    const w = workers[0];
    el.dispatchEvent(new MouseEvent("pointerdown", { clientX: 35, clientY: 45, button: 2, shiftKey: true }));
    el.dispatchEvent(new MouseEvent("pointermove", { clientX: 5, clientY: 19 }));
    el.dispatchEvent(new MouseEvent("pointerup", { clientX: 35, clientY: 45, button: 0 }));
    expect(sent(w, "pointer")).toEqual([
      { type: "down", x: 3, y: 2, button: "right", shift: true },
      { type: "move", x: 0, y: 0 },
      { type: "up", x: 3, y: 2, button: "left" },
    ]);
  });

  it("contextmenu neutralisé seulement si le module écoute le pointeur", async () => {
    const el = await mountOne();
    const w = workers[0];
    w.emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree("x") });
    const queries = w.of("hasListener");
    expect(queries.map((q) => q.which)).toEqual(["pointer", "key"]);
    const ctx = () => { const e = new MouseEvent("contextmenu", { cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
    expect(ctx()).toBe(false);
    w.emit({ type: "listener", nonce: queries[0].nonce, value: true });
    expect(ctx()).toBe(true);
  });

  it("clavier : table de touches, Echap rend le focus, preventDefault seulement si le module écoute", async () => {
    const el = await mountOne();
    const w = workers[0];
    w.emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree("x") });
    const key = (init: KeyboardEventInit) => { const e = new KeyboardEvent("keydown", { cancelable: true, ...init }); el.dispatchEvent(e); return e; };

    expect(key({ key: "a" }).defaultPrevented).toBe(false);
    const q = w.of("hasListener").find((m) => m.which === "key")!;
    w.emit({ type: "listener", nonce: q.nonce, value: true });
    for (const k of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", " "]) {
      expect(key({ key: k }).defaultPrevented).toBe(true);
    }
    key({ key: "z", ctrlKey: true, shiftKey: true, metaKey: true });
    key({ key: "Shift" });
    attach(el);
    el.focus();
    key({ key: "Escape" });
    expect(document.activeElement).not.toBe(el);
    expect(sent(w, "key").map((p) => (p as { key: string }).key)).toEqual([
      "a", "down", "up", "left", "right", "return", "backspace", "delete", "home", "end", "pageUp", "pageDown", "space", "z",
    ]);
    expect(sent(w, "key").at(-1)).toEqual({ key: "z", ctrl: true, shift: true, meta: true });
  });

  it("ResizeObserver -> resize en cellules, minimum 1, sans doublon, mesure nulle ignorée", async () => {
    await mountOne();
    const w = workers[0];
    resizeCb!(405, 100);
    resizeCb!(405, 100);
    resizeCb!(3, 2);
    resizeCb!(0, 0);
    expect(w.of("resize").map((m) => [m.columns, m.rows])).toEqual([[40, 5], [1, 1]]);
  });

  it("une mesure nulle avant le premier rendu garde les défauts 80x24 au montage", async () => {
    host.renderClient("t1", origin, nodeOf());
    resizeCb!(0, 0);
    await settle();
    const mount = workers[0].of("mount")[0];
    expect([mount.columns, mount.rows]).toEqual([80, 24]);
  });

  it("budget : sans arbre après 1 s -> terminate, faute au moteur, ligne, pas de remontage", async () => {
    const el = await mountOne();
    const w = workers[0];
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.terminated).toBe(true);
    expect(bridge.fault).toHaveBeenCalledWith("t1", expect.objectContaining({ client: "k" }), "render", "depassement du budget de 1 s");
    expect(el.querySelector(".den-mod-client-fault")?.textContent).toContain("depassement du budget de 1 s");
    const again = attach(host.renderClient("t1", origin, nodeOf()));
    await settle();
    expect(workers).toHaveLength(1);
    expect(bridge.loadModule).toHaveBeenCalledTimes(1);
    expect(again.querySelector(".den-mod-client-fault")?.textContent).toContain("budget");
    expect(bridge.fault).toHaveBeenCalledTimes(1);
  });

  it("un arbre reçu à temps désarme le garde-fou", async () => {
    await mountOne();
    workers[0].emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree("ok") });
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers[0].terminated).toBe(false);
    expect(bridge.fault).not.toHaveBeenCalled();
  });

  it("un hash de changement du bundle recharge, termine l'ancien Worker et remonte", async () => {
    await mountOne();
    hash = "autre-hash";
    attach(host.renderClient("t1", origin, nodeOf()));
    await settle();
    expect(workers[0].terminated).toBe(true);
    expect(bridge.loadModule).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(2);
    expect(workers[1].of("mount")).toHaveLength(1);
  });

  it("une instance en panne est remontée quand le hash change", async () => {
    await mountOne();
    await vi.advanceTimersByTimeAsync(1000);
    hash = "autre-hash";
    attach(host.renderClient("t1", origin, nodeOf()));
    await settle();
    expect(workers).toHaveLength(2);
    expect(workers[1].of("mount")).toHaveLength(1);
  });

  it("fault du worker : une seule faute au moteur, phase run après un arbre", async () => {
    const el = await mountOne();
    const id = "t1|Pane|p1|k";
    workers[0].emit({ type: "tree", id, tree: tree("x") });
    workers[0].emit({ type: "fault", id, reason: "boom" });
    workers[0].emit({ type: "fault", id, reason: "boom bis" });
    await settle();
    expect(bridge.fault).toHaveBeenCalledTimes(1);
    expect(bridge.fault).toHaveBeenCalledWith("t1", expect.anything(), "run", "boom");
    expect(el.querySelector(".den-mod-client-fault")?.textContent).toContain("boom");
    expect(el.querySelector(".den-mod-client-body")?.textContent).toBe("");
  });

  it("fault avant tout arbre : phase render", async () => {
    await mountOne();
    workers[0].emit({ type: "fault", id: "t1|Pane|p1|k", reason: "boom" });
    expect(bridge.fault).toHaveBeenCalledWith("t1", expect.anything(), "render", "boom");
  });

  it("bundle invalide ou module absent : faute de phase load", async () => {
    bridge.loadModule.mockResolvedValue({ ...bundle, files: [{ key: "claude:surface-runtime", source: "import 'surface-unlinked:///x'" }] });
    const el = await mountOne();
    expect(bridge.fault).toHaveBeenCalledWith("t1", expect.anything(), "load", expect.stringContaining("non résolu"));
    expect(el.querySelector(".den-mod-client-fault")?.textContent).toContain("non résolu");
    expect(workers).toHaveLength(0);
  });

  it("plugin sans module chargé : ligne de faute, aucun chargement", async () => {
    const el = host.renderClient("t1", origin, { ...nodeOf(), client: { plugin: "inconnu" } } as ElementNode);
    await settle();
    expect(el.querySelector(".den-mod-client-fault")?.textContent).toContain("inconnu");
    expect(bridge.loadModule).not.toHaveBeenCalled();
  });

  it("placeholder détaché plus de 2 s sans rattachement : unmount", async () => {
    const el = await mountOne();
    workers[0].emit({ type: "tree", id: "t1|Pane|p1|k", tree: tree("x") });
    el.remove();
    await vi.advanceTimersByTimeAsync(1500);
    expect(workers[0].of("unmount")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(workers[0].of("unmount")).toEqual([{ type: "unmount", id: "t1|Pane|p1|k" }]);
  });

  it("un placeholder rattaché à temps n'est pas démonté", async () => {
    const el = await mountOne();
    el.remove();
    await vi.advanceTimersByTimeAsync(1000);
    attach(host.renderClient("t1", origin, nodeOf()));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(workers[0].of("unmount")).toHaveLength(0);
  });

  it("dispose termine les Workers", async () => {
    await mountOne();
    host.dispose();
    expect(workers[0].terminated).toBe(true);
  });

  const idOf = (key: string) => `t1|Pane|p1|${key}`;
  const mountPair = async () => {
    const a = attach(host.renderClient("t1", origin, nodeOf({}, "a")));
    const b = attach(host.renderClient("t1", origin, nodeOf({}, "b")));
    await settle();
    workers[0].emit({ type: "tree", id: idOf("a"), tree: tree("Alpha") });
    workers[0].emit({ type: "tree", id: idOf("b"), tree: tree("Beta") });
    return { a, b };
  };

  it("instance déjà en faute : resize ne réarme pas le garde-fou et le Worker partagé survit", async () => {
    await mountPair();
    workers[0].emit({ type: "fault", id: idOf("b"), reason: "boom" });
    resizeCb!(405, 100);
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers[0].terminated).toBe(false);
    expect(bridge.fault).toHaveBeenCalledTimes(1);
    expect(bridge.fault).toHaveBeenCalledWith("t1", expect.objectContaining({ client: "b" }), "run", "boom");
  });

  it("dépassement du budget : faute imputée à l'instance fautive, la sœur saine est remontée sur un nouveau Worker", async () => {
    const { a, b } = await mountPair();
    resizeCb!(405, 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(workers[0].terminated).toBe(true);
    expect(bridge.fault).toHaveBeenCalledTimes(1);
    expect(bridge.fault).toHaveBeenCalledWith("t1", expect.objectContaining({ client: "b" }), "render", "depassement du budget de 1 s");
    expect(b.querySelector(".den-mod-client-fault")?.textContent).toContain("budget");
    expect(a.textContent).toContain("Alpha");
    await settle();
    expect(workers).toHaveLength(2);
    expect(workers[1].of("mount").map((m) => m.id)).toEqual([idOf("a")]);
    expect(workers[1].of("mount")[0].props).toEqual({});
    workers[1].emit({ type: "tree", id: idOf("a"), tree: tree("Gamma") });
    expect(a.textContent).toContain("Gamma");
    expect(a.textContent).not.toContain("Alpha");
    await vi.advanceTimersByTimeAsync(5000);
    expect(workers[1].terminated).toBe(false);
  });

  it("sœur qui ne peut pas être remontée : ligne de faute discrète", async () => {
    const { a } = await mountPair();
    bridge.loadModule.mockRejectedValue(new Error("moteur absent"));
    resizeCb!(405, 100);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(a.querySelector(".den-mod-client-fault")?.textContent).toContain("moteur absent");
    expect(a.querySelector<HTMLElement>(".den-mod-client-fault")!.hidden).toBe(false);
  });

  it("clavier : les touches d'un Input interne ne sont ni envoyées ni empêchées, Echap n'y vole pas le focus", async () => {
    const el = await mountOne();
    const w = workers[0];
    const input = { type: "Input", props: { key: "q", value: "" }, held: 3 };
    w.emit({ type: "tree", id: idOf("k"), tree: tree(input) });
    w.emit({ type: "listener", nonce: w.of("hasListener").find((m) => m.which === "key")!.nonce, value: true });
    attach(el);
    const field = el.querySelector("input")!;
    field.focus();
    const typed = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
    field.dispatchEvent(typed);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true }));
    expect(typed.defaultPrevented).toBe(false);
    expect(sent(w, "key")).toEqual([]);
    expect(document.activeElement).toBe(field);
    const own = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    el.dispatchEvent(own);
    expect(own.defaultPrevented).toBe(true);
    expect(sent(w, "key")).toEqual([{ key: "a" }]);
  });

  it("focus : un re-rendu du parent redonne le focus au nouveau placeholder, sauf après Echap", async () => {
    const first = await mountOne();
    first.focus();
    expect(document.activeElement).toBe(first);
    const second = host.renderClient("t1", origin, nodeOf());
    first.remove();
    attach(second);
    await settle();
    expect(second).not.toBe(first);
    expect(document.activeElement).toBe(second);

    second.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(document.activeElement).not.toBe(second);
    const third = host.renderClient("t1", origin, nodeOf());
    second.remove();
    attach(third);
    await settle();
    expect(document.activeElement).not.toBe(third);
  });

  it("clavier : un ancêtre interactif hors du Client n'avale pas les touches du module", async () => {
    const el = await mountOne();
    const w = workers[0];
    w.emit({ type: "tree", id: idOf("k"), tree: tree("x") });
    w.emit({ type: "listener", nonce: w.of("hasListener").find((m) => m.which === "key")!.nonce, value: true });
    const wrapper = document.createElement("button");
    document.body.append(wrapper);
    wrapper.append(el);
    const ev = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
    el.dispatchEvent(ev);
    expect(sent(w, "key")).toEqual([{ key: "a" }]);
    wrapper.remove();
  });

  it("focus : un placeholder jamais rattaché ne laisse pas un drapeau qui volerait le focus plus tard", async () => {
    const first = await mountOne();
    first.focus();
    const detached = host.renderClient("t1", origin, nodeOf());
    first.remove();
    await settle();
    expect(detached.isConnected).toBe(false);
    const third = host.renderClient("t1", origin, nodeOf());
    attach(third);
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.activeElement).not.toBe(third);
  });

  it("dispose pendant le chargement : ni Worker ni URL créés", async () => {
    let resolve!: (b: ClientModuleBundle) => void;
    bridge.loadModule.mockReturnValue(new Promise((r) => { resolve = r; }));
    host.renderClient("t1", origin, nodeOf());
    host.dispose();
    resolve(bundle);
    await settle();
    expect(workers).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("un chargement remplacé par un changement de hash ne crée rien", async () => {
    const resolvers: ((b: ClientModuleBundle) => void)[] = [];
    bridge.loadModule.mockImplementation(() => new Promise((r) => { resolvers.push(r); }));
    host.renderClient("t1", origin, nodeOf());
    hash = "autre-hash";
    attach(host.renderClient("t1", origin, nodeOf()));
    resolvers[0](bundle);
    await settle();
    expect(workers).toHaveLength(0);
    resolvers[1](bundle);
    await settle();
    expect(workers).toHaveLength(1);
    expect(workers[0].of("mount")).toHaveLength(1);
  });

  it("chargement rejeté : pas de cache empoisonné, nouvelle tentative après 5 s", async () => {
    bridge.loadModule.mockRejectedValueOnce(new Error("timeout"));
    const el = await mountOne();
    expect(el.querySelector(".den-mod-client-fault")?.textContent).toContain("timeout");
    attach(host.renderClient("t1", origin, nodeOf()));
    await settle();
    expect(bridge.loadModule).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    attach(host.renderClient("t1", origin, nodeOf()));
    await settle();
    expect(bridge.loadModule).toHaveBeenCalledTimes(2);
    expect(workers[0].of("mount")).toHaveLength(1);
    expect(bridge.fault).toHaveBeenCalledTimes(1);
  });

  it("runtime en échec à l'init : Worker terminé, URL révoquées, nouvelle tentative après 5 s", async () => {
    await mountOne();
    workers[0].emit({ type: "fault", id: "", reason: "runtime cassé" });
    expect(workers[0].terminated).toBe(true);
    expect(revoked.sort()).toEqual([...created].sort());
    expect(bridge.fault).toHaveBeenCalledWith("t1", expect.anything(), "load", "runtime cassé");
    attach(host.renderClient("t1", origin, nodeOf()));
    await settle();
    expect(bridge.loadModule).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    attach(host.renderClient("t1", origin, nodeOf()));
    await settle();
    expect(bridge.loadModule).toHaveBeenCalledTimes(2);
    expect(workers[1].of("mount")).toHaveLength(1);
  });
});
