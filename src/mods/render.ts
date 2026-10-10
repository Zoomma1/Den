import { createMarkdownEngine } from "../markdown/renderer";
import type { RenderOptions, RenderTreeFn } from "./contracts";
import { isSupportedElement, type ElementNode, type RenderNode } from "./tree";

// Le moteur Marked échappe déjà le HTML brut (cf. createMarkdownEngine).
const md = createMarkdownEngine(false);

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Nom ANSI du moteur (red, redBright, gray, ansi:red) -> token --den-ansi-*, sinon #hex/rgb() tel quel. */
function resolveColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().replace(/^ansi:/, "");
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

function applyBoxStyle(el: HTMLElement, p: Record<string, unknown>): void {
  const dir = typeof p.flexDirection === "string" ? p.flexDirection : "row";
  el.style.flexDirection = dir;
  setStyle(el, "gap", cells(p.gap, dir.startsWith("column") ? "em" : "ch"));
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
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function textOf(children: RenderNode[] | undefined): string {
  return (children ?? [])
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
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

function build(node: RenderNode, opts: RenderOptions): Node {
  if (typeof node === "string" || typeof node === "number") {
    return document.createTextNode(String(node));
  }
  if (node.type === "engine") {
    const ref = (node as { ref: number }).ref;
    return opts.renderEngineDefault?.(ref) ?? document.createDocumentFragment();
  }
  const el = node as ElementNode;
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
        if (el.press) opts.onPress?.(el.press, key, a.getAttribute("href") ?? undefined);
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
      });
      return a;
    }
    case "Code": {
      const pre = document.createElement("pre");
      pre.className = "den-mod-code";
      const code = document.createElement("code");
      code.textContent = str(p.text) || textOf(el.children);
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

/** Remplace le contenu d'un conteneur en gardant le focus, le caret et la saisie en cours d'un champ de mod : sans ça, chaque invalidation (une par frappe) recrée l'<input> et fait perdre le focus. */
export function replaceKeepingFocus(container: HTMLElement, next: Node): void {
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

  container.replaceChildren(next);
  if (key === undefined) return;

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
