import { describe, expect, it } from "vitest";
import {
  createStore,
  defaultWorkspace,
  displayName,
  parseWorkspace,
  serializeWorkspace,
  type Project,
  type Workspace,
  type WorkspaceIO,
} from "./store";

describe("parseWorkspace / serializeWorkspace", () => {
  it("roundtrips a valid workspace", () => {
    const ws: Workspace = {
      version: 1,
      projects: [
        { id: "a", path: "/Users/vico/Dev/Den" },
        { id: "b", path: "/Users/vico/Documents/Isep" },
      ],
      layout: {
        preset: "stacked",
        sizes: {
          "side-by-side": { sidebarPx: 260, conversationRatio: 0.5 },
          stacked: { sidebarPx: 240, conversationRatio: 0.7 },
        },
      },
    };
    expect(parseWorkspace(serializeWorkspace(ws))).toEqual(ws);
  });

  it("falls back to the default workspace on invalid JSON payload", () => {
    expect(parseWorkspace("not json {{{")).toEqual(defaultWorkspace());
  });

  it("falls back to the default workspace on unknown version", () => {
    const raw = JSON.stringify({ version: 2, projects: [], layout: defaultWorkspace().layout });
    expect(parseWorkspace(raw)).toEqual(defaultWorkspace());
  });

  it("falls back to the default workspace when projects is not an array", () => {
    const raw = JSON.stringify({ version: 1, projects: "nope", layout: defaultWorkspace().layout });
    expect(parseWorkspace(raw)).toEqual(defaultWorkspace());
  });

  it("falls back to the default workspace when a project entry is missing id/path", () => {
    const raw = JSON.stringify({
      version: 1,
      projects: [{ id: "a" }],
      layout: defaultWorkspace().layout,
    });
    expect(parseWorkspace(raw)).toEqual(defaultWorkspace());
  });

  it("falls back to the default workspace when layout is malformed", () => {
    const raw = JSON.stringify({
      version: 1,
      projects: [],
      layout: { preset: "stackd", sizes: {} },
    });
    expect(parseWorkspace(raw)).toEqual(defaultWorkspace());
  });

  it("treats an empty file as the default workspace", () => {
    expect(parseWorkspace("")).toEqual(defaultWorkspace());
  });

  it("falls back to the default workspace when a project id is not a string", () => {
    const raw = JSON.stringify({
      version: 1,
      projects: [{ id: 1, path: "/Users/vico/Dev/Den" }],
      layout: defaultWorkspace().layout,
    });
    expect(parseWorkspace(raw)).toEqual(defaultWorkspace());
  });
});

describe("displayName", () => {
  it("returns the basename when there is no collision", () => {
    const projects: Project[] = [{ id: "a", path: "/Users/vico/Dev/Den" }];
    expect(displayName(projects[0], projects)).toBe("Den");
  });

  it("returns parent/basename on a basename collision", () => {
    const projects: Project[] = [
      { id: "a", path: "/Users/vico/Dev/Den" },
      { id: "b", path: "/Users/vico/04 - Projects/Den" },
    ];
    expect(displayName(projects[0], projects)).toBe("Dev/Den");
    expect(displayName(projects[1], projects)).toBe("04 - Projects/Den");
  });
});

describe("createStore", () => {
  it("load() parses what io.read() returns", async () => {
    const ws = defaultWorkspace();
    ws.projects.push({ id: "a", path: "/tmp/foo" });
    const io: WorkspaceIO = {
      read: async () => serializeWorkspace(ws),
      write: async () => {},
    };
    const store = createStore(io);
    expect(await store.load()).toEqual(ws);
  });

  it("save() writes the serialized workspace via io.write()", async () => {
    let written: string | null = null;
    const io: WorkspaceIO = {
      read: async () => serializeWorkspace(defaultWorkspace()),
      write: async (raw) => {
        written = raw;
      },
    };
    const store = createStore(io);
    const ws = defaultWorkspace();
    ws.projects.push({ id: "x", path: "/tmp/bar" });
    await store.save(ws);
    expect(written).toBe(serializeWorkspace(ws));
  });
});
