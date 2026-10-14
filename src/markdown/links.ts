import { invoke } from "@tauri-apps/api/core";
import { createToastHost, type ToastHost } from "../mods/toast";

const OPENABLE = new Set(["http:", "https:", "mailto:"]);

/** URL absolue http(s)/mailto normalisée, ou null si on ne doit pas l'ouvrir. */
export function openableUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return OPENABLE.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

let toasts: ToastHost | undefined;

export function openExternal(url: string): void {
  invoke("plugin:opener|open_url", { url }).catch((err: unknown) => {
    console.error("Den: échec de l'ouverture du lien", err);
    // La WebView n'expose pas la console à l'utilisateur : sans toast l'échec serait invisible.
    toasts ??= createToastHost(document.body);
    toasts.show(`Lien non ouvert : ${typeof err === "string" ? err : JSON.stringify(err)}`, 8000);
  });
}

/** Bloque toujours la navigation de la WebView ; n'ouvre que http(s)/mailto. */
export function handleLinkClick(event: MouseEvent, open: (url: string) => void = openExternal): void {
  // Un lien de mod gère déjà son clic (preventDefault) : le rouvrir ici ouvrirait deux onglets.
  if (event.defaultPrevented) return;
  // auxclick part aussi sur le clic droit : seul le bouton du milieu ouvre.
  if (event.type === "auxclick" && event.button !== 1) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a[href]");
  if (!anchor) return;
  event.preventDefault();
  const url = openableUrl(anchor.getAttribute("href") ?? "");
  if (url) open(url);
}
