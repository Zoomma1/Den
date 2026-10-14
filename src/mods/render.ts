import { createMarkdownEngine } from "../markdown/renderer";
import { openableUrl, openExternal } from "../markdown/links";
import type { RenderOptions, RenderTreeFn } from "./contracts";
import { isSupportedElement, type ElementNode, type RenderNode } from "./tree";

/** Lien de mod sans action `press` : on l'ouvre dans le navigateur (jamais dans la WebView). */
function openLink(href: string | undefined): void {
  const url = href ? openableUrl(href) : null;
  if (url) openExternal(url);
}

// Le moteur Marked échappe déjà le HTML brut (cf. createMarkdownEngine).
const md = createMarkdownEngine(false);

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Palette xterm 256 : 0-15 = tokens du thème, 16-231 = cube 6x6x6, 232-255 = niveaux de gris. */
function ansi256(n: number): string | undefined {
  if (n > 255) return undefined;
  if (n < 8) return `var(--den-ansi-${ANSI_NAMES[n]})`;
  if (n === 8) return "var(--den-ansi-gray)"; // pas de token bright-black dans les thèmes
  if (n < 16) return `var(--den-ansi-bright-${ANSI_NAMES[n - 8]})`;
  if (n >= 232) {
    const g = 8 + (n - 232) * 10;
    return `rgb(${g}, ${g}, ${g})`;
  }
  const c = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(c / 36))}, ${level(Math.floor(c / 6) % 6)}, ${level(c % 6)})`;
}

/** Nom ANSI du moteur (red, redBright, gray, ansi:red) -> token --den-ansi-*, sinon #hex/rgb() tel quel. */
function resolveColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().replace(/^ansi:/, "");
  const idx = /^ansi256\((\d{1,3})\)$/.exec(v);
  if (idx) return ansi256(Number(idx[1]));
  if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\([\d\s.,%/]+\)$/.test(v)) return v;
  if (v === "gray" || v === "grey" || v === "blackBright") return "var(--den-ansi-gray)";
  const bright = /^(\w+)Bright$/.exec(v);
  if (bright && ANSI_NAMES.includes(bright[1])) return `var(--den-ansi-bright-${bright[1]})`;
  return ANSI_NAMES.includes(v) ? `var(--den-ansi-${v})` : undefined;
}

// Les props de mise en page sont en cellules de terminal : ch en largeur, em en hauteur.
function cells(value: unknown, unit: "ch" | "em"): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${value}${unit}` : undefined;
}

function setStyle(el: HTMLElement, prop: string, value: string | undefined): void {
  if (value !== undefined) el.style.setProperty(prop, value);
}

const BORDER_STYLES: Record<string, { style: string; width: string; radius?: string }> = {
  single: { style: "solid", width: "1px" },
  round: { style: "solid", width: "1px", radius: "var(--den-radius)" },
  bold: { style: "solid", width: "2px" },
  double: { style: "double", width: "3px" },
};

function applyBorder(el: HTMLElement, p: Record<string, unknown>): void {
  const b = typeof p.borderStyle === "string" ? BORDER_STYLES[p.borderStyle] : undefined;
  if (!b) return;
  el.style.borderStyle = b.style;
  el.style.borderWidth = b.width;
  el.style.borderColor = resolveColor(p.borderColor) ?? "var(--den-border)";
  setStyle(el, "border-radius", b.radius);
}

// Plafond comme pixels() pour Svg : un width démesuré ne doit pas casser la mise en page.
function boundedWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(400, Math.max(1, value)) : undefined;
}

