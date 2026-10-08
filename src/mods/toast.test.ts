// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToastHost } from "./toast";

describe("createToastHost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("monte une pile role=status aria-live=polite dans le parent", () => {
    const parent = document.createElement("div");
    createToastHost(parent);
    const stack = parent.querySelector(".den-toasts");
    expect(stack?.getAttribute("role")).toBe("status");
    expect(stack?.getAttribute("aria-live")).toBe("polite");
  });

  it("affiche un toast puis le retire après son délai", () => {
    const parent = document.createElement("div");
    const host = createToastHost(parent);
    host.show("hello", 1000, "p1");
    const toast = parent.querySelector<HTMLElement>(".den-toast");
    expect(toast?.textContent).toBe("hello");
    expect(toast?.dataset.modPlugin).toBe("p1");
    vi.advanceTimersByTime(999);
    expect(parent.querySelectorAll(".den-toast")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(parent.querySelectorAll(".den-toast")).toHaveLength(0);
  });

  it.each([undefined, Number.NaN, -5, 0] as unknown as number[])(
    "durée invalide (%s) : le toast reste affiché 4 s au lieu de disparaître aussitôt",
    (timeoutMs) => {
      const parent = document.createElement("div");
      createToastHost(parent).show("hello", timeoutMs);
      vi.advanceTimersByTime(3999);
      expect(parent.querySelectorAll(".den-toast")).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(parent.querySelectorAll(".den-toast")).toHaveLength(0);
    },
  );

  it("plafonne une durée démesurée à 60 s", () => {
    const parent = document.createElement("div");
    createToastHost(parent).show("hello", 3_000_000_000);
    vi.advanceTimersByTime(59_999);
    expect(parent.querySelectorAll(".den-toast")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(parent.querySelectorAll(".den-toast")).toHaveLength(0);
  });

  it("plafonne à 4 toasts visibles en retirant les plus anciens", () => {
    const parent = document.createElement("div");
    const host = createToastHost(parent);
    for (let i = 1; i <= 6; i++) host.show(`t${i}`, 10_000);
    const texts = [...parent.querySelectorAll(".den-toast")].map((t) => t.textContent);
    expect(texts).toEqual(["t3", "t4", "t5", "t6"]);
  });
});
