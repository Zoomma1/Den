import { describe, expect, it, vi } from "vitest";
import {
  applyThemeVars,
  parseThemeJSON,
  tokensToCssVars,
  type CssPropertyTarget,
} from "./theme";

describe("parseThemeJSON", () => {
  it("parses a valid theme file", () => {
    const raw = JSON.stringify({
      name: "Den Dark",
      tokens: { bg: "#1e1e1e", accent: "#4fa3ff" },
    });
    expect(parseThemeJSON(raw)).toEqual({
      name: "Den Dark",
      tokens: { bg: "#1e1e1e", accent: "#4fa3ff" },
    });
  });

  it("accepts a theme file without a name", () => {
    const raw = JSON.stringify({ tokens: { bg: "#000" } });
    expect(parseThemeJSON(raw)).toEqual({ tokens: { bg: "#000" } });
  });

  it("returns null on malformed JSON", () => {
    expect(parseThemeJSON("{not json")).toBeNull();
  });

  it("returns null when tokens is missing", () => {
    expect(parseThemeJSON(JSON.stringify({ name: "x" }))).toBeNull();
  });

  it("returns null when tokens is not an object", () => {
    expect(parseThemeJSON(JSON.stringify({ tokens: "nope" }))).toBeNull();
  });

  it("returns null when tokens is an array", () => {
    expect(parseThemeJSON(JSON.stringify({ tokens: ["a", "b"] }))).toBeNull();
  });

  it("returns null when a token value is not a string", () => {
    const raw = JSON.stringify({ tokens: { bg: "#000", radius: 6 } });
    expect(parseThemeJSON(raw)).toBeNull();
  });

  it("returns null for a bare JSON value (e.g. a number)", () => {
    expect(parseThemeJSON("42")).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseThemeJSON("null")).toBeNull();
  });
});

describe("tokensToCssVars", () => {
  it("prefixes each token key with --den-", () => {
    expect(
      tokensToCssVars({ bg: "#1e1e1e", "fg-muted": "#8a8a8a" }),
    ).toEqual({
      "--den-bg": "#1e1e1e",
      "--den-fg-muted": "#8a8a8a",
    });
  });

  it("returns an empty object for empty tokens", () => {
    expect(tokensToCssVars({})).toEqual({});
  });
});

describe("applyThemeVars", () => {
  it("calls setProperty once per CSS variable", () => {
    const setProperty = vi.fn();
    const target: CssPropertyTarget = { setProperty };

    applyThemeVars(target, { "--den-bg": "#000", "--den-fg": "#fff" });

    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(setProperty).toHaveBeenCalledWith("--den-bg", "#000");
    expect(setProperty).toHaveBeenCalledWith("--den-fg", "#fff");
  });

  it("does nothing for an empty vars map", () => {
    const setProperty = vi.fn();
    applyThemeVars({ setProperty }, {});
    expect(setProperty).not.toHaveBeenCalled();
  });
});
