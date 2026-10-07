/**
 * Plugin d'exemple — démontre l'API minimale du plugin system (ADR-002).
 *
 * Ajoute un badge visible dans la barre de statut (`#den-status`) via
 * `PluginContext.statusBar`. Sert de référence pour qui écrit un nouveau
 * plugin sous `plugins/<nom>/index.ts` ; rangé dans `_examples/`, donc non
 * chargé par l'app (le glob ne descend pas d'un niveau de plus).
 */
import type { DenPlugin } from "../../../src/plugins/api";

const helloWorldPlugin: DenPlugin = {
  name: "hello-world",
  onMount(ctx): void {
    const badge = document.createElement("span");
    badge.className = "den-plugin-badge";
    badge.textContent = "hello from plugin";
    ctx.statusBar.addItem(badge);
  },
};

export default helloWorldPlugin;
