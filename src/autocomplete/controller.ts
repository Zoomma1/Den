import "./autocomplete.css";
import {
  applySelection,
  filterCommands,
  findSlashToken,
  highlightSegments,
  type SlashCommandInfo,
  type SlashToken,
} from "./slash";

export function attachSlashAutocomplete(
  textarea: HTMLTextAreaElement,
  getCommands: () => SlashCommandInfo[],
): { rootEl: HTMLElement; isOpen(): boolean; refresh(): void } {
  const rootEl = document.createElement("div");
  rootEl.className = "den-prompt-bar__field";

  const backdrop = document.createElement("div");
  backdrop.className = "den-prompt-bar__backdrop";
  backdrop.setAttribute("aria-hidden", "true");

  const menu = document.createElement("div");
  menu.className = "den-slash-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  // Sans ça, saisir la scrollbar du menu fait perdre le focus à la textarea (blur => menu fermé).
  menu.addEventListener("mousedown", (e) => e.preventDefault());

  textarea.parentElement?.removeChild(textarea);
  rootEl.append(backdrop, textarea, menu);

  let items: SlashCommandInfo[] = [];
  let token: SlashToken | null = null;
  let active = 0;
  let open = false;
  // Après Échap, seule une frappe qui modifie le texte rouvre le menu.
  let dismissed = false;

  function renderBackdrop(): void {
    const known = new Set(getCommands().map((c) => c.name));
    backdrop.textContent = "";
    for (const seg of highlightSegments(textarea.value, known)) {
      if (seg.highlighted) {
        const span = document.createElement("span");
        span.className = "den-slash-token";
        span.textContent = seg.text;
        backdrop.append(span);
      } else {
        backdrop.append(document.createTextNode(seg.text));
      }
    }
    // Sans caractère final, une dernière ligne vide perd sa hauteur.
    backdrop.append(document.createTextNode("\n"));
    backdrop.scrollTop = textarea.scrollTop;
  }

  function close(): void {
    open = false;
    menu.hidden = true;
    menu.textContent = "";
    items = [];
    token = null;
  }

  function renderMenu(): void {
    menu.textContent = "";
    items.forEach((cmd, i) => {
      const row = document.createElement("div");
      row.className = "den-slash-menu__item";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === active ? "true" : "false");
      const name = document.createElement("span");
      name.className = "den-slash-menu__name";
      name.textContent = `/${cmd.name}`;
      const desc = document.createElement("span");
      desc.className = "den-slash-menu__desc";
      desc.textContent = cmd.description;
      row.append(name, desc);
      // preventDefault garde le focus sur la textarea : sans lui le blur fermerait le menu avant la sélection.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        select(i);
      });
      menu.append(row);
    });
    menu.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function updateMenu(): void {
    if (dismissed) return;
    // Sans focus le blur ne partira plus : un menu ouvert resterait bloqué.
    if (document.activeElement !== textarea) {
      close();
      return;
    }
    const tok = findSlashToken(textarea.value, textarea.selectionStart);
    const list = tok ? filterCommands(getCommands(), tok.query) : [];
    if (!tok || list.length === 0) {
      close();
      return;
    }
    const sameList =
      open && list.length === items.length && list.every((c, i) => c.name === items[i].name);
    items = list;
    token = tok;
    if (!sameList) active = 0;
    open = true;
    menu.hidden = false;
    renderMenu();
  }

  function select(index: number): void {
    const cmd = items[index];
    if (!cmd || !token) return;
    const before = textarea.value;
    const res = applySelection(before, token, cmd.name);
    const inserted = res.text.slice(
      token.start,
      token.start + res.text.length - before.length + (token.end - token.start),
    );
    // setRangeText plutôt que .value : garde une chance à l'undo natif.
    textarea.setRangeText(inserted, token.start, token.end, "end");
    textarea.setSelectionRange(res.caret, res.caret);
    close();
    renderBackdrop();
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setActive(next: number): void {
    active = (next + items.length) % items.length;
    renderMenu();
  }

  function sync(): void {
    renderBackdrop();
    updateMenu();
  }

  textarea.addEventListener("input", () => {
    dismissed = false;
    sync();
  });
  textarea.addEventListener("click", updateMenu);
  textarea.addEventListener("keyup", (e) => {
    // Déjà traitées au keydown (ou sans effet sur le caret) : les rejouer rouvrirait le menu fermé par Échap.
    if (
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "Escape" ||
      e.key === "Shift" ||
      e.key === "Control" ||
      e.key === "Alt" ||
      e.key === "Meta"
    ) {
      return;
    }
    updateMenu();
  });
  textarea.addEventListener("blur", close);
  textarea.addEventListener("scroll", () => {
    backdrop.scrollTop = textarea.scrollTop;
  });

  textarea.addEventListener("keydown", (e) => {
    if (!open || e.isComposing || e.keyCode === 229) return;
    const swallow = (): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (e.key === "ArrowDown") {
      swallow();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      swallow();
      setActive(active - 1);
    } else if (
      (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) ||
      (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey)
    ) {
      swallow();
      select(active);
    } else if (e.key === "Escape") {
      swallow();
      dismissed = true;
      close();
    }
  });

  renderBackdrop();

  return {
    rootEl,
    isOpen: () => open,
    refresh: sync,
  };
}
