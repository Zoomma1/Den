/**
 * Module `theme` — charge un fichier de thème (cf. den-theme.json à la
 * racine : clés de tokens -> valeurs CSS) et réécrit les custom properties
 * `--den-*` sur `:root`. N'a pas de mount point dédié : il agit sur le
 * document entier, avant tout autre module (cf. ordre dans main.ts).
 *
 * IPC : `theme_read` (lecture ponctuelle au démarrage) puis `theme_watch`
 * (souscription — un `Channel<string>` reçoit le contenu JSON brut à chaque
 * changement détecté côté Rust, cf. `src-tauri/src/theme.rs`). Jamais de
 * crash : un JSON invalide ou un échec d'IPC conservent le thème courant.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DenContext } from "../core/registry";
import { applyThemeVars, parseThemeJSON, tokensToCssVars } from "./theme";

function applyRawTheme(raw: string): void {
  const parsed = parseThemeJSON(raw);
  if (!parsed) {
    console.warn("den: theme — JSON de thème invalide, thème courant conservé.");
    return;
  }
  applyThemeVars(document.documentElement.style, tokensToCssVars(parsed.tokens));
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
