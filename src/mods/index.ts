import { invoke } from "@tauri-apps/api/core";
import type { DenContext, DenModule } from "../core/registry";
import { setModBridge, type ModOrigin } from "../markdown/conversationView";
import {
  isModCopyRequest,
  isModInvalidate,
  isModPanes,
  isModResult,
  isModStatus,
  isModToast,
  isModTree,
  isModsUnavailable,
  type DenProtocolMessage,
  type ModResult,
  type ModTree,
} from "../types/protocol";
import {
  MOD_EVENTS,
  type ModInvalidateEventDetail,
  type ModPaneClient,
  type ModPanesEventDetail,
  type OpenClaudeShell,
  type RenderOptions,
  type RenderTreeFn,
} from "./contracts";
import { createToastHost } from "./toast";
import { isRenderNode } from "./tree";

const RENDER_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 10_000;
// La réponse d'un press n'arrive qu'à la fin du handler du mod (ex. Copier = model.fork, plusieurs secondes).
const PRESS_TIMEOUT_MS = 120_000;
const NOT_HOOKED = { tree: null, hooked: false, rewritten: false } as const;

type RenderResult = Awaited<ReturnType<ModPaneClient["requestRender"]>>;
type ActionResult = Awaited<ReturnType<ModPaneClient["paneAction"]>>;
type TabInfo = { cwd: string | null; owner: string | null };

let current: ModPaneClient | null = null;
let currentOptions: ((tabId: string, origin?: ModOrigin) => RenderOptions) | null = null;

/** Client des mods une fois le module initialisé ; `null` avant. */
export function getModRenderClient(): ModPaneClient | null {
  return current;
}

/** Callbacks d'interaction (press/input/select, terminal) pour les hôtes Pane et bande ; `null` avant l'init. */
export function getModRenderOptions(): ((tabId: string, origin?: ModOrigin) => RenderOptions) | null {
  return currentOptions;
}

