import "./settings.css";
import type { DenContext } from "../core/registry";
import { setPreset } from "../layout";
import { getState } from "../workspace";
import type { LayoutPreset } from "../workspace/store";
import { STATUSES, STATUS_META } from "../tabs/status";
import {
  PERMISSION_MODES,
  SETTINGS_LAYOUT_PRESETS,
  effectiveMode,
  getSettings,
  listThemes,
  load,
  openThemesDir,
  save,
  type PermissionMode,
  type Settings,
} from "./store";
import { detectMac, renderCombo, visibleShortcuts } from "./shortcuts";

export interface SettingsOverlay {
  triggerEl: HTMLButtonElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export interface SettingsDeps {
  getSettings(): Settings;
  save(patch: Settings): Promise<void>;
  listThemes(): Promise<string[]>;
  openThemesDir(): Promise<void>;
  getPreset(): LayoutPreset;
  setPreset(preset: LayoutPreset): void;
  isMac: boolean;
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default (ask)",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
};
const PRESET_LABEL: Record<LayoutPreset, string> = {
  "side-by-side": "Side by side",
  stacked: "Stacked",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Icône SVG plutôt qu'un glyphe de police : centrage exact, indépendant des métriques de la police. */
function cogIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const hub = document.createElementNS(SVG_NS, "circle");
  hub.setAttribute("cx", "12");
  hub.setAttribute("cy", "12");
  hub.setAttribute("r", "3");
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute(
    "d",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z",
  );
  svg.append(hub, body);
  return svg;
}

function field(label: string, control: HTMLSelectElement, note?: string): HTMLElement {
  const row = el("label", "den-settings-field");
  row.append(el("span", "den-settings-field__label", label), control);
  if (note) row.append(el("span", "den-settings-field__note", note));
  return row;
}

function makeSelect(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el("select", "den-settings-select");
  for (const [v, text] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    select.append(o);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

export function createSettingsOverlay(host: HTMLElement, deps: SettingsDeps): SettingsOverlay {
  const triggerEl = el("button", "den-settings-trigger den-root-bar__settings");
  triggerEl.type = "button";
  triggerEl.append(cogIcon());
  triggerEl.setAttribute("aria-label", "Settings");
  triggerEl.title = "Settings";

  const backdrop = el("div", "den-settings-backdrop");
  backdrop.hidden = true;
  const dialog = el("div", "den-settings-overlay");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Settings");
  dialog.tabIndex = -1;
  backdrop.append(dialog);
  host.append(backdrop);

  let opened = false;
  let previousFocus: HTMLElement | null = null;

  function section(title: string): HTMLElement {
    const s = el("section", "den-settings-section");
    s.append(el("h3", "den-settings-section__title", title));
    return s;
  }

  function persist(patch: Settings): void {
    deps.save(patch).catch((err: unknown) => console.warn("den: settings_write a échoué.", err));
  }

  function build(themes: string[]): void {
    const settings = deps.getSettings();

    const session = section("Session");
    session.append(
      field(
        "Default permission mode",
        makeSelect(
          PERMISSION_MODES.map((m) => [m, MODE_LABEL[m]]),
          effectiveMode(settings),
          (v) => persist({ defaultPermissionMode: v as PermissionMode }),
        ),
        "Applies to new sessions",
      ),
    );

    const display = section("Display");
    display.append(
      field(
        "Layout",
        makeSelect(
          SETTINGS_LAYOUT_PRESETS.map((p) => [p, PRESET_LABEL[p]]),
          deps.getPreset(),
          (v) => {
            deps.setPreset(v as LayoutPreset);
            persist({ layoutPreset: v as LayoutPreset });
          },
        ),
      ),
    );
    const themeOptions: [string, string][] = themes.map((t) => [t, t]);
    // Sans thème dans settings.json, Rust retombe sur .config puis "default" : on affiche "default".
    const activeTheme = settings.theme ?? "default";
    if (!themes.includes(activeTheme)) themeOptions.unshift([activeTheme, activeTheme]);
    display.append(
      field(
        "Theme",
        makeSelect(themeOptions, activeTheme, (v) => {
          if (v) persist({ theme: v });
        }),
        "Edit a theme's .css in the folder; changes apply live",
      ),
    );
    const openFolder = el("button", "den-settings-open-themes", "Open themes folder");
    openFolder.type = "button";
    openFolder.addEventListener("click", () => {
      deps.openThemesDir().catch((err: unknown) => console.warn("den: theme_open_dir a échoué.", err));
    });
    const refreshThemes = el("button", "den-settings-open-themes", "Refresh themes");
    refreshThemes.type = "button";
    refreshThemes.addEventListener("click", () => {
      deps
        .listThemes()
        .then((fresh) => {
          if (opened) build(fresh);
        })
        .catch((err: unknown) => console.warn("den: theme_list a échoué.", err));
    });
    const actions = el("div", "den-settings-actions");
    actions.append(openFolder, refreshThemes);
    display.append(actions);

    const help = section("Help");
    const keys = el("dl", "den-settings-shortcuts");
    for (const s of visibleShortcuts(deps.isMac)) {
      keys.append(el("dt", "den-settings-shortcuts__combo", renderCombo(s.combo, deps.isMac)), el("dd", "", s.label));
    }
    const legend = el("ul", "den-settings-legend");
    for (const status of STATUSES) {
      const meta = STATUS_META[status];
      const item = el("li", "den-settings-legend__item");
      const dot = el("span", "den-settings-legend__dot");
      dot.style.background = `var(${meta.token})`;
      item.append(dot, el("span", "", meta.label));
      legend.append(item);
    }
    help.append(keys, legend);

    const closeBtn = el("button", "den-settings-close", "Close");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", closeOverlay);
    dialog.replaceChildren(el("h2", "den-settings-title", "Settings"), session, display, help, closeBtn);
  }

  function open(): void {
    if (opened) return;
    opened = true;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    build([]);
    backdrop.hidden = false;
    dialog.focus();
    // La liste de thèmes arrive en asynchrone : on reconstruit si l'overlay est toujours ouvert.
    deps
      .listThemes()
      .then((themes) => {
        if (opened) build(themes);
      })
      .catch((err: unknown) => console.warn("den: theme_list a échoué.", err));
  }

  function closeOverlay(): void {
    if (!opened) return;
    opened = false;
    backdrop.hidden = true;
    previousFocus?.focus();
    previousFocus = null;
  }

  triggerEl.addEventListener("click", () => (opened ? closeOverlay() : open()));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeOverlay();
  });
  document.addEventListener("keydown", (e) => {
    if (opened && e.key === "Escape") {
      e.preventDefault();
      closeOverlay();
    }
  });
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = deps.isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.key !== ",") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (opened) closeOverlay();
      else open();
    },
    { capture: true },
  );

  return { triggerEl, open, close: closeOverlay, toggle: () => (opened ? closeOverlay() : open()), isOpen: () => opened };
}

let overlay: SettingsOverlay | null = null;

/** Lu par `tabs` (init après settings) pour monter le bouton à côté de Sessions / Agents. */
export function getSettingsOverlay(): SettingsOverlay | null {
  return overlay;
}

export async function init(_ctx: DenContext): Promise<void> {
  try {
    await load();
  } catch (err) {
    console.warn("den: settings_read a échoué, réglages par défaut conservés.", err);
  }
  overlay = createSettingsOverlay(document.body, {
    getSettings,
    save,
    listThemes,
    openThemesDir,
    getPreset: () => getState().layout.preset,
    setPreset,
    isMac: detectMac(),
  });
}
