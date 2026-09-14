import { describe, expect, it } from "vitest";
import {
  basename,
  ownerKey,
  resolveCwd,
  shortPath,
} from "./owner";
import { defaultState, type PersistedState } from "../workspace/store";

function makeState(overrides: Partial<PersistedState> = {}): PersistedState {
  return { ...defaultState(), ...overrides };
}

describe("ownerKey", () => {
  it('"root" pour la racine', () => {
    expect(ownerKey({ kind: "root", id: null })).toBe("root");
  });

  it('"workspace:<id>" pour un workspace', () => {
    expect(ownerKey({ kind: "workspace", id: "ws-1" })).toBe("workspace:ws-1");
  });

  it('"project:<id>" pour un projet', () => {
    expect(ownerKey({ kind: "project", id: "p-1" })).toBe("project:p-1");
  });
});

describe("resolveCwd", () => {
  const state = makeState({
    workspaces: [
      { id: "ws-1", name: "Minlay", rootPath: "/Users/vico/Dev/minlay" },
      { id: "ws-2", name: "Sans racine", rootPath: null },
    ],
    projects: [{ id: "p-1", workspaceId: "ws-1", path: "/Users/vico/Dev/minlay/front" }],
  });

  it("project connu -> son path", () => {
    expect(resolveCwd({ kind: "project", id: "p-1" }, state, null)).toBe(
      "/Users/vico/Dev/minlay/front",
    );
  });

  it("project inconnu (disparu) -> null", () => {
    expect(resolveCwd({ kind: "project", id: "ghost" }, state, null)).toBeNull();
  });

  it("workspace avec racine -> rootPath", () => {
    expect(resolveCwd({ kind: "workspace", id: "ws-1" }, state, null)).toBe(
      "/Users/vico/Dev/minlay",
    );
  });

  it("workspace sans racine -> null", () => {
    expect(resolveCwd({ kind: "workspace", id: "ws-2" }, state, null)).toBeNull();
  });

  it("workspace inconnu -> null", () => {
    expect(resolveCwd({ kind: "workspace", id: "ghost" }, state, null)).toBeNull();
  });

  it("root avec pickedPath -> pickedPath", () => {
    expect(resolveCwd({ kind: "root", id: null }, state, "/tmp/chosen")).toBe("/tmp/chosen");
  });

  it("root avec pickedPath null -> null", () => {
    expect(resolveCwd({ kind: "root", id: null }, state, null)).toBeNull();
  });
});

describe("basename", () => {
  it("dernier segment non vide", () => {
    expect(basename("/Users/vico/Dev/Den")).toBe("Den");
  });

  it("segment unique sans slash", () => {
    expect(basename("Den")).toBe("Den");
  });

  it('"/" -> "/"', () => {
    expect(basename("/")).toBe("/");
  });

  it('chaîne vide -> "/"', () => {
    expect(basename("")).toBe("/");
  });

  it("slash final ignoré (dernier segment non vide)", () => {
    expect(basename("/Users/vico/Dev/Den/")).toBe("Den");
  });
});

describe("shortPath", () => {
  const home = "/Users/vico";

  it("path === home -> ~", () => {
    expect(shortPath("/Users/vico", home)).toBe("~");
  });

  it("path sous home -> ~/reste", () => {
    expect(shortPath("/Users/vico/Dev/x", home)).toBe("~/Dev/x");
  });

  it("path avec le même préfixe textuel mais pas un vrai sous-dossier -> inchangé", () => {
    expect(shortPath("/Users/vicoX", home)).toBe("/Users/vicoX");
  });

  it("path sans rapport avec home -> inchangé", () => {
    expect(shortPath("/Volumes/a", home)).toBe("/Volumes/a");
  });

  it("home null -> path inchangé", () => {
    expect(shortPath("/Users/vico/Dev/x", null)).toBe("/Users/vico/Dev/x");
  });
});
