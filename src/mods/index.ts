import { invoke } from "@tauri-apps/api/core";
import type { DenContext, DenModule } from "../core/registry";
import { setModBridge } from "../markdown/conversationView";
import {
  isModInvalidate,
  isModPanes,
  isModStatus,
  isModToast,
  isModTree,
  isModsUnavailable,
  type DenProtocolMessage,
  type ModTree,
} from "../types/protocol";
import type { ModRenderClient, RenderOptions, RenderTreeFn } from "./contracts";
import { createToastHost } from "./toast";
import { isRenderNode } from "./tree";

const RENDER_TIMEOUT_MS = 5000;
const NOT_HOOKED = { tree: null, hooked: false, rewritten: false } as const;

type RenderResult = Awaited<ReturnType<ModRenderClient["requestRender"]>>;

function send(tabId: string, message: object): Promise<unknown> {
  return invoke("sidecar_send", { tabId, message: JSON.stringify(message) });
}

// Un seul jeu de listeners window à la fois (ré-init, tests).
let listeners: AbortController | null = null;

export function createModsModule(deps: { renderTree: RenderTreeFn }): DenModule {
  return {
    name: "mods",
    init(ctx: DenContext) {
      listeners?.abort();
      listeners = new AbortController();
      const { signal } = listeners;
      const pending = new Map<string, (r: RenderResult) => void>();
      let nextId = 0;

      const client: ModRenderClient = {
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
      };

      function onTree(msg: ModTree): void {
        const settle = pending.get(msg.requestId);
        if (!settle) return;
        // Un arbre invalide ne doit jamais atteindre le rendu : on retombe sur le rendu Den.
        if (msg.hooked && !isRenderNode(msg.tree)) settle({ ...NOT_HOOKED });
        else settle({ tree: msg.tree, hooked: msg.hooked, rewritten: msg.rewritten });
      }

      // Fire-and-forget : le moteur invalide ensuite les instances touchées (mod_invalidate).
      const fire = (tabId: string, message: object): void => {
        void send(tabId, { requestId: `den-mod-${++nextId}`, ...message }).catch(() => {});
      };
      const options = (tabId: string): RenderOptions => ({
        onPress: (press, key, href) => fire(tabId, { type: "mod_press", ...press, key, href }),
        onInput: (press, kind, value, key) =>
          fire(tabId, { type: "mod_input", ...press, kind, value, key }),
        onSelect: (press, value, key) =>
          fire(tabId, { type: "mod_select", ...press, value, key }),
      });

      setModBridge({ client, renderTree: deps.renderTree, options });

      const toasts = createToastHost(document.body);

      const statusRoot = document.createElement("div");
      statusRoot.className = "den-mods-status";
      ctx.mounts.status.appendChild(statusRoot);
      const statusByTab = new Map<string, Map<string, string>>();
      const statusEls = new Map<string, HTMLElement>();
      let activeTab: string | null = null;

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
        activeTab = (event as CustomEvent<{ tabId: string | null }>).detail?.tabId ?? null;
        renderStatus();
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
        } else if (isModPanes(msg)) {
          window.dispatchEvent(new CustomEvent("den:mod-panes", { detail: { tabId, ...msg } }));
        } else if (isModInvalidate(msg)) {
          window.dispatchEvent(
            new CustomEvent("den:mod-invalidate", { detail: { tabId, ...msg } }),
          );
        }
      }, { signal });
    },
  };
}
