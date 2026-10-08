const MAX_VISIBLE = 4;
const DEFAULT_TIMEOUT_MS = 4000;
// setTimeout déclenche aussitôt au-delà de 2^31 ms : un toast ne doit de toute façon pas rester plus d'une minute.
const MAX_TIMEOUT_MS = 60_000;

export interface ToastHost {
  show(text: string, timeoutMs: number, plugin?: string): void;
}

export function createToastHost(parent: HTMLElement): ToastHost {
  const stack = document.createElement("div");
  stack.className = "den-toasts";
  stack.setAttribute("role", "status");
  stack.setAttribute("aria-live", "polite");
  parent.appendChild(stack);

  return {
    show(text, timeoutMs, plugin) {
      const toast = document.createElement("div");
      toast.className = "den-toast";
      if (plugin) toast.dataset.modPlugin = plugin;
      toast.textContent = text;
      stack.appendChild(toast);
      // Le plus ancien cède la place : la pile ne doit jamais couvrir la conversation.
      while (stack.children.length > MAX_VISIBLE) stack.firstElementChild?.remove();
      // Le message vient d'un mod via le sidecar : absent, NaN ou négatif retirerait le toast avant qu'on le voie.
      const delay =
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      setTimeout(() => toast.remove(), delay);
    },
  };
}
