// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { handleLinkClick } from "./links";

function run(href: string, inner = false, type = "click", init: MouseEventInit = {}, preventFirst = false) {
  const open = vi.fn();
  const a = document.createElement("a");
  a.setAttribute("href", href);
  const span = document.createElement("span");
  a.appendChild(span);
  document.body.appendChild(a);
  if (preventFirst) a.addEventListener(type, (e) => e.preventDefault());
  a.addEventListener(type, (e) => handleLinkClick(e as MouseEvent, open));
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  (inner ? span : a).dispatchEvent(event);
  return { open, event };
}

describe("handleLinkClick", () => {
  it("ouvre http et empêche la navigation", () => {
    const { open, event } = run("http://example.com/");
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith("http://example.com/");
  });
  it("ouvre https et mailto", () => {
    expect(run("https://a.io/x").open).toHaveBeenCalledTimes(1);
    expect(run("mailto:a@b.c").open).toHaveBeenCalledTimes(1);
  });
  it("ignore un clic déjà traité (lien de mod) pour ne pas ouvrir deux fois", () => {
    expect(run("https://a.io/", false, "click", {}, true).open).not.toHaveBeenCalled();
  });
  it("auxclick : seul le bouton du milieu ouvre, pas le clic droit", () => {
    expect(run("https://a.io/", false, "auxclick", { button: 1 }).open).toHaveBeenCalledTimes(1);
    expect(run("https://a.io/", false, "auxclick", { button: 2 }).open).not.toHaveBeenCalled();
  });
  it("trouve le lien depuis un enfant", () => {
    expect(run("https://a.io/", true).open).toHaveBeenCalledTimes(1);
  });
  it("ignore javascript: mais empêche la navigation", () => {
    const { open, event } = run("javascript:alert(1)");
    expect(open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
  it("ignore les href relatifs", () => {
    const { open, event } = run("/foo");
    expect(open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
  it("ignore un clic hors lien", () => {
    const open = vi.fn();
    const div = document.createElement("div");
    div.addEventListener("click", (e) => handleLinkClick(e, open));
    const event = new MouseEvent("click", { cancelable: true });
    div.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
