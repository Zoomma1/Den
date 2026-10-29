// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../layout", () => ({ setPreset: vi.fn() }));
vi.mock("../workspace", () => ({ getState: () => ({ layout: { preset: "side-by-side" } }) }));

import { createSettingsOverlay, type SettingsDeps } from "./index";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<SettingsDeps> = {}) {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const deps: SettingsDeps = {
    getSettings: () => ({}),
    save: vi.fn().mockResolvedValue(undefined),
    listThemes: vi.fn().mockResolvedValue(["dark", "light"]),
    openThemesDir: vi.fn().mockResolvedValue(undefined),
    getPreset: () => "side-by-side",
    setPreset: vi.fn(),
    isMac: true,
    ...over,
  };
  const overlay = createSettingsOverlay(host, deps);
  const backdrop = host.querySelector(".den-settings-backdrop") as HTMLElement;
  return { host, deps, overlay, backdrop };
}

describe("createSettingsOverlay", () => {
  beforeEach(() => document.body.replaceChildren());

  it("open / close / toggle", () => {
    const { overlay, backdrop } = setup();
    expect(backdrop.hidden).toBe(true);
    overlay.open();
    expect(overlay.isOpen()).toBe(true);
    expect(backdrop.hidden).toBe(false);
    overlay.toggle();
    expect(overlay.isOpen()).toBe(false);
  });

  it("dialog accessible", () => {
    const { host, overlay } = setup();
    overlay.open();
    const d = host.querySelector(".den-settings-overlay") as HTMLElement;
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
  });

  it("Escape ferme, clic backdrop ferme, clic dans le dialog non", () => {
    const { host, overlay, backdrop } = setup();
    overlay.open();
    host.querySelector<HTMLElement>(".den-settings-overlay")!.click();
    expect(overlay.isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(overlay.isOpen()).toBe(false);
    overlay.open();
    backdrop.click();
    expect(overlay.isOpen()).toBe(false);
  });

  it("restaure le focus à la fermeture", () => {
    const { host, overlay } = setup();
    const btn = document.createElement("button");
    host.append(btn);
    btn.focus();
    overlay.open();
    overlay.close();
    expect(document.activeElement).toBe(btn);
  });

  it("Mod+, ouvre puis ferme", () => {
    const { overlay } = setup({ isMac: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true }));
    expect(overlay.isOpen()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true }));
    expect(overlay.isOpen()).toBe(false);
  });

  it("sections Session / Display / Help, légende des statuts et raccourcis", async () => {
    const { host, overlay } = setup();
    overlay.open();
    await flush();
    const titles = [...host.querySelectorAll(".den-settings-section__title")].map((n) => n.textContent);
    expect(titles).toEqual(["Session", "Display", "Help"]);
    expect(host.textContent).toContain("Applies to new sessions");
    expect(host.querySelectorAll(".den-settings-legend__item")).toHaveLength(4);
    expect(host.querySelector(".den-settings-shortcuts__combo")!.textContent).toBe("⌘B");
    const themes = [...host.querySelectorAll<HTMLOptionElement>(".den-settings-select option")].map((o) => o.value);
    expect(themes).toEqual(expect.arrayContaining(["dark", "light"]));
  });

  it("changement de mode => save({ defaultPermissionMode })", () => {
    const { host, deps, overlay } = setup();
    overlay.open();
    const select = host.querySelector<HTMLSelectElement>(".den-settings-select")!;
    select.value = "plan";
    select.dispatchEvent(new Event("change"));
    expect(deps.save).toHaveBeenCalledWith({ defaultPermissionMode: "plan" });
  });

  it("changement de layout => setPreset + save({ layoutPreset })", () => {
    const { host, deps, overlay } = setup();
    overlay.open();
    const select = host.querySelectorAll<HTMLSelectElement>(".den-settings-select")[1];
    select.value = "stacked";
    select.dispatchEvent(new Event("change"));
    expect(deps.setPreset).toHaveBeenCalledWith("stacked");
    expect(deps.save).toHaveBeenCalledWith({ layoutPreset: "stacked" });
  });

  it("changement de thème => save({ theme })", async () => {
    const { host, deps, overlay } = setup();
    overlay.open();
    await flush();
    const select = host.querySelectorAll<HTMLSelectElement>(".den-settings-select")[2];
    select.value = "light";
    select.dispatchEvent(new Event("change"));
    expect(deps.save).toHaveBeenCalledWith({ theme: "light" });
  });

  it("le bouton « Open themes folder » appelle openThemesDir", async () => {
    const { overlay, deps, backdrop } = setup();
    overlay.open();
    await flush();
    (backdrop.querySelector(".den-settings-open-themes") as HTMLButtonElement).click();
    expect(deps.openThemesDir).toHaveBeenCalledTimes(1);
  });

  it("« Refresh themes » relit theme_list et reconstruit le sélecteur", async () => {
    const listThemes = vi.fn().mockResolvedValueOnce(["dark"]).mockResolvedValueOnce(["dark", "nouveau"]);
    const { overlay, backdrop } = setup({ listThemes });
    overlay.open();
    await flush();
    const refresh = Array.from(backdrop.querySelectorAll(".den-settings-open-themes")).find(
      (b) => b.textContent === "Refresh themes",
    ) as HTMLButtonElement;
    refresh.click();
    await flush();
    expect(listThemes).toHaveBeenCalledTimes(2);
    expect(backdrop.textContent).toContain("nouveau");
  });
});
