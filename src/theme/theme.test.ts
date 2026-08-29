import { describe, expect, it, vi } from "vitest";
import {
  applyThemeVars,
  parseThemeCSS,
  type CssPropertyTarget,
} from "./theme";

describe("parseThemeCSS", () => {
  it("parses a valid :root block with several tokens", () => {
    const raw = `:root {
      --den-bg: #1e1e1e;
      --den-accent: #4fa3ff;
    }`;
    expect(parseThemeCSS(raw)).toEqual({
      "--den-bg": "#1e1e1e",
      "--den-accent": "#4fa3ff",
    });
  });

  it("parses values containing spaces (font stacks)", () => {
    const raw = `:root {
      --den-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --den-font-mono: 'SF Mono', Menlo, Consolas, monospace;
    }`;
    expect(parseThemeCSS(raw)).toEqual({
      "--den-font-sans": '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      "--den-font-mono": "'SF Mono', Menlo, Consolas, monospace",
    });
  });

  it("tolerates comments before, after and inside the block", () => {
    const raw = `/* header comment */
    :root {
      /* inline comment */
      --den-bg: #1e1e1e; /* trailing comment */
    }
    /* footer comment */`;
    expect(parseThemeCSS(raw)).toEqual({ "--den-bg": "#1e1e1e" });
  });

  it("returns null for a non-:root selector", () => {
    const raw = `.foo { --den-bg: #1e1e1e; }`;
    expect(parseThemeCSS(raw)).toBeNull();
  });

  it("returns null when the block contains a non --den-* property", () => {
    const raw = `:root { --den-bg: #1e1e1e; color: red; }`;
    expect(parseThemeCSS(raw)).toBeNull();
  });

  it("returns null when there are two blocks", () => {
    const raw = `:root { --den-bg: #1e1e1e; } :root { --den-fg: #fff; }`;
    expect(parseThemeCSS(raw)).toBeNull();
  });

  it("returns null on malformed CSS (missing closing brace)", () => {
    const raw = `:root { --den-bg: #1e1e1e;`;
    expect(parseThemeCSS(raw)).toBeNull();
  });

  it("returns null for an empty file", () => {
    expect(parseThemeCSS("")).toBeNull();
  });

  it("returns null for a file containing only whitespace", () => {
    expect(parseThemeCSS("   \n\t  ")).toBeNull();
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
