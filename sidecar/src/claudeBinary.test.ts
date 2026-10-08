import { describe, expect, it } from "vitest";
import { MIN_CLAUDE_VERSION, resolveClaudeBinary, type ResolveDeps } from "./claudeBinary";

function deps(files: string[], versionOut: string | Error): ResolveDeps {
  return {
    exists: async (p) => files.includes(p),
    exec: async () => {
      if (versionOut instanceof Error) throw versionOut;
      return versionOut;
    },
  };
}

describe("resolveClaudeBinary", () => {
  it("prend DEN_CLAUDE_PATH en priorité", async () => {
    const r = await resolveClaudeBinary(
      { DEN_CLAUDE_PATH: "/x/claude", PATH: "/bin" },
      deps(["/x/claude", "/bin/claude"], "2.1.291 (Claude Code)\n"),
    );
    expect(r).toEqual({ ok: true, path: "/x/claude", version: "2.1.291" });
  });

  it("n'utilise pas le PATH si DEN_CLAUDE_PATH est introuvable", async () => {
    const r = await resolveClaudeBinary(
      { DEN_CLAUDE_PATH: "/x/claude", PATH: "/bin" },
      deps(["/bin/claude"], "2.1.291 (Claude Code)"),
    );
    expect(r.ok).toBe(false);
  });

  it("cherche claude dans le PATH", async () => {
    const r = await resolveClaudeBinary(
      { PATH: "/a:/b" },
      deps(["/b/claude"], "2.2.0 (Claude Code)"),
    );
    expect(r).toEqual({ ok: true, path: "/b/claude", version: "2.2.0" });
  });

  it("refuse une version trop ancienne", async () => {
    const r = await resolveClaudeBinary({ PATH: "/a" }, deps(["/a/claude"], "2.1.258 (Claude Code)"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(MIN_CLAUDE_VERSION);
  });

  it("compare numériquement (2.1.1000 > 2.1.291)", async () => {
    const r = await resolveClaudeBinary({ PATH: "/a" }, deps(["/a/claude"], "2.1.1000 (Claude Code)"));
    expect(r.ok).toBe(true);
  });

  it("échoue sans claude dans le PATH", async () => {
    expect((await resolveClaudeBinary({ PATH: "/a" }, deps([], ""))).ok).toBe(false);
    expect((await resolveClaudeBinary({}, deps([], ""))).ok).toBe(false);
  });

  it("échoue si --version plante ou est illisible", async () => {
    expect((await resolveClaudeBinary({ PATH: "/a" }, deps(["/a/claude"], new Error("boom")))).ok).toBe(false);
    expect((await resolveClaudeBinary({ PATH: "/a" }, deps(["/a/claude"], "hello"))).ok).toBe(false);
  });
});
