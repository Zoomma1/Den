// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOD_EVENTS, type ModRenderClient } from "./contracts";
import { createAboveBand } from "./band";
import type { RenderNode } from "./tree";

const tree = readFileSync(
  "src/mods/fixtures/responses-render.ndjson",
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l)?.response)
  .find((r) => r?.request_id === "den-ui-above").response.tree as RenderNode;

type Res = Awaited<ReturnType<ModRenderClient["requestRender"]>>;
const hooked: Res = { tree, hooked: true, rewritten: false };

let active: { dispose(): void } | undefined;

function setup(respond: () => Promise<Res> = async () => hooked) {
  const requestRender = vi.fn(
    (_tabId: string, req: Parameters<ModRenderClient["requestRender"]>[1]) => {
      void req;
      return respond();
    },
  );
  const renderTree = vi.fn((_node: RenderNode, _opts?: unknown) => {
    const el = document.createElement("div");
    el.className = "rendered";
    return el;
  });
  const handle = createAboveBand({ client: { requestRender }, renderTree });
  active = handle;
  return { requestRender, renderTree, handle };
}

const emit = (name: string, detail: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));
const tick = () => vi.advanceTimersByTimeAsync(150);
const band = () => document.querySelector<HTMLElement>(".den-mod-band");
const invalidateAbove = {
  tabId: "t1",
  instances: [{ component: "AbovePrompt", instanceId: "above-prompt" }],
};

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<main id="den-conversation"><form class="den-prompt-bar"></form></main>';
});
afterEach(() => {
  active?.dispose();
  vi.useRealTimers();
});

describe("createAboveBand", () => {
  it("s'insère juste avant la barre de prompt, masquée", () => {
    setup();
    expect(band()?.nextElementSibling?.className).toBe("den-prompt-bar");
    expect(band()?.hidden).toBe(true);
  });

  it("réessaie l'insertion au premier changement de tab si la barre manque", () => {
    document.body.innerHTML = '<main id="den-conversation"></main>';
    setup();
    expect(band()).toBeNull();
    document.getElementById("den-conversation")!.innerHTML =
      '<form class="den-prompt-bar"></form>';
    emit("den:active-tab-changed", { tabId: "t1" });
    expect(band()?.nextElementSibling?.className).toBe("den-prompt-bar");
  });

  it("rend l'arbre de la fixture pour le tab actif", async () => {
    const { requestRender, renderTree } = setup();
    emit("den:active-tab-changed", { tabId: "t1" });
    await tick();
    const [tabId, req] = requestRender.mock.calls[0];
    expect(tabId).toBe("t1");
    expect(req.component).toBe("AbovePrompt");
    expect(req.instanceId).toBe("above-prompt");
    expect(req.props).toMatchObject({ hasSurvey: false, isWorking: false });
    expect(req.props.maxRows as number).toBeLessThanOrEqual(8);
    expect(renderTree).toHaveBeenCalledWith(tree, undefined);
    expect(band()?.hidden).toBe(false);
    expect(band()?.querySelector(".rendered")).not.toBeNull();
  });

  it("masque la bande quand rien n'est hooké ou que l'arbre est engine", async () => {
    let res: Res = { tree: null, hooked: false, rewritten: false };
    const { renderTree } = setup(async () => res);
    emit("den:active-tab-changed", { tabId: "t1" });
    await tick();
    expect(band()?.hidden).toBe(true);
    res = { tree: { type: "engine", ref: 0 }, hooked: true, rewritten: false };
    emit(MOD_EVENTS.invalidate, invalidateAbove);
    await tick();
    expect(band()?.hidden).toBe(true);
    expect(renderTree).not.toHaveBeenCalled();
  });

  it("masque la bande quand le tab devient null", async () => {
    setup();
    emit("den:active-tab-changed", { tabId: "t1" });
    await tick();
    expect(band()?.hidden).toBe(false);
    emit("den:active-tab-changed", { tabId: null });
    expect(band()?.hidden).toBe(true);
  });

  it("re-rend sur invalidate AbovePrompt, pas sur un autre composant", async () => {
    const { requestRender } = setup();
    emit("den:active-tab-changed", { tabId: "t1" });
    await tick();
    emit(MOD_EVENTS.invalidate, {
      tabId: "t1",
      instances: [{ component: "Pane", instanceId: "p" }],
    });
    await tick();
    expect(requestRender).toHaveBeenCalledTimes(1);
    emit(MOD_EVENTS.invalidate, invalidateAbove);
    await tick();
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("re-rend avec isWorking sur tab-state-changed du tab actif", async () => {
    const { requestRender } = setup();
    emit("den:active-tab-changed", { tabId: "t1" });
    await tick();
    emit("den:tab-state-changed", { tabId: "other", state: "running" });
    await tick();
    expect(requestRender).toHaveBeenCalledTimes(1);
    emit("den:tab-state-changed", { tabId: "t1", state: "running" });
    await tick();
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(requestRender.mock.calls[1][1].props.isWorking).toBe(true);
  });

  it("regroupe les rafales en une seule demande", async () => {
    const { requestRender } = setup();
    emit("den:active-tab-changed", { tabId: "t1" });
    emit("den:tab-state-changed", { tabId: "t1", state: "running" });
    await tick();
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("ignore une réponse périmée après changement de tab", async () => {
    let resolveFirst!: (r: Res) => void;
    let n = 0;
    const { renderTree } = setup(() =>
      n++ === 0
        ? new Promise<Res>((r) => (resolveFirst = r))
        : Promise.resolve({ tree: null, hooked: false, rewritten: false }),
    );
    emit("den:active-tab-changed", { tabId: "t1" });
    await tick();
    emit("den:active-tab-changed", { tabId: "t2" });
    await tick();
    resolveFirst(hooked);
    await tick();
    expect(renderTree).not.toHaveBeenCalled();
    expect(band()?.hidden).toBe(true);
  });

  it("dispose retire la bande et les écouteurs", async () => {
    const { requestRender, handle } = setup();
    handle.dispose();
    expect(band()).toBeNull();
    emit("den:active-tab-changed", { tabId: "t1" });
    await tick();
    expect(requestRender).not.toHaveBeenCalled();
  });
});
