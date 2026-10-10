import { MOD_EVENTS, type CreateAboveBand } from "./contracts";
import { isRenderNode } from "./tree";
import { replaceKeepingFocus } from "./render";

const DEBOUNCE_MS = 100;
const MAX_ROWS = 8;
const CHAR_WIDTH_PX = 8;
const DEFAULT_COLUMNS = 80;

export const createAboveBand: CreateAboveBand = ({
  client,
  renderTree,
  options,
}) => {
  const band = document.createElement("div");
  band.className = "den-mod-band";
  band.hidden = true;

  let tabId: string | null = null;
  let isWorking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function insert(): void {
    const form = document.querySelector<HTMLElement>(
      "#den-conversation > form.den-prompt-bar",
    );
    form?.before(band);
  }

  function hide(): void {
    band.hidden = true;
    band.replaceChildren();
  }

  async function render(): Promise<void> {
    const requested = tabId;
    if (requested === null) return hide();
    const bodyColumns = Math.max(
      20,
      Math.floor(
        (band.clientWidth || DEFAULT_COLUMNS * CHAR_WIDTH_PX) / CHAR_WIDTH_PX,
      ),
    );
    try {
      const res = await client.requestRender(requested, {
        component: "AbovePrompt",
        instanceId: "above-prompt",
        props: {
          hasSurvey: false,
          isWorking,
          maxRows: MAX_ROWS,
          bodyColumns,
          scroll: { offset: 0, bodyRows: MAX_ROWS },
          view: {},
        },
      });
      // Réponse périmée : l'onglet a changé pendant l'attente.
      if (disposed || tabId !== requested) return;
      const tree = res.tree;
      if (
        !res.hooked ||
        tree === null ||
        !isRenderNode(tree) ||
        (typeof tree === "object" && tree.type === "engine")
      ) {
        return hide();
      }
      replaceKeepingFocus(band, renderTree(tree, options?.(requested)));
      band.hidden = false;
    } catch {
      if (!disposed && tabId === requested) hide();
    }
  }

  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void render(), DEBOUNCE_MS);
  }

  const onTabChanged = (e: Event): void => {
    const detail = (e as CustomEvent<{ tabId: string | null }>).detail;
    tabId = detail?.tabId ?? null;
    isWorking = false;
    // La barre de prompt peut être créée après nous.
    if (!band.isConnected) insert();
    if (tabId === null) {
      clearTimeout(timer);
      return hide();
    }
    schedule();
  };

  const onStateChanged = (e: Event): void => {
    const detail = (e as CustomEvent<{ tabId: string; state: string }>).detail;
    if (detail?.tabId !== tabId) return;
    isWorking = detail.state === "running";
    schedule();
  };

  const onInvalidate = (e: Event): void => {
    const detail = (
      e as CustomEvent<{ tabId: string; instances: { component: string }[] }>
    ).detail;
    if (detail?.tabId !== tabId) return;
    if (detail.instances.some((i) => i.component === "AbovePrompt")) schedule();
  };

  insert();
  window.addEventListener("den:active-tab-changed", onTabChanged);
  window.addEventListener("den:tab-state-changed", onStateChanged);
  window.addEventListener(MOD_EVENTS.invalidate, onInvalidate);

  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("den:active-tab-changed", onTabChanged);
      window.removeEventListener("den:tab-state-changed", onStateChanged);
      window.removeEventListener(MOD_EVENTS.invalidate, onInvalidate);
      band.remove();
    },
  };
};
