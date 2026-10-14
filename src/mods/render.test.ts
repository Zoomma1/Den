// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseThemeCSS } from "../theme/theme";
const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { pressHotkey, renderTree, replaceKeepingFocus } from "./render";
import { isRenderNode, type RenderNode } from "./tree";

function fixtureTree(file: string, id: string): RenderNode {
  const lines = readFileSync(`src/mods/fixtures/${file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const tree = lines.find((l) => l.response.request_id === id).response.response.tree;
  expect(isRenderNode(tree)).toBe(true);
  return tree;
}

describe("renderTree", () => {
  beforeEach(() => invokeMock.mockClear());

  it("rend le badge RISQUE en rouge via le token ANSI, sans HTML parasite", () => {
    const root = renderTree(fixtureTree("responses-render.ndjson", "den-ui-assistant"));
    expect(root.className).toBe("den-mod-tree");
    const risque = [...root.querySelectorAll<HTMLElement>(".den-mod-text")].find(
      (s) => s.textContent === " · RISQUE",
    );
    expect(risque?.style.color).toBe("var(--den-ansi-red)");
    expect(risque?.style.fontWeight).toBe("700");
    expect(root.querySelectorAll(".den-mod-markdown")).toHaveLength(2);
    expect(root.textContent).toContain("Le push est irréversible");
  });

  it("rend le pane handoff et route clic, saisie et Entrée", () => {
    const onPress = vi.fn();
    const onInput = vi.fn();
    const root = renderTree(fixtureTree("responses-pane-handoff.ndjson", "den-ui-pane"), {
      onPress,
      onInput,
    });
    expect(root.textContent).toContain("Le contexte est à 2%");

    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button.den-mod-btn")];
    const copier = buttons.find((b) => b.dataset.variant === "primary");
    const later = buttons.find((b) => b.dataset.role === "dismiss");
    copier?.click();
    expect(onPress).toHaveBeenCalledWith({ plugin: "handoff-copy", handle: 313517864 }, "copy");
    later?.click();
    expect(onPress).toHaveBeenLastCalledWith({ plugin: "handoff-copy", handle: 313517865 }, "later");

    const input = root.querySelector("input") as HTMLInputElement;
    const press = { plugin: "handoff-copy", handle: 313517863 };
    input.value = "mon focus";
    input.dispatchEvent(new Event("input"));
    expect(onInput).toHaveBeenLastCalledWith(press, "change", "mon focus", "focus");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onInput).toHaveBeenLastCalledWith(press, "submit", "mon focus", "focus");

    const submitBtn = buttons.find((b) => b.textContent === "copier");
    submitBtn?.click();
    expect(onInput).toHaveBeenCalledTimes(3);
  });

  it("route la sélection d'un Select", () => {
    const onSelect = vi.fn();
    const press = { plugin: "p", handle: 1 };
    const root = renderTree(
      {
        type: "Select",
        props: { key: "k", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], value: "a" },
        press,
      },
      { onSelect },
    );
    const select = root.querySelector("select") as HTMLSelectElement;
    select.value = "b";
    select.dispatchEvent(new Event("change"));
    expect(onSelect).toHaveBeenCalledWith(press, "b", "k");
  });

  it("délègue le noeud engine ou rend un fragment vide", () => {
    const tree: RenderNode = { type: "engine", ref: 0 };
    expect(renderTree(tree).childNodes).toHaveLength(0);
    const original = document.createElement("em");
    const renderEngineDefault = vi.fn(() => original);
    const root = renderTree(tree, { renderEngineDefault });
    expect(renderEngineDefault).toHaveBeenCalledWith(0);
    expect(root.firstChild).toBe(original);
  });

  it("affiche un bloc d'erreur sur un element non supporté sans lancer", () => {
    const onUnsupported = vi.fn();
    const openTerminal = vi.fn();
    const root = renderTree(
      { type: "Box", children: [{ type: "Raster", props: { width: 3 } }, "après"] },
      { onUnsupported, openTerminal },
    );
    const block = root.querySelector(".den-mod-unsupported");
    expect(block?.textContent).toContain("Ce mod utilise un element que Den ne sait pas afficher : Raster");
    expect(onUnsupported).toHaveBeenCalledWith("Raster");
    expect(root.textContent).toContain("après");
    (block?.querySelector("button") as HTMLButtonElement).click();
    expect(openTerminal).toHaveBeenCalled();
  });

  it("ne navigue jamais sur un Link et relaie press avec href", () => {
    const onPress = vi.fn();
    const press = { plugin: "p", handle: 2 };
    const root = renderTree({ type: "Link", props: { href: "https://x.test", label: "x" }, press }, { onPress });
    const a = root.querySelector("a") as HTMLAnchorElement;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onPress).toHaveBeenCalledWith(press, undefined, "https://x.test");
  });

  it("ouvre dans le navigateur un Link sans press, jamais dans la WebView", () => {
    const root = renderTree({ type: "Link", props: { href: "https://x.test/p", label: "x" } });
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("a")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://x.test/p" });
  });

  it("n'ouvre pas un Link dont le schéma n'est pas http(s)/mailto, ni quand press existe", () => {
    const bad = renderTree({ type: "Link", props: { href: "javascript:alert(1)", label: "x" } });
    bad.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const pressed = renderTree({ type: "Link", props: { href: "https://x.test", label: "x" }, press: { plugin: "p", handle: 1 } }, { onPress: vi.fn() });
    pressed.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("ouvre dans le navigateur un lien d'un Markdown de mod sans press", () => {
    const root = renderTree({ type: "Markdown", props: { text: "[doc](https://example.com/d)" } });
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    root.querySelector("a")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://example.com/d" });
  });

  it("n'injecte aucune balise depuis un texte, un Code ou un Markdown", () => {
    const evil = '<img src=x onerror="alert(1)"><script>1</script>';
    const root = renderTree({
      type: "Box",
      children: [evil, { type: "Text", children: [evil] }, { type: "Code", children: [evil] }, { type: "Markdown", props: { text: evil } }],
    });
    expect(root.querySelector("img, script")).toBeNull();
    expect(root.textContent).toContain(evil);
  });

  it("applique styles de Box/Text, ignore les props inconnues, direction row par défaut", () => {
    const root = renderTree({
      type: "Box",
      props: { gap: 2, paddingX: 1, mystery: true },
      children: [{ type: "Text", props: { italic: true, underline: true, strikethrough: true, color: "#ff0000", backgroundColor: "blueBright", dimColor: true } }],
    });
    const box = root.querySelector(".den-mod-box") as HTMLElement;
    expect(box.style.flexDirection).toBe("row");
    expect(box.style.gap).toBe("2ch");
    expect(box.style.paddingLeft).toBe("1ch");
    const t = root.querySelector(".den-mod-text") as HTMLElement;
    expect(t.style.fontStyle).toBe("italic");
    expect(t.style.textDecoration).toContain("line-through");
    expect(t.style.color).toBe("#ff0000");
    expect(t.style.backgroundColor).toBe("var(--den-ansi-bright-blue)");
  });
});

describe("tokens --den-ansi-*", () => {
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray"].concat(
    ["red", "green", "yellow", "blue", "magenta", "cyan", "white"].map((n) => `bright-${n}`),
  );
  for (const file of ["default", "light"]) {
    it(`passent le parseur de thème (${file})`, () => {
      const vars = parseThemeCSS(readFileSync(`themes/${file}.css`, "utf8"));
      expect(vars).not.toBeNull();
      for (const n of names) expect(vars?.[`--den-ansi-${n}`]).toBeTruthy();
    });
  }
});

describe("replaceKeepingFocus", () => {
  const field = (value: string): RenderNode => ({
    type: "Input",
    props: { key: "focus", value },
    press: { plugin: "p", handle: 1 },
  });

  it("garde le focus, la saisie locale et le caret d'un champ recréé par un re-rendu", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.appendChild(renderTree(field("")));
    const input = container.querySelector("input") as HTMLInputElement;
    input.focus();
    input.value = "abcd";
    input.setSelectionRange(2, 2);

    // Re-rendu avec une valeur moteur périmée : la saisie en cours ne doit pas être écrasée.
    replaceKeepingFocus(container, renderTree(field("ab")));

    const fresh = container.querySelector("input") as HTMLInputElement;
    expect(fresh).not.toBe(input);
    expect(document.activeElement).toBe(fresh);
    expect(fresh.value).toBe("abcd");
    expect([fresh.selectionStart, fresh.selectionEnd]).toEqual([2, 2]);
    container.remove();
  });

  it("ne vole pas le focus quand aucun champ de mod n'était actif", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const other = document.createElement("input");
    document.body.appendChild(other);
    container.appendChild(renderTree(field("x")));
    other.focus();

    replaceKeepingFocus(container, renderTree(field("y")));

    expect(document.activeElement).toBe(other);
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("y");
    container.remove();
    other.remove();
  });
});

describe("renderTree Svg, Client et types inchangés", () => {
  describe("Svg", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';

    it("rend un <img> data: avec alt et taille, sans <svg> dans le DOM", () => {
      const root = renderTree({ type: "Svg", props: { source: svg, alt: "rond", width: 40, height: 9999 } });
      const img = root.querySelector("img") as HTMLImageElement;
      expect(img.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      expect(img.alt).toBe("rond");
      expect(img.style.width).toBe("40px");
      expect(img.style.height).toBe("4000px");
      expect(root.querySelector("svg, circle")).toBeNull();
    });

    it("garde un source avec <script> en URL de données", () => {
      const evil = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      const root = renderTree({ type: "Svg", props: { source: evil, alt: "x" } });
      expect(root.querySelector("script, svg")).toBeNull();
      expect(root.querySelector("img")?.getAttribute("src")).toContain(encodeURIComponent("<script>"));
    });

    it("isInteractive : iframe au sandbox vide, hauteur 160 par défaut", () => {
      const root = renderTree({ type: "Svg", props: { source: svg, alt: "anim", isInteractive: true } });
      const frame = root.querySelector("iframe") as HTMLIFrameElement;
      expect(frame.sandbox.length).toBe(0);
      expect(frame.getAttribute("sandbox")).toBe("");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame.title).toBe("anim");
      expect(frame.style.height).toBe("160px");
      expect(root.querySelector("svg")).toBeNull();
    });

    it("affiche « indisponible » si source trop long, absent, non string ou alt manquant", () => {
      const bad = [
        { source: "x".repeat(131073), alt: "gros" },
        { alt: "vide" },
        { source: 3, alt: "num" },
        { source: svg },
      ];
      for (const props of bad) {
        const root = renderTree({ type: "Svg", props });
        expect(root.querySelector(".den-mod-svg-error")?.textContent).toContain("Dessin indisponible");
        expect(root.querySelector("img, iframe")).toBeNull();
      }
      const withAlt = renderTree({ type: "Svg", props: { source: "x".repeat(131073), alt: "gros" } });
      expect(withAlt.textContent).toContain("gros");
      expect(renderTree({ type: "Svg" }).querySelector(".den-mod-svg-error")).not.toBeNull();
    });
  });

  describe("Client", () => {
    const node = { type: "Client", props: { key: "k", module: "m" }, client: { plugin: "p" } } as unknown as RenderNode;

    it("délègue à renderClient une fois avec le nœud", () => {
      const out = document.createElement("section");
      const renderClient = vi.fn(() => out);
      const onUnsupported = vi.fn();
      const root = renderTree(node, { renderClient, onUnsupported });
      expect(renderClient).toHaveBeenCalledTimes(1);
      expect(renderClient).toHaveBeenCalledWith(node);
      expect(root.firstChild).toBe(out);
      expect(onUnsupported).not.toHaveBeenCalled();
    });

    it("sans renderClient : repli non supporté inchangé", () => {
      const onUnsupported = vi.fn();
      const root = renderTree(node, { onUnsupported });
      expect(root.querySelector(".den-mod-unsupported")?.textContent).toContain("Client");
      expect(onUnsupported).toHaveBeenCalledWith("Client");
    });

    it("renderClient qui lève : bloc d'erreur, sans throw ni onUnsupported", () => {
      const onUnsupported = vi.fn();
      const root = renderTree(node, {
        renderClient: () => {
          throw new Error("boom");
        },
        onUnsupported,
      });
      expect(root.querySelector(".den-mod-unsupported")).not.toBeNull();
      expect(onUnsupported).not.toHaveBeenCalled();
    });
  });

  it("Image et type inconnu gardent le bloc d'erreur et le bouton terminal", () => {
    const onUnsupported = vi.fn();
    for (const type of ["Image", "Inconnu"]) {
      const root = renderTree({ type }, { onUnsupported });
      expect(root.querySelector(".den-mod-unsupported button")).not.toBeNull();
      expect(onUnsupported).toHaveBeenLastCalledWith(type);
    }
  });
});

describe("Code et Button", () => {
  const code = (props: Record<string, unknown>, children?: string[]) =>
    renderTree({ type: "Code", props, children } as RenderNode).querySelector("code")!;

  it("Code lit source en priorite, puis text, puis children", () => {
    expect(code({ source: "a", text: "b" }, ["c"]).textContent).toBe("a");
    expect(code({ text: "b" }, ["c"]).textContent).toBe("b");
    expect(code({}, ["c"]).textContent).toBe("c");
  });

  it("Code format diff -> un span type par ligne, texte intact", () => {
    const src = "@@ -1 +1 @@\n-old\n+new\n+++ b\n--- a\n ctx";
    const c = code({ source: src, format: "diff" });
    const cls = [...c.querySelectorAll("span")].map((s) => s.className);
    expect(cls).toEqual(["den-mod-code__hunk", "den-mod-code__del", "den-mod-code__add", "", "", ""]);
    expect(c.textContent).toBe(src);
  });

  it("Button pose data-hotkey en minuscule et data-autofocus", () => {
    const b = renderTree({ type: "Button", props: { label: "x", hotkey: "N", autoFocus: true } } as RenderNode).querySelector("button")!;
    expect(b.dataset.hotkey).toBe("n");
    expect(b.hasAttribute("data-autofocus")).toBe(true);
    const plain = renderTree({ type: "Button", props: { label: "x" } } as RenderNode).querySelector("button")!;
    expect(plain.dataset.hotkey).toBeUndefined();
  });
});

describe("pressHotkey — auto-repeat", () => {
  it("ne re-clique pas le bouton quand la touche est maintenue", () => {
    const container = document.createElement("div");
    const btn = document.createElement("button");
    btn.dataset.hotkey = "y";
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    container.appendChild(btn);
    document.body.appendChild(container);
    expect(pressHotkey(container, new KeyboardEvent("keydown", { key: "y", cancelable: true }))).toBe(true);
    expect(pressHotkey(container, new KeyboardEvent("keydown", { key: "y", repeat: true, cancelable: true }))).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("replaceKeepingFocus — autoFocus", () => {
  it("rend le focus au bouton [data-autofocus] qui l'avait avant le re-rendu", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const tree: RenderNode = { type: "Button", props: { label: "ok", autoFocus: true } } as RenderNode;
    container.appendChild(renderTree(tree));
    const first = container.querySelector("button")!;
    first.focus();
    expect(document.activeElement).toBe(first);
    replaceKeepingFocus(container, renderTree(tree), true);
    const fresh = container.querySelector("button")!;
    expect(fresh).not.toBe(first);
    expect(document.activeElement).toBe(fresh);
  });
});
