// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseThemeCSS } from "../theme/theme";
import { renderTree, replaceKeepingFocus } from "./render";
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
      { type: "Box", children: [{ type: "Svg", props: { width: 3 } }, "après"] },
      { onUnsupported, openTerminal },
    );
    const block = root.querySelector(".den-mod-unsupported");
    expect(block?.textContent).toContain("Ce mod utilise un element que Den ne sait pas afficher : Svg");
    expect(onUnsupported).toHaveBeenCalledWith("Svg");
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
