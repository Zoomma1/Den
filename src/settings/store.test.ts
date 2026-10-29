import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { effectiveMode, getSettings, listThemes, load, mergeSettings, parseSettings, save } from "./store";

describe("parseSettings", () => {
  it("accepte un objet valide", () => {
    expect(parseSettings('{"defaultPermissionMode":"plan","layoutPreset":"stacked","theme":"light"}')).toEqual({
      defaultPermissionMode: "plan",
      layoutPreset: "stacked",
      theme: "light",
    });
  });

  it("vide, absent ou illisible => objet vide", () => {
    expect(parseSettings("")).toEqual({});
    expect(parseSettings("{nope")).toEqual({});
    expect(parseSettings("[1]")).toEqual({});
  });

  it("liste blanche des modes : bypassPermissions et dontAsk refusés", () => {
    expect(parseSettings('{"defaultPermissionMode":"bypassPermissions"}')).toEqual({});
    expect(parseSettings('{"defaultPermissionMode":"dontAsk"}')).toEqual({});
    expect(parseSettings('{"defaultPermissionMode":"auto"}')).toEqual({ defaultPermissionMode: "auto" });
  });

  it("une valeur invalide est ignorée sans toucher aux autres clés", () => {
    expect(parseSettings('{"layoutPreset":"grid","theme":"  ","defaultPermissionMode":"plan"}')).toEqual({
      defaultPermissionMode: "plan",
    });
    expect(parseSettings('{"theme":3}')).toEqual({});
  });
});

describe("repli", () => {
  it("mode absent => default", () => {
    expect(effectiveMode({})).toBe("default");
    expect(effectiveMode({ defaultPermissionMode: "plan" })).toBe("plan");
  });
});

describe("mergeSettings", () => {
  it("préserve les clés inconnues et écrase la clé patchée", () => {
    const out = JSON.parse(mergeSettings('{"theme":"a","future":{"x":1}}', { theme: "b" }));
    expect(out).toEqual({ theme: "b", future: { x: 1 } });
  });

  it("repart d'un objet vide si le fichier est absent", () => {
    expect(JSON.parse(mergeSettings("", { layoutPreset: "stacked" }))).toEqual({ layoutPreset: "stacked" });
  });

  it("refuse d'écraser un JSON cassé ou non-objet", () => {
    expect(() => mergeSettings('{"theme":"a",}', { layoutPreset: "stacked" })).toThrow(/invalide/);
    expect(() => mergeSettings("[1]", { layoutPreset: "stacked" })).toThrow(/invalide/);
  });
});

describe("load / save / listThemes", () => {
  beforeEach(() => invokeMock.mockReset());

  it("load lit settings_read et valide", async () => {
    invokeMock.mockResolvedValueOnce('{"theme":"light","layoutPreset":"bad"}');
    expect(await load()).toEqual({ theme: "light" });
    expect(invokeMock).toHaveBeenCalledWith("settings_read");
    expect(getSettings()).toEqual({ theme: "light" });
  });

  it("save écrit l'objet complet fusionné via settings_write({ json })", async () => {
    invokeMock.mockResolvedValueOnce('{"theme":"light","extra":true}').mockResolvedValueOnce(undefined);
    await save({ defaultPermissionMode: "plan" });
    const [cmd, args] = invokeMock.mock.calls[1];
    expect(cmd).toBe("settings_write");
    expect(JSON.parse((args as { json: string }).json)).toEqual({
      theme: "light",
      extra: true,
      defaultPermissionMode: "plan",
    });
    expect(getSettings().defaultPermissionMode).toBe("plan");
  });

  it("deux save rapprochés conservent les deux patchs sur disque", async () => {
    let disk = "{}";
    invokeMock.mockImplementation(async (cmd: string, args?: { json: string }) => {
      if (cmd === "settings_read") return disk;
      if (cmd === "settings_write") disk = args!.json;
      return undefined;
    });
    await Promise.all([save({ theme: "light" }), save({ layoutPreset: "stacked" })]);
    expect(JSON.parse(disk)).toEqual({ theme: "light", layoutPreset: "stacked" });
  });

  it("un save refusé (JSON cassé) ne bloque pas les suivants", async () => {
    let disk = "{broken";
    invokeMock.mockImplementation(async (cmd: string, args?: { json: string }) => {
      if (cmd === "settings_read") return disk;
      if (cmd === "settings_write") disk = args!.json;
      return undefined;
    });
    await expect(save({ theme: "a" })).rejects.toThrow(/invalide/);
    disk = "{}";
    await save({ theme: "b" });
    expect(JSON.parse(disk)).toEqual({ theme: "b" });
  });

  it("listThemes appelle theme_list", async () => {
    invokeMock.mockResolvedValueOnce(["dark", "light"]);
    expect(await listThemes()).toEqual(["dark", "light"]);
    expect(invokeMock).toHaveBeenCalledWith("theme_list");
  });
});
