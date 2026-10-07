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

describe("parseThemeCSS — valeurs Glass", () => {
  it("parses linear-gradient and rgba values", () => {
    const raw = `:root {
      --den-accent-gradient: linear-gradient(135deg, #8b7cff, #35d0ff);
      --den-glass-1: rgba(255, 255, 255, 0.045);
    }`;
    expect(parseThemeCSS(raw)).toEqual({
      "--den-accent-gradient": "linear-gradient(135deg, #8b7cff, #35d0ff)",
      "--den-glass-1": "rgba(255, 255, 255, 0.045)",
    });
  });

  it("parses a multi-layer multi-line value with commas and parentheses", () => {
    const raw = `:root {
      --den-mesh: radial-gradient(600px 420px at 12% 8%, rgba(139, 124, 255, 0.45), transparent 70%),
        radial-gradient(700px 500px at 88% 20%, rgba(53, 208, 255, 0.28), transparent 70%),
        #0b0a14;
      --den-bg: #0b0a14;
    }`;
    const vars = parseThemeCSS(raw);
    expect(vars?.["--den-bg"]).toBe("#0b0a14");
    expect(vars?.["--den-mesh"]).toMatch(/^radial-gradient\(600px[\s\S]*,\s*#0b0a14$/);
    expect(vars?.["--den-mesh"].match(/radial-gradient/g)).toHaveLength(2);
  });

  it("keeps 0px and none values", () => {
    const raw = `:root { --den-blur: 0px; --den-scanlines: none; }`;
    expect(parseThemeCSS(raw)).toEqual({ "--den-blur": "0px", "--den-scanlines": "none" });
  });
});

describe("applyThemeVars", () => {
  it("removes tokens from the previous theme absent from the new one", () => {
    const style = new Map<string, string>();
    const target: CssPropertyTarget = {
      setProperty: (n, v) => void style.set(n, v),
      removeProperty: (n) => void style.delete(n),
    };

    applyThemeVars(target, { "--den-bg": "#000", "--den-glass-1": "rgba(0, 0, 0, 0.1)" });
    applyThemeVars(target, { "--den-bg": "#fff" });

    expect(Object.fromEntries(style)).toEqual({ "--den-bg": "#fff" });
  });

  it("calls setProperty once per CSS variable", () => {
    const setProperty = vi.fn();
    const target: CssPropertyTarget = { setProperty, removeProperty: vi.fn() };

    applyThemeVars(target, { "--den-bg": "#000", "--den-fg": "#fff" });

    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(setProperty).toHaveBeenCalledWith("--den-bg", "#000");
    expect(setProperty).toHaveBeenCalledWith("--den-fg", "#fff");
  });

  it("does nothing for an empty vars map", () => {
    const setProperty = vi.fn();
    applyThemeVars({ setProperty, removeProperty: vi.fn() }, {});
    expect(setProperty).not.toHaveBeenCalled();
  });
});
