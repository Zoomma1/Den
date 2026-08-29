/**
 * Module `theme` — charge le fichier de thème actif (cf. `.config` +
 * `themes/<nom>.css` à la racine du repo : un bloc `:root` de custom
 * properties `--den-*`) et réécrit ces variables sur `document.
 * documentElement`. N'a pas de mount point dédié : il agit sur le document
 * entier, avant tout autre module (cf. ordre dans main.ts).
 *
 * IPC : `theme_read` (lecture ponctuelle au démarrage) puis `theme_watch`
 * (souscription — un `Channel<string>` reçoit le CSS brut à chaque
 * changement détecté côté Rust, cf. `src-tauri/src/theme.rs`). Jamais de
 * crash : un CSS invalide ou un échec d'IPC conservent le thème courant.
 *
 * Contrat inter-lots : après chaque application réussie d'un thème, un
 * événement DOM `den:theme-changed` est dispatché sur `document`. Le module
 * terminal (lot ultérieur) s'y abonnera pour re-dériver son `ITheme` xterm
 * à partir des nouvelles variables `--den-*`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DenContext } from "../core/registry";
import { applyThemeVars, parseThemeCSS } from "./theme";

function applyRawTheme(raw: string): void {
  const vars = parseThemeCSS(raw);
  if (!vars) {
    console.warn("den: theme — CSS de thème invalide, thème courant conservé.");
    return;
  }
  applyThemeVars(document.documentElement.style, vars);
  document.dispatchEvent(new CustomEvent("den:theme-changed"));
}

export async function init(_ctx: DenContext): Promise<void> {
  try {
    const raw = await invoke<string>("theme_read");
    applyRawTheme(raw);
  } catch (err) {
    // theme_read indisponible (pas encore branché, erreur disque...) :
    // fallback silencieux sur les tokens par défaut de src/styles.css.
    console.warn("den: theme_read a échoué, thème par défaut conservé.", err);
  }

  try {
    const channel = new Channel<string>();
    channel.onmessage = applyRawTheme;
    await invoke("theme_watch", { onChange: channel });
  } catch (err) {
    console.warn("den: theme_watch a échoué, pas de hot-reload de thème.", err);
  }
}
