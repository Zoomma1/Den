import { describe, expect, it } from "vitest";
import {
  createStore,
  defaultState,
  displayName,
  parsePersistedState,
  projectsOfWorkspace,
  serializePersistedState,
  tryParsePersistedState,
  withoutProject,
  withoutWorkspace,
  type PersistedState,
  type Project,
  type StateIO,
} from "./store";

describe("tryParsePersistedState / parsePersistedState / serializePersistedState (v2)", () => {
  it("roundtrips a valid v2 state (2 workspaces, 3 projects, layout)", () => {
    const state: PersistedState = {
      version: 2,
      workspaces: [
        { id: "ws-1", name: "Perso", rootPath: null },
        { id: "ws-2", name: "Minlay", rootPath: "/Users/vico/Dev/minlay" },
      ],
      projects: [
        { id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" },
        { id: "b", workspaceId: "ws-2", path: "/Users/vico/Dev/minlay/api" },
        { id: "c", workspaceId: "ws-2", path: "/Users/vico/Dev/minlay/front" },
      ],
      layout: {
        preset: "stacked",
        sizes: {
          "side-by-side": { sidebarPx: 260, conversationRatio: 0.5 },
          stacked: { sidebarPx: 240, conversationRatio: 0.7 },
        },
      },
    };
    expect(parsePersistedState(serializePersistedState(state))).toEqual(state);
    expect(tryParsePersistedState(serializePersistedState(state))).toEqual({
      state,
      migratedFrom: null,
    });
  });

  it("migrates a valid v1 payload into a single « Défaut » workspace, all projects reattached", () => {
    const v1 = {
      version: 1,
      projects: [
        { id: "a", path: "/Users/vico/Dev/Den" },
        { id: "b", path: "/Users/vico/04 - Projects/tmafr-clients" },
      ],
      layout: defaultState().layout,
    };
    const result = tryParsePersistedState(JSON.stringify(v1), () => "ws-1");
    expect(result).toEqual({
      state: {
        version: 2,
        workspaces: [{ id: "ws-1", name: "Défaut", rootPath: null }],
        projects: [
          { id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" },
          { id: "b", workspaceId: "ws-1", path: "/Users/vico/04 - Projects/tmafr-clients" },
        ],
        layout: v1.layout,
      },
      migratedFrom: 1,
    });
  });

  it("returns null for an invalid v1 payload (project missing path)", () => {
    const raw = JSON.stringify({
      version: 1,
      projects: [{ id: "a" }],
      layout: defaultState().layout,
    });
    expect(tryParsePersistedState(raw)).toBeNull();
  });

  it("returns null for a v2 payload with an orphan project (unknown workspaceId)", () => {
    const raw = JSON.stringify({
      version: 2,
      workspaces: [{ id: "ws-1", name: "Défaut", rootPath: null }],
      projects: [{ id: "a", workspaceId: "ws-unknown", path: "/tmp/a" }],
      layout: defaultState().layout,
    });
    expect(tryParsePersistedState(raw)).toBeNull();
  });

  it("returns null for a v2 workspace with undefined rootPath", () => {
    const raw = JSON.stringify({
      version: 2,
      workspaces: [{ id: "ws-1", name: "Défaut" }],
      projects: [],
      layout: defaultState().layout,
    });
    expect(tryParsePersistedState(raw)).toBeNull();
  });

  it("returns null for a v2 workspace with a numeric rootPath", () => {
    const raw = JSON.stringify({
      version: 2,
      workspaces: [{ id: "ws-1", name: "Défaut", rootPath: 42 }],
      projects: [],
      layout: defaultState().layout,
    });
    expect(tryParsePersistedState(raw)).toBeNull();
  });

  it("returns null for a v2 workspace missing name", () => {
    const raw = JSON.stringify({
      version: 2,
      workspaces: [{ id: "ws-1", rootPath: null }],
      projects: [],
      layout: defaultState().layout,
    });
    expect(tryParsePersistedState(raw)).toBeNull();
  });

  it("returns null for an unknown version", () => {
    const raw = JSON.stringify({
      version: 3,
      workspaces: [],
      projects: [],
      layout: defaultState().layout,
    });
    expect(tryParsePersistedState(raw)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(tryParsePersistedState("not json {{{")).toBeNull();
  });

  it("treats an empty file as the default state", () => {
    expect(parsePersistedState("")).toEqual(defaultState());
    expect(tryParsePersistedState("")).toBeNull();
  });

  it("returns null when layout is malformed", () => {
    const raw = JSON.stringify({
      version: 2,
      workspaces: [],
      projects: [],
      layout: { preset: "stackd", sizes: {} },
    });
    expect(tryParsePersistedState(raw)).toBeNull();
  });

  it("parsePersistedState falls back to the default state on any invalid payload", () => {
    expect(parsePersistedState("not json {{{")).toEqual(defaultState());
  });
});

describe("displayName", () => {
  it("returns the basename when there is no collision", () => {
    const projects: Project[] = [{ id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" }];
    expect(displayName(projects[0], projects)).toBe("Den");
  });

  it("returns parent/basename on a basename collision", () => {
    const projects: Project[] = [
      { id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" },
      { id: "b", workspaceId: "ws-1", path: "/Users/vico/04 - Projects/Den" },
    ];
    expect(displayName(projects[0], projects)).toBe("Dev/Den");
    expect(displayName(projects[1], projects)).toBe("04 - Projects/Den");
  });

  it("climbs past parent/basename when both also collide at that depth (collision à 2 niveaux)", () => {
    const projects: Project[] = [
      { id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" },
      { id: "b", workspaceId: "ws-1", path: "/Volumes/x/Dev/Den" },
    ];
    expect(displayName(projects[0], projects)).toBe("vico/Dev/Den");
    expect(displayName(projects[1], projects)).toBe("x/Dev/Den");
  });

  it("stops climbing once the other project's path is a complete suffix (path plus court épuisé)", () => {
    const projects: Project[] = [
      { id: "a", workspaceId: "ws-1", path: "/Users/vico/Dev/Den" },
      { id: "b", workspaceId: "ws-1", path: "/Dev/Den" },
    ];
    expect(displayName(projects[0], projects)).toBe("vico/Dev/Den");
    expect(displayName(projects[1], projects)).toBe("Dev/Den");
  });

  it("falls back to the raw path for the filesystem root", () => {
    const projects: Project[] = [{ id: "a", workspaceId: "ws-1", path: "/" }];
    expect(displayName(projects[0], projects)).toBe("/");
  });
});

describe("displayName par workspace (via projectsOfWorkspace)", () => {
  it("two same-basename projects in DIFFERENT workspaces both display as the plain basename", () => {
    const state: PersistedState = {
      ...defaultState(),
      workspaces: [
        { id: "ws-a", name: "A", rootPath: null },
        { id: "ws-b", name: "B", rootPath: null },
      ],
      projects: [
        { id: "p1", workspaceId: "ws-a", path: "/Users/vico/a/front" },
        { id: "p2", workspaceId: "ws-b", path: "/Users/vico/b/front" },
      ],
    };
    const [p1, p2] = state.projects;
    expect(displayName(p1, projectsOfWorkspace(state, p1.workspaceId))).toBe("front");
    expect(displayName(p2, projectsOfWorkspace(state, p2.workspaceId))).toBe("front");
  });

  it("two same-basename projects in the SAME workspace collide", () => {
    const state: PersistedState = {
      ...defaultState(),
      workspaces: [{ id: "ws-a", name: "A", rootPath: null }],
      projects: [
        { id: "p1", workspaceId: "ws-a", path: "/Users/vico/a/front" },
        { id: "p2", workspaceId: "ws-a", path: "/Users/vico/b/front" },
      ],
    };
    const [p1, p2] = state.projects;
    expect(displayName(p1, projectsOfWorkspace(state, p1.workspaceId))).toBe("a/front");
    expect(displayName(p2, projectsOfWorkspace(state, p2.workspaceId))).toBe("b/front");
  });
});

describe("projectsOfWorkspace", () => {
  it("filters projects by workspaceId", () => {
    const state: PersistedState = {
      ...defaultState(),
      workspaces: [
        { id: "ws-a", name: "A", rootPath: null },
        { id: "ws-b", name: "B", rootPath: null },
      ],
      projects: [
        { id: "p1", workspaceId: "ws-a", path: "/tmp/a1" },
        { id: "p2", workspaceId: "ws-b", path: "/tmp/b1" },
        { id: "p3", workspaceId: "ws-a", path: "/tmp/a2" },
      ],
    };
    expect(projectsOfWorkspace(state, "ws-a").map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(projectsOfWorkspace(state, "ws-b").map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("withoutProject", () => {
  it("removes the project matching the id", () => {
    const state = defaultState();
    state.projects.push(
      { id: "a", workspaceId: "ws-1", path: "/tmp/a" },
      { id: "b", workspaceId: "ws-1", path: "/tmp/b" },
    );
    expect(withoutProject(state, "a").projects).toEqual([
      { id: "b", workspaceId: "ws-1", path: "/tmp/b" },
    ]);
  });

  it("does not mutate the input state", () => {
    const state = defaultState();
    state.projects.push({ id: "a", workspaceId: "ws-1", path: "/tmp/a" });
    withoutProject(state, "a");
    expect(state.projects).toEqual([{ id: "a", workspaceId: "ws-1", path: "/tmp/a" }]);
  });

  it("returns the same content when the id is unknown", () => {
    const state = defaultState();
    state.projects.push({ id: "a", workspaceId: "ws-1", path: "/tmp/a" });
    const result = withoutProject(state, "unknown-id");
    expect(result.projects).toEqual(state.projects);
    expect(result).not.toBe(state);
  });
});

describe("withoutWorkspace", () => {
  it("removes the workspace and its projects, leaves the others untouched", () => {
    const state: PersistedState = {
      ...defaultState(),
      workspaces: [
        { id: "ws-a", name: "A", rootPath: null },
        { id: "ws-b", name: "B", rootPath: null },
      ],
      projects: [
        { id: "p1", workspaceId: "ws-a", path: "/tmp/a1" },
        { id: "p2", workspaceId: "ws-b", path: "/tmp/b1" },
      ],
    };
    const result = withoutWorkspace(state, "ws-a");
    expect(result.workspaces).toEqual([{ id: "ws-b", name: "B", rootPath: null }]);
    expect(result.projects).toEqual([{ id: "p2", workspaceId: "ws-b", path: "/tmp/b1" }]);
  });

  it("does not mutate the input state", () => {
    const state: PersistedState = {
      ...defaultState(),
      workspaces: [{ id: "ws-a", name: "A", rootPath: null }],
      projects: [{ id: "p1", workspaceId: "ws-a", path: "/tmp/a1" }],
    };
    withoutWorkspace(state, "ws-a");
    expect(state.workspaces).toEqual([{ id: "ws-a", name: "A", rootPath: null }]);
    expect(state.projects).toEqual([{ id: "p1", workspaceId: "ws-a", path: "/tmp/a1" }]);
  });

  it("returns the same content when the id is unknown", () => {
    const state: PersistedState = {
      ...defaultState(),
      workspaces: [{ id: "ws-a", name: "A", rootPath: null }],
      projects: [{ id: "p1", workspaceId: "ws-a", path: "/tmp/a1" }],
    };
    const result = withoutWorkspace(state, "unknown-id");
    expect(result.workspaces).toEqual(state.workspaces);
    expect(result.projects).toEqual(state.projects);
    expect(result).not.toBe(state);
  });
});

describe("createStore", () => {
  it("load() renders { state, migratedFrom: 1 } on a v1 raw payload", async () => {
    const v1 = {
      version: 1,
      projects: [{ id: "a", path: "/tmp/foo" }],
      layout: defaultState().layout,
    };
    const io: StateIO = {
      read: async () => JSON.stringify(v1),
      write: async () => {},
    };
    const store = createStore(io);
    const result = await store.load();
    expect(result.migratedFrom).toBe(1);
    expect(result.state.workspaces).toHaveLength(1);
    expect(result.state.projects).toEqual([
      { id: "a", workspaceId: result.state.workspaces[0].id, path: "/tmp/foo" },
    ]);
  });

  it("load() renders { state, migratedFrom: null } on a v2 raw payload", async () => {
    const state = defaultState();
    state.workspaces.push({ id: "ws-1", name: "Défaut", rootPath: null });
    state.projects.push({ id: "a", workspaceId: "ws-1", path: "/tmp/foo" });
    const io: StateIO = {
      read: async () => serializePersistedState(state),
      write: async () => {},
    };
    const store = createStore(io);
    expect(await store.load()).toEqual({ state, migratedFrom: null });
  });

  it("load() calls onInvalid on a non-empty unreadable raw payload", async () => {
    let invalidRaw: string | null = null;
    const io: StateIO = {
      read: async () => "not json {{{",
      write: async () => {},
    };
    const store = createStore(io, (raw) => {
      invalidRaw = raw;
    });
    await store.load();
    expect(invalidRaw).toBe("not json {{{");
  });

  it("load() does not call onInvalid on an empty raw payload", async () => {
    let called = false;
    const io: StateIO = {
      read: async () => "",
      write: async () => {},
    };
    const store = createStore(io, () => {
      called = true;
    });
    await store.load();
    expect(called).toBe(false);
  });

  it("save() writes the serialized state via io.write()", async () => {
    let written: string | null = null;
    const io: StateIO = {
      read: async () => serializePersistedState(defaultState()),
      write: async (raw) => {
        written = raw;
      },
    };
    const store = createStore(io);
    const state = defaultState();
    state.workspaces.push({ id: "ws-1", name: "Défaut", rootPath: null });
    await store.save(state);
    expect(written).toBe(serializePersistedState(state));
  });
});