function applyBoxStyle(el: HTMLElement, p: Record<string, unknown>): void {
  const dir = typeof p.flexDirection === "string" ? p.flexDirection : "row";
  el.style.flexDirection = dir;
  setStyle(el, "gap", cells(p.gap, dir.startsWith("column") ? "em" : "ch"));
  setStyle(el, "row-gap", cells(p.rowGap, "em"));
  setStyle(el, "column-gap", cells(p.columnGap, "ch"));
  setStyle(el, "width", p.width === "100%" ? "100%" : cells(boundedWidth(p.width), "ch"));
  if (typeof p.alignSelf === "string") el.style.alignSelf = p.alignSelf;
  applyBorder(el, p);
  for (const kind of ["padding", "margin"] as const) {
    setStyle(el, `${kind}-left`, cells(p[`${kind}Left`] ?? p[`${kind}X`] ?? p[kind], "ch"));
    setStyle(el, `${kind}-right`, cells(p[`${kind}Right`] ?? p[`${kind}X`] ?? p[kind], "ch"));
    setStyle(el, `${kind}-top`, cells(p[`${kind}Top`] ?? p[`${kind}Y`] ?? p[kind], "em"));
    setStyle(el, `${kind}-bottom`, cells(p[`${kind}Bottom`] ?? p[`${kind}Y`] ?? p[kind], "em"));
  }
  if (typeof p.flexGrow === "number") el.style.flexGrow = String(p.flexGrow);
  if (typeof p.flexShrink === "number") el.style.flexShrink = String(p.flexShrink);
  if (typeof p.flexWrap === "string") el.style.flexWrap = p.flexWrap;
  if (typeof p.alignItems === "string") el.style.alignItems = p.alignItems;
  if (typeof p.justifyContent === "string") el.style.justifyContent = p.justifyContent;
  setStyle(el, "background-color", resolveColor(p.backgroundColor));
}

