import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInitialMode } from "./initialMode";

const env = { DEN_CONFIG_DIR: "/cfg" };
const withFile = (content: string) => () => content;
const enoent = () => {
  throw Object.assign(new Error("nope"), { code: "ENOENT" });
};

afterEach(() => vi.restoreAllMocks());

describe("resolveInitialMode", () => {
  it("retombe sur default sans DEN_CONFIG_DIR", () => {
    expect(resolveInitialMode({}, withFile('{"defaultPermissionMode":"plan"}'))).toBe("default");
  });

  it("lit settings.json dans DEN_CONFIG_DIR", () => {
    const read = vi.fn(withFile('{"defaultPermissionMode":"plan"}'));
    resolveInitialMode(env, read);
    expect(read).toHaveBeenCalledWith("/cfg/settings.json");
  });

  it("fichier absent => default, sans log", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveInitialMode(env, enoent)).toBe("default");
    expect(err).not.toHaveBeenCalled();
  });

  it("fichier illisible => default avec log", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(resolveInitialMode(env, read)).toBe("default");
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("JSON invalide => default avec log", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveInitialMode(env, withFile("{nope"))).toBe("default");
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("clé absente => default, sans log", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveInitialMode(env, withFile("{}"))).toBe("default");
    expect(err).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", '"plan"', "42"])("racine non-objet %s => default avec log", (raw) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveInitialMode(env, withFile(raw))).toBe("default");
    expect(err).toHaveBeenCalledTimes(1);
  });

  it.each(["default", "acceptEdits", "plan", "auto"])("accepte %s", (mode) => {
    expect(resolveInitialMode(env, withFile(JSON.stringify({ defaultPermissionMode: mode })))).toBe(
      mode,
    );
  });

  it.each(["bypassPermissions", "dontAsk", "inconnu"])("refuse %s => default avec log", (mode) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveInitialMode(env, withFile(JSON.stringify({ defaultPermissionMode: mode })))).toBe(
      "default",
    );
    expect(err).toHaveBeenCalledTimes(1);
  });

  it.each([42, null, true, ["plan"]])("valeur non-string %j => default avec log", (value) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveInitialMode(env, withFile(JSON.stringify({ defaultPermissionMode: value })))).toBe(
      "default",
    );
    expect(err).toHaveBeenCalledTimes(1);
  });
});
