// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { createAgentsOverlay } from "./agentsOverlay";
import type { Subagent } from "./subagents";

const agent = (taskId: string, over: Partial<Subagent> = {}): Subagent => ({
  taskId,
  description: `desc-${taskId}`,
  status: "running",
  steps: [],
  stepCount: over.steps?.length ?? 0,
  depth: 1,
  turnsSinceEnd: 0,
  ...over,
});

const txt = (text: string) => ({ kind: "text" as const, text, truncated: false });

function setup() {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const overlay = createAgentsOverlay(host);
  const backdrop = host.querySelector(".den-agents-backdrop") as HTMLElement;
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>(".den-agents-row")];
  const detail = host.querySelector(".den-agents-overlay__detail") as HTMLElement;
  return { host, overlay, backdrop, rows, detail };
}

const badge = (o: { triggerEl: HTMLElement }) => o.triggerEl.querySelector(".den-agents-trigger__badge") as HTMLElement;

describe("createAgentsOverlay", () => {
  beforeEach(() => document.body.replaceChildren());

  it("trigger toujours visible, badge = agents running", () => {
    const { overlay } = setup();
    overlay.setAgents([]);
    expect(overlay.triggerEl.hidden).toBe(false);
    expect(badge(overlay).hidden).toBe(true);
    overlay.setAgents([agent("a"), agent("b", { status: "completed" })]);
    expect(overlay.triggerEl.hidden).toBe(false);
    expect(badge(overlay).textContent).toBe("1");
    overlay.setAgents([agent("a", { status: "completed" })]);
    expect(badge(overlay).hidden).toBe(true);
  });

  it("ouvre et ferme (Escape, backdrop, pas le dialog)", () => {
    const { overlay, backdrop, host } = setup();
    overlay.setAgents([agent("a")]);
    overlay.open();
    expect(overlay.isOpen()).toBe(true);
    expect(backdrop.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(overlay.isOpen()).toBe(false);
    overlay.open();
    (host.querySelector(".den-agents-overlay") as HTMLElement).click();
    expect(overlay.isOpen()).toBe(true);
    backdrop.click();
    expect(overlay.isOpen()).toBe(false);
  });

  it("liste à plat avec indentation, sélection au clic", () => {
    const { overlay, rows, detail } = setup();
    overlay.setAgents([
      agent("a", { subagentType: "Explore", usage: { totalTokens: 1500, toolUses: 2, durationMs: 65000 } }),
      agent("b", { depth: 2, prompt: "do b" }),
    ]);
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toBe("Explore · desc-a · Running · 1m05s · 1.5k tok");
    expect(rows()[1].style.paddingLeft).not.toBe(rows()[0].style.paddingLeft);
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    rows()[1].click();
    expect(rows()[1].getAttribute("aria-current")).toBe("true");
    expect(detail.querySelector(".den-agents-task__prompt")?.textContent).toBe("do b");
  });

  it("détail : prompt replié, étapes, rapport markdown", () => {
    const { overlay, detail } = setup();
    overlay.setAgents([
      agent("a", {
        prompt: "the task",
        report: "**done**",
        steps: [
          { kind: "text", text: "thinking", truncated: false },
          { kind: "tool_use", name: "Read", text: '{"p":1}', truncated: true },
          { kind: "tool_result", text: "boom", truncated: false, isError: true },
        ],
      }),
    ]);
    expect((detail.querySelector(".den-agents-task") as HTMLDetailsElement).open).toBe(false);
    expect(detail.querySelector(".den-agents-step--text")?.textContent).toBe("thinking");
    const tool = detail.querySelector(".den-agents-step--tool") as HTMLDetailsElement;
    expect(tool.open).toBe(false);
    expect(tool.querySelector("summary")?.firstChild?.textContent).toBe("Read");
    expect(tool.querySelector(".den-agents-step__preview")?.textContent).toBe('{"p":1}');
    expect(tool.textContent).toContain("(truncated)");
    const result = detail.querySelector(".den-agents-step--result") as HTMLDetailsElement;
    expect(result.classList.contains("den-agents-step--error")).toBe(true);
    expect(result.open).toBe(false);
    expect(result.querySelector("summary")?.firstChild?.textContent).toBe("Error");
    expect(detail.querySelector(".den-agents-report strong")?.textContent).toBe("Report");
    expect(detail.querySelector(".den-agents-report .den-msg-finalized strong")?.textContent).toBe("done");
  });

  it("ajoute une étape sans reconstruire les précédentes", () => {
    const { overlay, detail } = setup();
    const s1 = { kind: "text" as const, text: "one", truncated: false };
    overlay.setAgents([agent("a", { steps: [s1] })]);
    const first = detail.querySelector(".den-agents-step") as HTMLElement;
    overlay.setAgents([agent("a", { steps: [s1, { kind: "text", text: "two", truncated: false }] })]);
    const steps = detail.querySelectorAll(".den-agents-step");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBe(first);
  });

  it("au-delà du plafond : nouvelles étapes affichées, anciennes conservées", () => {
    const { overlay, detail } = setup();
    const win = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => txt(`s${from + i}`));
    overlay.setAgents([agent("a", { steps: win(0, 200), stepCount: 200 })]);
    expect(detail.querySelectorAll(".den-agents-step")).toHaveLength(200);
    // 3 nouvelles étapes : la fenêtre glisse, steps.length reste 200.
    overlay.setAgents([agent("a", { steps: win(3, 203), stepCount: 203 })]);
    const nodes = [...detail.querySelectorAll(".den-agents-step")];
    expect(nodes).toHaveLength(200);
    expect(nodes[nodes.length - 1].textContent).toBe("s202");
    expect(nodes[0].textContent).toBe("s3");
    // 2 étapes évincées avant rendu : on rend tout ce qui est disponible.
    overlay.setAgents([agent("a", { steps: win(205, 405), stepCount: 405 })]);
    const after = [...detail.querySelectorAll(".den-agents-step")];
    expect(after).toHaveLength(200);
    expect(after[after.length - 1].textContent).toBe("s404");
  });

  it("même référence de liste : aucune mutation DOM", () => {
    const { overlay, host } = setup();
    const list = [agent("a", { steps: [txt("one")] })];
    overlay.setAgents(list);
    const records: MutationRecord[] = [];
    const obs = new MutationObserver((r) => records.push(...r));
    obs.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    overlay.setAgents(list);
    records.push(...obs.takeRecords());
    obs.disconnect();
    expect(records).toHaveLength(0);
  });

  it("rapport masqué tant qu'il n'est pas défini", () => {
    const { overlay, detail } = setup();
    overlay.setAgents([agent("a")]);
    const report = detail.querySelector(".den-agents-report") as HTMLElement;
    expect(report.hidden).toBe(true);
    overlay.setAgents([agent("a", { report: "ok" })]);
    expect(report.hidden).toBe(false);
  });

  it("sélection conservée, repli sur le premier si l'agent est retiré", () => {
    const { overlay, rows } = setup();
    overlay.setAgents([agent("a"), agent("b")]);
    rows()[1].click();
    overlay.setAgents([agent("a"), agent("b", { status: "completed" })]);
    expect(rows()[1].getAttribute("aria-current")).toBe("true");
    overlay.setAgents([agent("a")]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
  });

  it("sans agent : s'ouvre avec un message vide, focus dans le dialog", () => {
    const { overlay, detail } = setup();
    overlay.open();
    expect(overlay.isOpen()).toBe(true);
    expect(detail.textContent).toBe("No agents in this session");
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
  });

  it("Tab reste dans le dialog (dernier élément -> premier, focus extérieur -> dedans)", () => {
    const { overlay, host } = setup();
    overlay.setAgents([agent("a"), agent("b")]);
    overlay.open();
    const items = [...host.querySelectorAll<HTMLElement>(".den-agents-overlay button, .den-agents-overlay summary")];
    const [first, last] = [items[0], items[items.length - 1]];
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const outside = document.createElement("textarea");
    document.body.append(outside);
    outside.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    expect(document.activeElement).toBe(first);
  });

  it("liste vidée overlay ouvert : message vide au lieu de deux volets blancs", () => {
    const { overlay, detail } = setup();
    overlay.setAgents([agent("a")]);
    overlay.open();
    overlay.setAgents([]);
    expect(detail.textContent).toBe("No agents in this session");
  });
});
