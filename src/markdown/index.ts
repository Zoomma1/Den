/**
 * Module `markdown` — rendu du flux de conversation (assistant_delta,
 * tool_use/tool_result, custom blocks) dans #den-conversation.
 *
 * Contrat inter-lots (aucun fichier partagé, cf. CLAUDE.md du lot) :
 * - le lot `tabs` émet sur `window` un `CustomEvent<'den:session-message'>`
 *   (`detail: { tabId: string, message: SidecarToUIMessage }`) pour chaque
 *   message reçu d'un sidecar, et `CustomEvent<'den:active-tab-changed'>`
 *   (`detail: { tabId: string }`) à chaque changement de tab actif (émis
 *   aussi pour le tout premier tab).
 * - ce module maintient un container de conversation PAR tabId dans
 *   #den-conversation ; seul celui du tab actif est visible.
 *
 * Contrainte de résultat (CLAUDE.md racine) : replay d'un transcript réel à
 * vitesse réelle sans freeze perceptible — cf. `renderer.ts` pour la
 * stratégie de streaming incrémental.
 */
import type { DenContext } from "../core/registry";
import type { CustomBlock, SidecarToUIMessage } from "../types/protocol";
import { ConversationView } from "./conversationView";
import "./markdown.css";

interface SessionMessageDetail {
  tabId: string;
  message: SidecarToUIMessage;
}

interface ActiveTabChangedDetail {
  tabId: string;
}

const views = new Map<string, ConversationView>();
let viewsRoot: HTMLElement | null = null;

function getOrCreateView(tabId: string): ConversationView {
  let view = views.get(tabId);
  if (!view) {
    view = new ConversationView(tabId);
    views.set(tabId, view);
    viewsRoot?.appendChild(view.el);
  }
  return view;
}

function setActiveTab(tabId: string): void {
  const active = getOrCreateView(tabId);
  for (const view of views.values()) {
    view.el.hidden = view !== active;
  }
}

function onSessionMessage(event: Event): void {
  const detail = (event as CustomEvent<SessionMessageDetail>).detail;
  if (!detail) {
    return;
  }
  getOrCreateView(detail.tabId).handleMessage(detail.message);
}

function onActiveTabChanged(event: Event): void {
  const detail = (event as CustomEvent<ActiveTabChangedDetail>).detail;
  if (!detail) {
    return;
  }
  setActiveTab(detail.tabId);
}

export function init(ctx: DenContext): void {
  // #den-conversation est partagé avec la prompt bar du module tabs — ne
  // jamais vider le mount : ce module ne possède que son wrapper de views,
  // inséré en tête pour que la prompt bar (append par tabs) reste en bas.
  viewsRoot = document.createElement("div");
  viewsRoot.className = "den-views";
  ctx.mounts.conversation.prepend(viewsRoot);
  window.addEventListener("den:session-message", onSessionMessage);
  window.addEventListener("den:active-tab-changed", onActiveTabChanged);
}

/**
 * API custom block — pour le futur lot "surface interactive".
 *
 * Monte un placeholder de bloc custom dans le flux de conversation du tab
 * `tabId`, à la position courante du flux (après tout texte/tool déjà
 * rendu), et retourne l'élément DOM dans lequel l'appelant doit rendre sa
 * propre UI (widget de choix, formulaire, aperçu...).
 *
 * Contrat :
 * - Crée le container du tab s'il n'existe pas encore (ne nécessite pas
 *   qu'un `den:active-tab-changed` ait déjà été émis pour ce tabId).
 * - L'élément retourné (`.den-custom-block-content`) est un enfant vide,
 *   jamais réécrit par ce module — l'appelant en a l'entière propriété
 *   (contenu, listeners, cycle de vie) une fois monté.
 * - `block.id` / `block.kind` sont posés en attributs `data-*` sur le
 *   wrapper parent (`.den-custom-block`) pour faciliter le débogage/CSS,
 *   mais ne sont pas interprétés par ce module.
 * - Un seul appel par bloc : appeler à nouveau avec le même `block.id`
 *   monte un second placeholder (pas de déduplication côté markdown).
 */
export function mountCustomBlock(tabId: string, block: CustomBlock): HTMLElement {
  return getOrCreateView(tabId).mountCustomBlock(block);
}
