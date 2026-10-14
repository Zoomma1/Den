import { invoke } from "@tauri-apps/api/core";
import type { DenContext, DenModule } from "../core/registry";
import { setModBridge, type ModOrigin } from "../markdown/conversationView";
import {
  isModCopyRequest,
  isModInvalidate,
  isModPanes,
  isModClientModuleResult,
  isModClientPressResult,
  isModMessageResult,
  isModResult,
  isModStatus,
  isModToast,
  isModTree,
  isModsUnavailable,
  type DenProtocolMessage,
  type ModClientModuleResult,
  type ModClientPressResult,
  type ModMessageResult,
  type ModResult,
  type ModTree,
  type ModViewport,
} from "../types/protocol";
import {
  MOD_EVENTS,
  type CreateClientHost,
  type ModClient,
  type ModInvalidateEventDetail,
  type ModPaneClient,
  type ModPanesEventDetail,
  type ModViewportEventDetail,
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
const MESSAGE_TIMEOUT_MS = 120_000;
const VIEWPORT_DEBOUNCE_MS = 200;
const NOT_HOOKED = { tree: null, hooked: false, rewritten: false } as const;

type RenderResult = Awaited<ReturnType<ModPaneClient["requestRender"]>>;
type ActionResult = Awaited<ReturnType<ModPaneClient["paneAction"]>>;
type TabInfo = { cwd: string | null; owner: string | null };

let current: ModClient | null = null;
let currentOptions: ((tabId: string, origin?: ModOrigin) => RenderOptions) | null = null;

/** Client des mods une fois le module initialisé ; `null` avant. */
export function getModRenderClient(): ModClient | null {
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
let clientHost: ReturnType<CreateClientHost> | null = null;

export function createModsModule(deps: {
  renderTree: RenderTreeFn;
  openClaudeShell?: OpenClaudeShell;
  createClientHost?: CreateClientHost;
}): DenModule {
  return {
    name: "mods",
    init(ctx: DenContext) {
      listeners?.abort();
      listeners = new AbortController();
      clientHost?.dispose();
      clientHost = null;
      const { signal } = listeners;
      const pending = new Map<string, (r: RenderResult) => void>();
      const pendingResults = new Map<string, (r: DenProtocolMessage) => void>();
      const renderComponents = new Map<string, string>();
      let nextId = 0;

      const client: ModClient = {
        requestRender(tabId, req) {
          const requestId = `den-mod-${++nextId}`;
          return new Promise<RenderResult>((resolve) => {
            const settle = (r: RenderResult) => {
              clearTimeout(timer);
              pending.delete(requestId);
              renderComponents.delete(requestId);
              resolve(r);
            };
            const timer = setTimeout(() => settle({ ...NOT_HOOKED }), RENDER_TIMEOUT_MS);
            pending.set(requestId, settle);
            renderComponents.set(requestId, req.component);
            observeFlow(tabId);
            const viewport = measureViewport(tabId);
            if (!viewport) lastColumns.set(tabId, null);
            else if (!lastColumns.has(tabId)) lastColumns.set(tabId, viewport.columns);
            send(tabId, { type: "mod_render", requestId, ...req, ...(viewport && { viewport }) }).catch(() =>
              settle({ ...NOT_HOOKED }),
            );
          });
        },
        paneAction(tabId, req) {
          return request(tabId, { type: "mod_pane_action", ...req }, ACTION_TIMEOUT_MS);
        },
        async loadModule(tabId, plugin) {
          const r = await exchange<ModClientModuleResult>(
            tabId,
            { type: "mod_client_module", plugin },
            ACTION_TIMEOUT_MS,
          );
          if (!r.ok || !r.bundle) throw new Error(r.error ?? "bundle indisponible");
          return r.bundle;
        },
        async press(tabId, address, element, event) {
          const r = await exchange<ModClientPressResult>(
            tabId,
            { type: "mod_client_press", address, element, event },
            PRESS_TIMEOUT_MS,
          ).catch(failure);
          return {
            handled: r.handled,
            ...(r.reached !== undefined && { reached: r.reached }),
            ...(r.error !== undefined && { error: r.error }),
          };
        },
        async message(tabId, address, data) {
          const r = await exchange<ModMessageResult>(
            tabId,
            { type: "mod_message", address, data },
            MESSAGE_TIMEOUT_MS,
          ).catch(failure);
          return {
            handled: r.handled,
            ...(r.props !== undefined && { props: r.props }),
            ...(r.error !== undefined && { error: r.error }),
          };
        },
        async fault(tabId, address, phase, reason) {
          await request(tabId, { type: "mod_client_fault", address, phase, reason }, ACTION_TIMEOUT_MS);
        },
      };
      current = client;

      // Envoie et attend la réponse de même requestId ; rejette sur timeout ou échec d'envoi.
      function exchange<R extends DenProtocolMessage>(
        tabId: string,
        message: object,
        timeoutMs: number,
      ): Promise<R> {
        const requestId = `den-mod-${++nextId}`;
        return new Promise<R>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            pendingResults.delete(requestId);
          };
          const timer = setTimeout(() => {
            done();
            reject(new Error("délai dépassé"));
          }, timeoutMs);
          pendingResults.set(requestId, (r) => {
            done();
            resolve(r as R);
          });
          send(tabId, { requestId, ...message }).catch((e) => {
            done();
            reject(e instanceof Error ? e : new Error(String(e)));
          });
        });
      }

      const failure = (e: unknown): { handled: false; error: string; reached?: undefined; props?: undefined; value?: undefined } => ({
        handled: false,
        error: e instanceof Error ? e.message : String(e),
      });

      // Ne rejette jamais : handled:false + error.
      async function request(tabId: string, message: object, timeoutMs: number): Promise<ActionResult> {
        const r = await exchange<ModResult>(tabId, message, timeoutMs).catch(failure);
        return {
          handled: r.handled,
          ...(r.value !== undefined && { value: r.value }),
          ...(r.error !== undefined && { error: r.error }),
        };
      }

      const clientModulesByTab = new Map<string, Record<string, string>>();

      function onTree(tabId: string, msg: ModTree): void {
        // Fusion : un rendu qui ne cite que certains plugins ne doit pas effacer le hash des autres.
        if (msg.clientModules) clientModulesByTab.set(tabId, { ...clientModulesByTab.get(tabId), ...msg.clientModules });
        const component = renderComponents.get(msg.requestId);
        if (msg.error) reportEngineError(tabId, component, msg.error);
        const settle = pending.get(msg.requestId);
        if (!settle) return;
        // Un arbre invalide ne doit jamais atteindre le rendu : on retombe sur le rendu Den.
        if (msg.hooked && !isRenderNode(msg.tree)) settle({ ...NOT_HOOKED });
        else {
          settle({
            tree: msg.tree,
            hooked: msg.hooked,
            rewritten: msg.rewritten,
            ...(msg.props !== undefined && { props: msg.props }),
          });
        }
      }

      const toasts = createToastHost(document.body);

      // Le moteur re-rend souvent : un même échec ne doit produire qu'un toast par onglet.
      const errorsSeen = new Set<string>();
      function reportEngineError(tabId: string, component: string | undefined, error: string): void {
        const name = component ?? "composant inconnu";
        const k = `${tabId}\0${name}\0${error}`;
        if (errorsSeen.has(k)) return;
        errorsSeen.add(k);
        toasts.show(`Erreur du mod (${name}) : ${error}`, 6000);
      }

      const flowOf = (tabId: string): HTMLElement | null =>
        ctx.mounts.conversation.querySelector<HTMLElement>(
          `.den-conversation-tab[data-tab-id="${CSS.escape(tabId)}"] .den-conversation-flow`,
        );
      // Dernière largeur dont l'événement a été émis (null = rendu sans viewport) ; un rendu ne l'écrase pas.
      const lastColumns = new Map<string, number | null>();

      // Colonnes = largeur du fil / largeur d'un caractère mono ; null si non mesurable (jamais 0 colonne).
      // Cellule mono mesurée une fois par police : le témoin force un reflow, trop cher à chaque rendu.
      const cellCache = new Map<string, { charWidth: number; height: number }>();
      function monoCell(flow: HTMLElement): { charWidth: number; height: number } {
        const style = getComputedStyle(flow);
        const key = `${style.getPropertyValue("--den-font-mono")}|${style.fontSize}`;
        const hit = cellCache.get(key);
        if (hit) return hit;
        const probe = document.createElement("span");
        probe.textContent = "0".repeat(10);
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-family:var(--den-font-mono)";
        flow.appendChild(probe);
        const { width, height } = probe.getBoundingClientRect();
        probe.remove();
        const cell = { charWidth: width / 10, height };
        // Une mesure nulle (onglet masqué) ne se met pas en cache.
        if (cell.charWidth > 0 && cell.height > 0) cellCache.set(key, cell);
        return cell;
      }

      function measureViewport(tabId: string): ModViewport | null {
        const flow = flowOf(tabId);
        if (!flow) return null;
        const { charWidth, height } = monoCell(flow);
        const columns = Math.floor(flow.getBoundingClientRect().width / charWidth);
        const rows = Math.floor(window.innerHeight / height);
        if (!(charWidth > 0) || !(columns > 0) || !(rows > 0)) return null;
        return { columns, rows, isFullscreen: true };
      }

      const observers = new Map<string, { observer: ResizeObserver; timer?: ReturnType<typeof setTimeout> }>();
      function unobserve(tabId: string): void {
        const o = observers.get(tabId);
        if (!o) return;
        clearTimeout(o.timer);
        o.observer.disconnect();
        observers.delete(tabId);
      }
      function observeFlow(tabId: string): void {
        if (observers.has(tabId) || typeof ResizeObserver === "undefined") return;
        const flow = flowOf(tabId);
        if (!flow) return;
        const entry: { observer: ResizeObserver; timer?: ReturnType<typeof setTimeout> } = {
          observer: new ResizeObserver(() => {
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              const before = lastColumns.get(tabId);
              const viewport = measureViewport(tabId);
              if (!viewport || viewport.columns === before) return;
              lastColumns.set(tabId, viewport.columns);
              const detail: ModViewportEventDetail = { tabId, viewport };
              window.dispatchEvent(new CustomEvent(MOD_EVENTS.viewport, { detail }));
            }, VIEWPORT_DEBOUNCE_MS);
          }),
        };
        entry.observer.observe(flow);
        observers.set(tabId, entry);
      }
      signal.addEventListener("abort", () => [...observers.keys()].forEach(unobserve));

      // Sans attendre : l'UI reste libre, l'échec se signale par un toast.
      const interact = (tabId: string, message: object, timeoutMs: number): void => {
        void request(tabId, message, timeoutMs).then((r) => {
          // handled:false sans erreur = le mod ne s'y intéresse pas (ex. un `change` par frappe) : rien à signaler.
          if (!r.error) return;
          toasts.show(`Action du mod impossible : ${r.error}`, 6000);
        });
      };

      // Le getter du contrat n'a pas de tabId : on sert le record du tab actif.
      const getClientModules = () => (activeTab && clientModulesByTab.get(activeTab)) || {};
      clientHost = deps.createClientHost?.({ bridge: client, clientModules: getClientModules }) ?? null;

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
        ...(clientHost &&
          origin && { renderClient: (node) => clientHost!.renderClient(tabId, origin, node) }),
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
          observeFlow(activeTab);
        }
        renderStatus();
      }, { signal });

      window.addEventListener("den:session-closed", (event) => {
        const tabId = (event as CustomEvent<{ tabId: string }>).detail?.tabId;
        if (!tabId) return;
        statusByTab.delete(tabId);
        tabInfo.delete(tabId);
        clientModulesByTab.delete(tabId);
        unobserve(tabId);
        lastColumns.delete(tabId);
        for (const k of errorsSeen) if (k.startsWith(`${tabId}\0`)) errorsSeen.delete(k);
        for (const k of unsupportedSeen) if (k.startsWith(`${tabId}\0`)) unsupportedSeen.delete(k);
        if (tabId === activeTab) renderStatus();
      }, { signal });

      window.addEventListener("den:session-message", (event) => {
        const detail = (event as CustomEvent<{ tabId: string; message: DenProtocolMessage }>)
          .detail;
        if (!detail) return;
        const { tabId, message: msg } = detail;
        if (isModTree(msg)) {
          onTree(tabId, msg);
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
        } else if (
          isModResult(msg) ||
          isModClientModuleResult(msg) ||
          isModClientPressResult(msg) ||
          isModMessageResult(msg)
        ) {
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
