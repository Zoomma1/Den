import "./styles.css";
import { Registry, type DenContext } from "./core/registry";
import * as theme from "./theme";
import * as workspace from "./workspace";
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
    sidebar: mount("den-sidebar"),
    conversation: mount("den-conversation"),
    terminal: mount("den-terminal"),
    status: mount("den-status"),
  },
};

const registry = new Registry();

// Ordre d'initialisation fixe — ne pas réordonner sans raison documentée :
// - theme en premier (pose les tokens CSS avant tout rendu) ;
// - workspace avant tabs : `workspace.init` charge state.json dans
//   l'objet module-level que `getProjects()` expose — tabs le lit dès son
//   premier rendu de la sidebar (`mounts.sidebar`, DEN-04 A2), avant même
//   qu'un tab existe ;
// - markdown avant tabs : invariant DOM, pas d'événement en jeu — les deux
//   font `prepend` dans #den-conversation, et tabs doit passer en dernier
//   pour que son header de session se retrouve au-dessus de `.den-views`.
registry.register({ name: "theme", init: theme.init });
registry.register({ name: "workspace", init: workspace.init });
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