function applyTextStyle(el: HTMLElement, p: Record<string, unknown>): void {
  let fg = resolveColor(p.color);
  let bg = resolveColor(p.backgroundColor);
  if (p.inverse === true) {
    [fg, bg] = [bg ?? "var(--den-bg)", fg ?? "var(--den-fg)"];
  }
  setStyle(el, "color", fg);
  setStyle(el, "background-color", bg);
  if (p.bold === true) el.style.fontWeight = "700";
  if (p.italic === true) el.style.fontStyle = "italic";
  const deco = [p.underline === true && "underline", p.strikethrough === true && "line-through"].filter(Boolean);
  if (deco.length) el.style.textDecoration = deco.join(" ");
  if (p.dimColor === true) el.style.opacity = "0.6";
  if (p.wrap === "truncate-end") {
    el.style.whiteSpace = "nowrap";
    el.style.overflow = "hidden";
    el.style.textOverflow = "ellipsis";
    el.style.display = "inline-block";
    el.style.maxWidth = "100%";
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function textOf(children: RenderNode[] | undefined): string {
  return (children ?? [])
    .map((c) =>
      typeof c === "string" || typeof c === "number"
        ? String(c)
        : c.type === "engine"
          ? ""
          : textOf((c as ElementNode).children),
    )
    .join("");
}

function labelSpan(label: unknown): HTMLElement | null {
  if (label === undefined) return null;
  const span = document.createElement("span");
  span.className = "den-mod-field-label";
  span.textContent = str(label);
  return span;
}

function unsupported(type: string, opts: RenderOptions): HTMLElement {
  opts.onUnsupported?.(type);
  const box = document.createElement("div");
  box.className = "den-mod-unsupported";
  const msg = document.createElement("span");
  msg.textContent = `Ce mod utilise un element que Den ne sait pas afficher : ${type}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "den-mod-btn";
  btn.textContent = "Ouvrir dans le terminal";
  btn.addEventListener("click", () => opts.openTerminal?.());
  box.append(msg, btn);
  return box;
}

const SVG_MAX_CHARS = 131072;

function svgError(alt: unknown): HTMLElement {
  const box = document.createElement("div");
  box.className = "den-mod-svg-error";
  box.textContent = typeof alt === "string" && alt ? `Dessin indisponible : ${alt}` : "Dessin indisponible";
  return box;
}

// Bornes 1..4000 px : un mod ne dimensionne pas le panneau à sa guise.
function pixels(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${Math.min(4000, Math.max(1, Math.round(value)))}px`;
}

function svgElement(p: Record<string, unknown>): HTMLElement {
  const { source, alt } = p;
  if (typeof source !== "string" || typeof alt !== "string" || source.length > SVG_MAX_CHARS) {
    return svgError(alt);
  }
  const width = pixels(p.width);
  const height = pixels(p.height);
  // Jamais d'insertion du markup dans le DOM : <img> data: n'exécute aucun script, l'iframe sandbox="" non plus.
  if (p.isInteractive === true) {
    const frame = document.createElement("iframe");
    frame.className = "den-mod-svg";
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = alt;
    frame.srcdoc = source;
    setStyle(frame, "width", width);
    frame.style.height = height ?? "160px";
    return frame;
  }
  const img = document.createElement("img");
  img.className = "den-mod-svg";
  img.alt = alt;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  setStyle(img, "width", width);
  setStyle(img, "height", height);
  return img;
}

function build(node: RenderNode, opts: RenderOptions): Node {
  if (typeof node === "string" || typeof node === "number") {
    return document.createTextNode(String(node));
  }
  if (node.type === "engine") {
    const ref = (node as { ref: number }).ref;
    return opts.renderEngineDefault?.(ref) ?? document.createDocumentFragment();
  }
  const el = node as ElementNode;
  if (el.type === "Client" && opts.renderClient) {
    try {
      return opts.renderClient(el);
    } catch {
      const box = document.createElement("div");
      box.className = "den-mod-unsupported";
      box.textContent = "Ce module client n'a pas pu s'afficher.";
      return box;
    }
  }
  if (!isSupportedElement(el.type)) return unsupported(el.type, opts);
  const p = el.props ?? {};
  const key = typeof p.key === "string" ? p.key : undefined;
  const appendChildren = (parent: Node) => {
    for (const c of el.children ?? []) parent.appendChild(build(c, opts));
  };

  switch (el.type) {
    case "Box": {
      const box = document.createElement("div");
      box.className = "den-mod-box";
      applyBoxStyle(box, p);
      appendChildren(box);
      return box;
    }
    case "Text": {
      const span = document.createElement("span");
      span.className = "den-mod-text";
      applyTextStyle(span, p);
      appendChildren(span);
      return span;
    }
    case "Markdown": {
      const div = document.createElement("div");
      div.className = "den-mod-markdown";
      if (p.dimColor === true) div.style.opacity = "0.6";
      div.innerHTML = md.parse(str(p.text)) as string;
      // Un lien markdown ne doit jamais faire naviguer la webview.
      div.addEventListener("click", (e) => {
        const a = (e.target as Element).closest?.("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") ?? undefined;
        if (el.press) opts.onPress?.(el.press, key, href);
        else openLink(href);
      });
      return div;
    }
    case "Link": {
      const a = document.createElement("a");
      a.className = "den-mod-link";
      const href = str(p.href);
      a.textContent = str(p.label) || textOf(el.children) || href;
      if (p.dimColor === true) a.style.opacity = "0.6";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (el.press) opts.onPress?.(el.press, key, href);
        else openLink(href);
      });
      return a;
    }
    case "Svg":
      return svgElement(p);
    case "Code": {
      const pre = document.createElement("pre");
      pre.className = "den-mod-code";
      const code = document.createElement("code");
      const text = str(p.source) || str(p.text) || textOf(el.children);
      if (p.format === "diff") appendDiffLines(code, text);
      else code.textContent = text;
      pre.appendChild(code);
      return pre;
    }
    case "Button": {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "den-mod-btn";
      if (typeof p.variant === "string") btn.dataset.variant = p.variant;
      if (typeof p.role === "string") btn.dataset.role = p.role;
      btn.textContent = str(p.label) || textOf(el.children);
      if (p.dimColor === true) btn.style.opacity = "0.6";
      if (typeof p.hotkey === "string" && p.hotkey) btn.dataset.hotkey = p.hotkey.toLowerCase();
      if (p.autoFocus === true) btn.dataset.autofocus = "";
      btn.addEventListener("click", () => {
        if (el.press) opts.onPress?.(el.press, key);
      });
      return btn;
    }
    case "Input": {
      const wrap = document.createElement("label");
      wrap.className = "den-mod-field";
      const lab = labelSpan(p.label);
      if (lab) wrap.appendChild(lab);
      const input = document.createElement("input");
      input.type = "text";
      if (key !== undefined) input.dataset.modKey = key;
      input.value = str(p.value);
      input.placeholder = str(p.placeholder);
      const submit = () => {
        if (el.press) opts.onInput?.(el.press, "submit", input.value, key);
      };
      input.addEventListener("input", () => {
        if (el.press) opts.onInput?.(el.press, "change", input.value, key);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      wrap.appendChild(input);
      if (typeof p.submitLabel === "string") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "den-mod-btn";
        btn.textContent = p.submitLabel;
        btn.addEventListener("click", submit);
        wrap.appendChild(btn);
      }
      return wrap;
    }
    case "Select": {
      const wrap = document.createElement("label");
      wrap.className = "den-mod-field";
      const lab = labelSpan(p.label);
      if (lab) wrap.appendChild(lab);
      const select = document.createElement("select");
      if (key !== undefined) select.dataset.modKey = key;
      for (const o of Array.isArray(p.options) ? p.options : []) {
        const rec = (typeof o === "object" && o !== null ? o : { value: o }) as Record<string, unknown>;
        const opt = document.createElement("option");
        opt.value = String(rec.value ?? "");
        opt.textContent = String(rec.label ?? rec.value ?? "");
        select.appendChild(opt);
      }
      if (typeof p.value === "string") select.value = p.value;
      select.addEventListener("change", () => {
        if (el.press) opts.onSelect?.(el.press, select.value, key);
      });
      wrap.appendChild(select);
      return wrap;
    }
  }
}

export const renderTree: RenderTreeFn = (node, opts = {}) => {
  const root = document.createElement("div");
  root.className = "den-mod-tree";
  root.appendChild(build(node, opts));
  return root;
};

function appendDiffLines(code: HTMLElement, text: string): void {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const span = document.createElement("span");
    if (line.startsWith("@@")) span.className = "den-mod-code__hunk";
    else if (line.startsWith("+") && !line.startsWith("+++")) span.className = "den-mod-code__add";
    else if (line.startsWith("-") && !line.startsWith("---")) span.className = "den-mod-code__del";
    // Le \n reste dans le texte pour que la copie garde les sauts de ligne.
    span.textContent = i < lines.length - 1 ? `${line}\n` : line;
    code.appendChild(span);
  });
}

