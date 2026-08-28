import "./styles.css";
import { Registry, type DenContext } from "./core/registry";
import * as theme from "./theme";
import * as tabs from "./tabs";
import * as markdown from "./markdown";
import * as terminal from "./terminal";
import * as interactive from "./interactive";
import * as plugins from "./plugins";

function mount(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Den: point de montage #${id} introuvable dans index.html`);
  }
  return el;
}

const ctx: DenContext = {
  mounts: {
    tabs: mount("den-tabs"),
    conversation: mount("den-conversation"),
    terminal: mount("den-terminal"),
    status: mount("den-status"),
  },
};

const registry = new Registry();

// Ordre d'initialisation fixe — ne pas réordonner sans raison documentée :
// - theme en premier (pose les tokens CSS avant tout rendu) ;
// - markdown avant tabs : tabs émet `den:active-tab-changed` de façon
//   synchrone pour son premier tab dès son init — si markdown n'écoute pas
//   encore, la conversation du premier tab reste montée cachée (hidden).
registry.register({ name: "theme", init: theme.init });
registry.register({ name: "markdown", init: markdown.init });
registry.register({ name: "tabs", init: tabs.init });
registry.register({ name: "terminal", init: terminal.init });
registry.register({ name: "interactive", init: interactive.init });
registry.register({ name: "plugins", init: plugins.init });

// #den-status est partagé (les plugins y montent leurs items) : main.ts ne
// possède que ce span, jamais le textContent du mount entier.
const bootStatus = document.createElement("span");
bootStatus.className = "den-boot-status";
bootStatus.textContent = "Den — bootstrap en cours…";
ctx.mounts.status.prepend(bootStatus);

registry
  .initAll(ctx)
  .then(() => {
    bootStatus.textContent = "Den — prêt";
  })
  .catch((err: unknown) => {
    console.error("Den: échec d'initialisation des modules", err);
    bootStatus.textContent = "Den — erreur d'initialisation (voir console)";
  });