function send(tabId: string, message: object): Promise<unknown> {
  return invoke("sidecar_send", { tabId, message: JSON.stringify(message) });
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Un seul jeu de listeners window à la fois (ré-init, tests).
let listeners: AbortController | null = null;

export function createModsModule(deps: {
  renderTree: RenderTreeFn;
  openClaudeShell?: OpenClaudeShell;
}): DenModule {
  return {
    name: "mods",
    init(ctx: DenContext) {
      listeners?.abort();
      listeners = new AbortController();
      const { signal } = listeners;
      const pending = new Map<string, (r: RenderResult) => void>();
      const pendingResults = new Map<string, (r: ModResult) => void>();
      let nextId = 0;

      const client: ModPaneClient = {
        requestRender(tabId, req) {
          const requestId = `den-mod-${++nextId}`;
          return new Promise<RenderResult>((resolve) => {
            const settle = (r: RenderResult) => {
              clearTimeout(timer);
              pending.delete(requestId);
              resolve(r);
            };
            const timer = setTimeout(() => settle({ ...NOT_HOOKED }), RENDER_TIMEOUT_MS);
            pending.set(requestId, settle);
            send(tabId, { type: "mod_render", requestId, ...req }).catch(() =>
              settle({ ...NOT_HOOKED }),
            );
          });
        },
        paneAction(tabId, req) {
          return request(tabId, { type: "mod_pane_action", ...req }, ACTION_TIMEOUT_MS);
        },
      };
      current = client;

      // Envoie et attend le mod_result de même requestId ; ne rejette jamais.
      function request(tabId: string, message: object, timeoutMs: number): Promise<ActionResult> {
        const requestId = `den-mod-${++nextId}`;
        return new Promise<ActionResult>((resolve) => {
          const settle = (r: ActionResult) => {
            clearTimeout(timer);
            pendingResults.delete(requestId);
            resolve(r);
          };
          const timer = setTimeout(
            () => settle({ handled: false, error: "délai dépassé" }),
            timeoutMs,
          );
          pendingResults.set(requestId, (r) =>
            settle({
              handled: r.handled,
              ...(r.value !== undefined && { value: r.value }),
              ...(r.error !== undefined && { error: r.error }),
            }),
          );
          send(tabId, { requestId, ...message }).catch((e) =>
            settle({ handled: false, error: String(e) }),
          );
        });
      }

      function onTree(msg: ModTree): void {
        const settle = pending.get(msg.requestId);
        if (!settle) return;
        // Un arbre invalide ne doit jamais atteindre le rendu : on retombe sur le rendu Den.
        if (msg.hooked && !isRenderNode(msg.tree)) settle({ ...NOT_HOOKED });
        else settle({ tree: msg.tree, hooked: msg.hooked, rewritten: msg.rewritten });
      }

      const toasts = createToastHost(document.body);

      // Sans attendre : l'UI reste libre, l'échec se signale par un toast.
      const interact = (tabId: string, message: object, timeoutMs: number): void => {
        void request(tabId, message, timeoutMs).then((r) => {
          // handled:false sans erreur = le mod ne s'y intéresse pas (ex. un `change` par frappe) : rien à signaler.
          if (!r.error) return;
          toasts.show(`Action du mod impossible : ${r.error}`, 6000);
        });
      };

      const tabInfo = new Map<string, TabInfo>();
      const unsupportedSeen = new Set<string>();
      const options = (tabId: string, origin?: ModOrigin): RenderOptions => ({
        onPress: (press, key, href) =>
          interact(tabId, { type: "mod_press", ...press, key, href }, PRESS_TIMEOUT_MS),
        onInput: (press, kind, value, key) =>
          interact(
            tabId,
            { type: "mod_input", ...press, kind, value, key, ...origin },
            ACTION_TIMEOUT_MS,
          ),
        onSelect: (press, value, key) =>
          interact(
            tabId,
            { type: "mod_select", ...press, value, key, ...origin },
            ACTION_TIMEOUT_MS,
          ),
        openTerminal: () => {
          Promise.resolve(
            deps.openClaudeShell?.({
              owner: tabInfo.get(tabId)?.owner ?? null,
              cwd: tabInfo.get(tabId)?.cwd ?? null,
            }),
          ).catch((err: unknown) => {
            toasts.show(`Impossible d'ouvrir le terminal : ${err instanceof Error ? err.message : String(err)}`, 6000);
          });
        },
        // renderTree rappelle à chaque re-rendu : un seul signal par tab et par type.
        onUnsupported: (elementType) => {
          const k = `${tabId}\0${elementType}`;
          if (unsupportedSeen.has(k)) return;
          unsupportedSeen.add(k);
          console.warn(`[mods] élément non supporté ignoré : ${elementType}`);
        },
      });

      setModBridge({ client, renderTree: deps.renderTree, options });
      currentOptions = options;

      const statusRoot = document.createElement("div");
      statusRoot.className = "den-mods-status";
      ctx.mounts.status.appendChild(statusRoot);
      const statusByTab = new Map<string, Map<string, string>>();
      const statusEls = new Map<string, HTMLElement>();
      // Si den:active-tab-changed a précédé l'init, la vue visible porte l'onglet actif.
      let activeTab: string | null =
        ctx.mounts.conversation.querySelector<HTMLElement>(".den-conversation-tab:not([hidden])")
          ?.dataset.tabId ?? null;

      function renderStatus(): void {
        const texts = (activeTab && statusByTab.get(activeTab)) || new Map<string, string>();
        for (const [plugin, el] of statusEls) {
          if (!texts.has(plugin)) {
            el.remove();
            statusEls.delete(plugin);
          }
        }
        for (const [plugin, text] of texts) {
          let el = statusEls.get(plugin);
          if (!el) {
            el = document.createElement("span");
            el.dataset.modPlugin = plugin;
            statusEls.set(plugin, el);
            statusRoot.appendChild(el);
          }
          el.textContent = text;
        }
      }

      let bannerShown = false;
      function showBanner(reason: string): void {
        if (bannerShown) return;
        bannerShown = true;
        const banner = document.createElement("div");
        banner.className = "den-mods-banner";
        const text = document.createElement("span");
        text.className = "den-mods-banner__text";
        text.textContent = reason;
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "den-mods-banner__dismiss";
        dismiss.setAttribute("aria-label", "Dismiss");
        dismiss.textContent = "✕";
        dismiss.addEventListener("click", () => banner.remove());
        banner.append(text, dismiss);
        ctx.mounts.conversation.prepend(banner);
      }

      window.addEventListener("den:active-tab-changed", (event) => {
        const detail = (event as CustomEvent<{ tabId: string | null } & Partial<TabInfo>>).detail;
        activeTab = detail?.tabId ?? null;
        if (activeTab) {
          tabInfo.set(activeTab, { cwd: detail?.cwd ?? null, owner: detail?.owner ?? null });
        }
        renderStatus();
      }, { signal });

      window.addEventListener("den:session-closed", (event) => {
        const tabId = (event as CustomEvent<{ tabId: string }>).detail?.tabId;
        if (!tabId) return;
        statusByTab.delete(tabId);
        tabInfo.delete(tabId);
        for (const k of unsupportedSeen) if (k.startsWith(`${tabId}\0`)) unsupportedSeen.delete(k);
        if (tabId === activeTab) renderStatus();
      }, { signal });

      window.addEventListener("den:session-message", (event) => {
        const detail = (event as CustomEvent<{ tabId: string; message: DenProtocolMessage }>)
          .detail;
        if (!detail) return;
        const { tabId, message: msg } = detail;
        if (isModTree(msg)) {
          onTree(msg);
        } else if (isModStatus(msg)) {
          const texts = statusByTab.get(tabId) ?? new Map<string, string>();
          if (msg.text === "") texts.delete(msg.plugin);
          else texts.set(msg.plugin, msg.text);
          statusByTab.set(tabId, texts);
          if (tabId === activeTab) renderStatus();
        } else if (isModToast(msg)) {
          toasts.show(msg.text, msg.timeoutMs, msg.plugin);
        } else if (isModsUnavailable(msg)) {
          // Sans moteur de mods, chaque rendu demandé ne ferait qu'un aller-retour IPC et un timer de 5 s pour rien.
          setModBridge(null);
          showBanner(msg.reason);
        } else if (isModResult(msg)) {
          pendingResults.get(msg.requestId)?.(msg);
        } else if (isModCopyRequest(msg)) {
          void copyToClipboard(msg.text).then((copied) =>
            send(tabId, { type: "mod_copy_result", requestId: msg.requestId, copied }).catch(
              () => {},
            ),
          );
        } else if (isModPanes(msg)) {
          const { type: _type, ...roster } = msg;
          const detail: ModPanesEventDetail = { tabId, ...roster };
          window.dispatchEvent(new CustomEvent(MOD_EVENTS.panes, { detail }));
        } else if (isModInvalidate(msg)) {
          const detail: ModInvalidateEventDetail = { tabId, instances: msg.instances };
          window.dispatchEvent(new CustomEvent(MOD_EVENTS.invalidate, { detail }));
        }
      }, { signal });
    },
  };
}
