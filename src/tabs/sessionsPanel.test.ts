// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionsPanel, type SessionCard } from "./sessionsPanel";

const card = (tabId: string, over: Partial<SessionCard> = {}): SessionCard => ({
  tabId,
  projectName: `proj-${tabId}`,
  sessionId: null,
  status: null,
  activity: "",
  active: false,
  ...over,
});

function setup() {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const onJump = vi.fn();
  const panel = createSessionsPanel(host, { onJump });
  const backdrop = host.querySelector(".den-sessions-backdrop") as HTMLElement;
  const cards = () => [...host.querySelectorAll<HTMLButtonElement>(".den-sessions-card")];
  return { host, panel, onJump, backdrop, cards };
}

const badge = (p: { triggerEl: HTMLElement }) =>
  p.triggerEl.querySelector(".den-sessions-trigger__badge") as HTMLElement;

describe("createSessionsPanel", () => {
  beforeEach(() => document.body.replaceChildren());

  it("open / close / toggle", () => {
    const { panel, backdrop } = setup();
    expect(panel.isOpen()).toBe(false);
    expect(backdrop.hidden).toBe(true);
    panel.open();
    expect(panel.isOpen()).toBe(true);
    expect(backdrop.hidden).toBe(false);
    panel.toggle();
    expect(panel.isOpen()).toBe(false);
    expect(backdrop.hidden).toBe(true);
  });

  it("Escape et clic backdrop ferment, clic dans le dialog non", () => {
    const { panel, backdrop, host } = setup();
    panel.open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel.isOpen()).toBe(false);
    panel.open();
    (host.querySelector(".den-sessions-panel") as HTMLElement).click();
    expect(panel.isOpen()).toBe(true);
    backdrop.click();
    expect(panel.isOpen()).toBe(false);
  });

  it("rend le focus à l'élément précédent à la fermeture", () => {
    const { panel, host } = setup();
    const other = document.createElement("button");
    host.appendChild(other);
    other.focus();
    panel.setCards([card("a")]);
    panel.open();
    expect(document.activeElement).not.toBe(other);
    panel.close();
    expect(document.activeElement).toBe(other);
  });

  it("clic sur une card appelle onJump(tabId)", () => {
    const { panel, onJump, cards } = setup();
    panel.setCards([card("a"), card("b")]);
    cards()[1].click();
    expect(onJump).toHaveBeenCalledWith("b");
  });

  it("met à jour en place par tabId et retire les cards disparues", () => {
    const { panel, cards } = setup();
    panel.setCards([card("a", { activity: "one" }), card("b")]);
    const [elA] = cards();
    panel.setCards([card("a", { activity: "two", status: "running", active: true })]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toBe(elA);
    expect(elA.querySelector(".den-sessions-card__activity")!.textContent).toBe("two");
    expect(elA.getAttribute("data-status")).toBe("running");
    expect(elA.getAttribute("aria-current")).toBe("true");
  });

  it("statut null = Idle sans data-status ; libellé issu de STATUS_META", () => {
    const { panel, cards } = setup();
    panel.setCards([card("a"), card("b", { status: "needs_input" })]);
    const [a, b] = cards();
    expect(a.hasAttribute("data-status")).toBe(false);
    expect(a.querySelector(".den-sessions-card__status")!.textContent).toBe("Idle");
    expect(b.querySelector(".den-sessions-card__status")!.textContent).toBe("Needs input");
  });

  it("n'interprète pas le texte de session comme du HTML", () => {
    const { panel, cards } = setup();
    panel.setCards([card("a", { activity: "<img src=x onerror=1>" })]);
    expect(cards()[0].querySelector("img")).toBeNull();
  });

  it("badge : masqué à 0, compte les needs_input", () => {
    const { panel } = setup();
    panel.setCards([card("a", { status: "running" })]);
    expect(badge(panel).hidden).toBe(true);
    panel.setCards([card("a", { status: "needs_input" }), card("b", { status: "needs_input" })]);
    expect(badge(panel).hidden).toBe(false);
    expect(badge(panel).textContent).toBe("2");
    panel.setCards([card("a")]);
    expect(badge(panel).hidden).toBe(true);
  });

  it("affiche le sessionId court (8 caractères)", () => {
    const { panel, cards } = setup();
    panel.setCards([card("a", { sessionId: "abcdef1234567890" }), card("b")]);
    const [a, b] = cards();
    expect(a.querySelector(".den-sessions-card__sid")!.textContent).toBe("abcdef12");
    expect(b.querySelector(".den-sessions-card__sid")!.textContent).toBe("");
  });

  it("ne réécrit pas le DOM si les valeurs sont identiques", () => {
    const { panel, cards } = setup();
    panel.setCards([card("a", { activity: "same", status: "running" })]);
    const els = cards()[0];
    const act = els.querySelector(".den-sessions-card__activity")!;
    const textNode = act.firstChild;
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(els, { subtree: true, childList: true, characterData: true, attributes: true });
    panel.setCards([card("a", { activity: "same", status: "running" })]);
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(records).toHaveLength(0);
    expect(act.firstChild).toBe(textNode);
  });

  it("le bouton trigger bascule le panneau", () => {
    const { panel } = setup();
    panel.triggerEl.click();
    expect(panel.isOpen()).toBe(true);
    panel.triggerEl.click();
    expect(panel.isOpen()).toBe(false);
  });

  it("raccourci mod+Shift+S bascule, ignore repeat et sans Shift", () => {
    const { panel } = setup();
    const mac = /Mac/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform);
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const fire = (init: KeyboardEventInit) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "S", ...init, cancelable: true }));
    fire({ ...mod, shiftKey: true });
    expect(panel.isOpen()).toBe(true);
    fire({ ...mod, shiftKey: true, repeat: true });
    expect(panel.isOpen()).toBe(true);
    fire({ ...mod });
    expect(panel.isOpen()).toBe(true);
    fire({ ...mod, shiftKey: true });
    expect(panel.isOpen()).toBe(false);
  });
});
