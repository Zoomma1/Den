import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ne déclenche qu'un seul appel après une rafale", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    debounced();
    debounced();

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("relance le délai à chaque appel (pas de fuite de l'ancien timer)", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    vi.advanceTimersByTime(30);
    debounced(); // repousse l'échéance de 50ms de plus
    vi.advanceTimersByTime(30);

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("transmet les derniers arguments reçus", () => {
    const fn = vi.fn();
    const debounced = debounce((cols: number, rows: number) => fn(cols, rows), 50);

    debounced(80, 24);
    debounced(100, 40);

    vi.advanceTimersByTime(50);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(100, 40);
  });

  it("cancel() annule un appel en attente", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(100);

    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() sans appel en attente ne fait rien (pas d'exception)", () => {
    const debounced = debounce(vi.fn(), 50);
    expect(() => debounced.cancel()).not.toThrow();
  });
});
