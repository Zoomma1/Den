/**
 * Debounce générique — utilisé pour ne pousser un `pty_resize` qu'une fois le
 * redimensionnement du conteneur (`ResizeObserver`) stabilisé, plutôt qu'à
 * chaque tick intermédiaire.
 */

/** Fonction debouncée, avec un `cancel()` pour annuler un appel en attente. */
export interface Debounced<Args extends unknown[]> {
  (...args: Args): void;
  cancel(): void;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = ((...args: Args) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  }) as Debounced<Args>;

  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return debounced;
}