/** Presse le bouton [data-hotkey] correspondant a la touche, hors champ de saisie et sans modificateur. */
export function pressHotkey(container: HTMLElement, e: KeyboardEvent): boolean {
  // Une touche maintenue ne doit pas re-cliquer un bouton (ex. « Autoriser »).
  if (e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return false;
  const t = e.target;
  if (
    t instanceof HTMLElement &&
    (t.closest("input, textarea, select") || t.isContentEditable || t.getAttribute("contenteditable") === "true")
  ) {
    return false;
  }
  const btn = container.querySelector<HTMLButtonElement>(`button[data-hotkey="${CSS.escape(e.key.toLowerCase())}"]`);
  if (!btn || btn.disabled) return false;
  e.preventDefault();
  btn.click();
  return true;
}

/** Remplace le contenu d'un conteneur en gardant le focus, le caret et la saisie en cours d'un champ de mod : sans ça, chaque invalidation (une par frappe) recrée l'<input> et fait perdre le focus. autoFocus donne le focus au bouton [data-autofocus] si rien du conteneur n'a le focus. */
export function replaceKeepingFocus(container: HTMLElement, next: Node, autoFocus = false): void {
  const active = document.activeElement;
  const field =
    active instanceof HTMLInputElement || active instanceof HTMLSelectElement
      ? active
      : null;
  const key = field && container.contains(field) ? field.dataset.modKey : undefined;
  const saved =
    key !== undefined && field instanceof HTMLInputElement
      ? { value: field.value, start: field.selectionStart, end: field.selectionEnd }
      : null;

  // Évalué avant le remplacement (l'ancien actif en sort) ; le conteneur lui-même (tabIndex) ne compte pas.
  const innerFocused = active instanceof HTMLElement && active !== container && container.contains(active);
  const hadAutofocus = innerFocused && (active as HTMLElement).hasAttribute("data-autofocus");

  container.replaceChildren(next);
  if (key === undefined) {
    if ((autoFocus && !innerFocused) || hadAutofocus) {
      container.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    }
    return;
  }

  const fresh = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-mod-key="${CSS.escape(key)}"]`,
  );
  if (!fresh) return;
  fresh.focus({ preventScroll: true });
  // La saisie locale fait foi tant que l'utilisateur tape : le moteur rattrape à l'invalidation suivante.
  if (saved && fresh instanceof HTMLInputElement) {
    fresh.value = saved.value;
    if (saved.start !== null && saved.end !== null) fresh.setSelectionRange(saved.start, saved.end);
  }
}
